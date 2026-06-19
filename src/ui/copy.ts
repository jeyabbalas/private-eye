/**
 * Private Eye flavor — minimal, tasteful detective copy so the app never feels
 * frozen while it's working. One short line per stage; the long "analyzing"
 * phase rotates a few so a slow page still shows life. Used sparingly.
 */
import type { DeepPhaseKind, StageKey } from '../workers/protocol.ts';

const ANALYZING = [
  'Examining the evidence…',
  'Reading the fine print…',
  'Following the paper trail…',
  'Dusting for details…',
  'Piecing it together…',
];

export const WARMING = 'Polishing the magnifying glass…';
export const CASE_CLOSED = 'Case closed.';

export function stageMessage(stage: StageKey, tick = 0): string {
  switch (stage) {
    case 'loading':
      return WARMING;
    case 'decoding':
      return 'Examining the evidence…';
    case 'analyzing':
      return ANALYZING[tick % ANALYZING.length]!;
    case 'finishing':
      return 'Closing the case…';
  }
}

/** Shown while the Deep Read model downloads/loads (the one-time ~1.4 GB fetch). */
export const SPECIALIST = 'Calling in the specialist…';

/** Plain detective copy for a Deep Read phase. `index`/`total` label the
 *  per-region cross-examination so a long decode never looks frozen. */
export function deepPhaseMessage(phase: DeepPhaseKind, index?: number, total?: number): string {
  switch (phase) {
    case 'preparing':
      return 'Briefing the specialist…';
    case 'examining':
      return 'Examining the evidence…';
    case 'cross-examining':
      return index && total ? `Cross-examining region ${index} of ${total}…` : 'Cross-examining the details…';
    case 'verifying':
      return 'Checking the figures…';
    case 'fallback':
      return 'That lead didn’t hold up — going with the exact transcription…';
    case 'finishing':
      return 'Closing the case…';
  }
}
