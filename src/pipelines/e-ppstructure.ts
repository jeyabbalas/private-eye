/**
 * Pipeline E ("ppstructure"): PP-DocLayoutV3 layout (regions + learned reading
 * order) → PP-OCRv6 det+rec (full page, identical to Pipeline B) → SLANet_plus
 * for confirmed table regions → thin region assembly → Markdown.
 *
 * Zero generative components: every emitted token is an OCR token, so B's
 * no-fabrication-by-construction safety class is preserved.
 */
import { PpocrEngine, PPOCR_DEFAULTS, detModelSpec, recModelSpec, type PpocrOptions, type PpocrTier } from '../engines/ppocr/index.ts';
import { loadCalibration, identityCalibrator, type Calibrator } from '../engines/ppocr/calibration.ts';
import { LayoutEngine, LAYOUT_MODEL_SPEC } from '../engines/layout/index.ts';
import { SlanetEngine, SLANET_MODEL_SPEC } from '../engines/slanet/index.ts';
import { buildDocModelFromRegions, buildRegionUncertainty, type Region, type TableCells } from '../structure/region-assemble.ts';
import { renderMarkdown } from '../structure/blocks.ts';
import { verifyPage } from '../structure/verify.ts';
import { warpQuad } from '../core/imageops.ts';
import type { Quad, RasterImage } from '../core/types.ts';
import type { ModelSpec, RuntimeContext } from '../adapters/types.ts';
import type { PageInput, PipelineAdapter } from './types.ts';

export interface PpstructureOptions extends PpocrOptions {
  /** Reading order: layout model's learned head vs column-aware geometric. */
  order: 'learned' | 'geometric';
  /** Table structure: SLANet_plus vs Pipeline B's heuristic buildTable. */
  table: 'slanet' | 'heuristic';
  /** Layout region score threshold (reference default 0.5). */
  layoutThresh: number;
}

export const PPSTRUCTURE_DEFAULTS: PpstructureOptions = {
  ...PPOCR_DEFAULTS,
  order: 'learned',
  table: 'slanet',
  layoutThresh: 0.5,
};

const isTier = (s: string | undefined): s is PpocrTier => s === 'tiny' || s === 'small' || s === 'medium';

