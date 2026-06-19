/**
 * Runtime loader for the PP-OCR confidence calibration artifact produced by
 * scripts/calibrate-uncertainty.ts. Maps raw CTC max-softmax → calibrated
 * P(correct) via an isotonic (piecewise-linear) map, char-class-aware (digits use
 * a separate map — numeric error structure differs and digits are safety-critical).
 *
 * Honest default: if the artifact is absent (the harness has not run, or the
 * signal was DROPPED by the gate), `loadCalibration` returns the identity
 * calibrator and the uncertainty layer reports `calibration: 'identity'` — raw
 * values are never presented as if calibrated.
 */
import type { RuntimeContext } from '../../adapters/types.ts';
import type { CalibrateFn } from '../../core/stats.ts';

export interface IsotonicPoint {
  x: number; // raw confidence
  y: number; // calibrated P(correct)
}

export interface CalibSignal {
  aggregation?: string;
  isotonic: IsotonicPoint[];
  /** Optional digit-specific map; falls back to `isotonic` when absent. */
  isotonicDigit?: IsotonicPoint[];
}

export interface CalibrationArtifact {
  schema: 'uncertainty-calib/1';
  fittedOn?: string[];
  signals: Record<string, CalibSignal>;
}

export interface Calibrator {
  mode: 'isotonic' | 'identity';
  calibrate: CalibrateFn;
}

export const identityCalibrator: Calibrator = { mode: 'identity', calibrate: (p) => p };

const CALIB_URL = 'ppocr/calibration.json';

const isDigit = (ch: string): boolean => ch.length === 1 && ch >= '0' && ch <= '9';

/** Piecewise-linear interpolation over sorted breakpoints; clamps outside the range.
 *  Exported so the calibration harness (src/eval/uncertainty.ts) measures
 *  post-isotonic ECE with the exact map the runtime applies — the report can't
 *  drift from what ships. */
export function interpIsotonic(points: IsotonicPoint[], x: number): number {
  if (!points.length) return x;
  if (x <= points[0]!.x) return points[0]!.y;
  const lastP = points[points.length - 1]!;
  if (x >= lastP.x) return lastP.y;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (x <= b.x) {
      const a = points[i - 1]!;
      const t = (x - a.x) / (b.x - a.x || 1);
      return a.y + (b.y - a.y) * t;
    }
  }
  return lastP.y;
}

/** Build a calibrator from the artifact (or identity when the OCR signal is absent). */
export function makeCalibrator(art: CalibrationArtifact): Calibrator {
  const sig = art.signals?.ppocrCharConf;
  if (!sig || !sig.isotonic?.length) return identityCalibrator;
  const overall = sig.isotonic;
  const digit = sig.isotonicDigit?.length ? sig.isotonicDigit : overall;
  return {
    mode: 'isotonic',
    calibrate: (p, ch) => Math.max(0, Math.min(1, interpIsotonic(isDigit(ch) ? digit : overall, p))),
  };
}

export async function loadCalibration(ctx: RuntimeContext): Promise<Calibrator> {
  try {
    const bytes = await ctx.readBytes(ctx.assetUrl(CALIB_URL));
    return makeCalibrator(JSON.parse(new TextDecoder().decode(bytes)) as CalibrationArtifact);
  } catch {
    return identityCalibrator;
  }
}