export function createPpstructurePipeline(options: Record<string, string> = {}): PipelineAdapter {
  const opts: PpstructureOptions = {
    ...PPSTRUCTURE_DEFAULTS,
    ...(isTier(options.tier) ? { tier: options.tier } : {}),
    ...(options.detLimit ? { detLimit: Number(options.detLimit) } : {}),
    ...(options.dropScore ? { dropScore: Number(options.dropScore) } : {}),
    ...(options.geomDeflateY ? { geomDeflateY: Number(options.geomDeflateY) } : {}),
    ...(options.order === 'geometric' ? { order: 'geometric' as const } : {}),
    ...(options.table === 'heuristic' ? { table: 'heuristic' as const } : {}),
    ...(options.layoutThresh ? { layoutThresh: Number(options.layoutThresh) } : {}),
  };
  const layout = new LayoutEngine();
  const ocrEngine = new PpocrEngine();
  const slanet = opts.table === 'slanet' ? new SlanetEngine() : undefined;
  let calibrator: Calibrator = identityCalibrator;
  const models: ModelSpec[] = [
    LAYOUT_MODEL_SPEC,
    detModelSpec(opts.tier),
    recModelSpec(opts.tier),
    ...(slanet ? [SLANET_MODEL_SPEC] : []),
  ];

  return {
    id: 'ppstructure',
    variant: `${opts.tier}@${opts.detLimit}+${opts.table}+${opts.order}`,
    models,

    async init(ctx: RuntimeContext) {
      const t0 = ctx.now();
      // ORT-web shares ONE wasm runtime across its 'wasm' and 'webgpu' EPs, and
      // bootstrapping it from both EPs at once throws "multiple calls to
      // initWasm()". The browser app pins SLANet to the wasm EP (its SLAHead
      // decoder is an ONNX `Loop`, which ORT-web 1.26's WebGPU EP has no kernel
      // for) while layout/det/rec run on webgpu — a mixed-EP context. So bring
      // the (possibly webgpu) layout+OCR engines up first, then init the
      // wasm-pinned SLANet: by then the shared runtime is live and SLANet's wasm
      // session just reuses it. All-wasm and all-webgpu configs are unaffected
      // (same-EP concurrent init is internally serialized), and on node every
      // engine is CPU so ordering is immaterial.
      await Promise.all([
        layout.init(ctx, { layoutThresh: opts.layoutThresh }),
        ocrEngine.init(ctx, opts),
      ]);
      await slanet?.init(ctx);
      // Confidence calibration map (identity until scripts/calibrate-uncertainty.ts ships one).
      calibrator = await loadCalibration(ctx);
      let downloadBytes = 0;
      for (const m of models) {
        downloadBytes += await ctx.assetSize(m.url).catch(() => 0);
        for (const ext of m.externalData ?? []) downloadBytes += await ctx.assetSize(ext).catch(() => 0);
      }
      return { initMs: ctx.now() - t0, downloadBytes };
    },

    async runPage(input: PageInput, ctx: RuntimeContext) {
      const t0 = ctx.now();
      const { result: layoutRes, layoutMs } = await layout.run(input.image);
      const { result: ocr, detMs, recMs } = await ocrEngine.run(input.image);
      const tStruct = ctx.now();

      let tableMs = 0;
      const runSlanet = slanet
        ? async (region: Region): Promise<TableCells | null> => {
            try {
              const { structure, ms } = await recognizeTable(slanet, input.image, region);
              tableMs += ms;
              return structure;
            } catch {
              return null; // per-region fallback to the heuristic builder
            }
          }
        : undefined;

      const doc = await buildDocModelFromRegions(ocr, layoutRes.regions, { order: opts.order }, runSlanet);
      const markdown = renderMarkdown(doc);
      const uncertainty = buildRegionUncertainty(ocr, layoutRes.regions, doc, calibrator.calibrate, calibrator.mode);
      // V: E only emits OCR tokens, so fabrication is ~empty by construction — a
      // non-empty result is an assembly-bug tripwire; omission complements the
      // layout-level coverage gaps at token granularity.
      const tVerify = ctx.now();
      const verification = verifyPage({ doc, ocr, uncertainty });
      const tEnd = ctx.now();
      return {
        markdown,
        totalMs: tEnd - t0,
        stageMs: {
          layout: layoutMs,
          det: detMs,
          rec: recMs,
          table: tableMs,
          structure: tVerify - tStruct - tableMs,
          verify: tEnd - tVerify,
        },
        uncertainty,
        verification,
        ...(verification.verdict !== 'pass' ? { note: verification.summary } : {}),
        debug: { layout: layoutRes, ocr, doc },
      };
    },

    async dispose() {
      await Promise.all([layout.dispose(), ocrEngine.dispose(), slanet?.dispose()]);
    },
  };
}

/** Crop the table region, run SLANet, and map cell boxes to PAGE coordinates. */
export async function recognizeTable(
  slanet: SlanetEngine,
  image: RasterImage,
  region: Region,
): Promise<{ structure: TableCells; ms: number }> {
  const b = region.box;
  const w = Math.max(1, Math.round(b.x1 - b.x0));
  const h = Math.max(1, Math.round(b.y1 - b.y0));
  const rect: Quad = [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x1, b.y1],
    [b.x0, b.y1],
  ];
  const crop = warpQuad(image, rect, w, h);
  const { result, tableMs } = await slanet.run(crop);
  const sx = (b.x1 - b.x0) / w;
  const sy = (b.y1 - b.y0) / h;
  return {
    ms: tableMs,
    structure: {
      nRows: result.nRows,
      nCols: result.nCols,
      theadRows: result.theadRows,
      cells: result.cells.map((c) => ({
        row: c.row,
        col: c.col,
        rowSpan: c.rowSpan,
        colSpan: c.colSpan,
        inThead: c.inThead,
        box: {
          x0: b.x0 + c.box.x0 * sx,
          y0: b.y0 + c.box.y0 * sy,
          x1: b.x0 + c.box.x1 * sx,
          y1: b.y0 + c.box.y1 * sy,
        },
      })),
    },
  };
}
