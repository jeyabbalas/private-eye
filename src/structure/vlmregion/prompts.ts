/**
 * Pipeline G decode rails, TS side: per-region prompts, token budgets, and
 * post-hoc loop containment, shared by the wllama browser probe
 * (the eval harness VLM probe) and any future shipped VLM runtime.
 *
 * Kept in sync BY HAND with bakeoff/lib/rails.py + bakeoff/adapters/llamacpp.py
 * (Python side). Everything here is promptRev-relevant: changing a prompt, cap,
 * or budget formula invalidates replay comparability across runtimes, so the
 * promptRev strings ('glm-g1', 'paddle-g1') must be bumped in BOTH languages
 * together. Parity is pinned by tests/unit/structure/vlmregion-prompts.test.ts
 * against vectors generated from the Python implementation
 * (tests/unit/structure/rails-vectors.json).
 */

export type VlmTask = 'text' | 'table' | 'formula' | 'page';

export interface VlmPromptConfig {
  modelId: string;
  promptRev: string;
  /** Official per-task prompts, verbatim from the model vendors. */
  prompts: { text: string; table: string; formula: string };
}

/** Mirror of bakeoff/adapters/llamacpp.py CONFIGS (keyed by model-dir prefix). */
export const VLM_PROMPT_CONFIGS: Record<string, VlmPromptConfig> = {
  'glm-ocr': {
    modelId: 'ggml-org/GLM-OCR-GGUF',
    promptRev: 'glm-g1',
    prompts: {
      text: 'Text Recognition:',
      table: 'Table Recognition:',
      formula: 'Formula Recognition:',
    },
  },
  'paddleocr-vl': {
    modelId: 'PaddlePaddle/PaddleOCR-VL-1.6-GGUF',
    promptRev: 'paddle-g1',
    prompts: {
      text: 'OCR:',
      table: 'Table Recognition:',
      formula: 'Formula Recognition:',
    },
  },
};

/** Config for a model dir name like 'glm-ocr-q8' (prefix match, llamacpp.py rule). */
export function vlmPromptConfig(name: string): VlmPromptConfig {
  for (const [base, cfg] of Object.entries(VLM_PROMPT_CONFIGS)) {
    if (name === base || name.startsWith(`${base}-`)) return cfg;
  }
  throw new Error(`${name}: no VLM prompt config for this prefix (known: ${Object.keys(VLM_PROMPT_CONFIGS).join(', ')})`);
}

/** Mirror of rails.TASKS + task_of(). */
const TASKS: Record<string, VlmTask> = { table: 'table', formula: 'formula', formula_number: 'formula' };

export function taskOf(label: string): VlmTask {
  const t = TASKS[label];
  if (t) return t;
  if (label.startsWith('formula')) return 'formula';
  return 'text';
}

/** llamacpp.py decode_region prompt selection: task prompt, else text. */
export function promptFor(cfg: VlmPromptConfig, label: string): string {
  const task = taskOf(label);
  return task === 'page' ? cfg.prompts.text : cfg.prompts[task];
}

/** Mirror of rails.CAPS. */
export const CAPS: Record<string, number> = {
  table: 2048,
  formula: 512,
  heading: 160,
  title: 160,
  text: 1024,
  page: 4096,
};

/** Mirror of rails.token_budget (incl. Python int() truncation). */
export function tokenBudget(
  kind: string,
  task: string,
  ocrLines: number,
  bboxAreaPx: number,
  capOverride?: number | null,
): number {
  const capKey = task === 'table' || task === 'formula' || task === 'page' ? task : kind;
  let cap = CAPS[capKey] ?? CAPS['text']!;
  if (capOverride) cap = Math.min(cap, capOverride);
  const est = ocrLines > 0 ? 64 + 48 * ocrLines : 64 + bboxAreaPx / 2500;
  return Math.trunc(Math.max(96, Math.min(est, cap)));
}

/** Mirror of rails.truncate_repeats: post-hoc containment of D-style repetition
 *  collapse — if the text ends with a unit of >= minUnit chars repeated
 *  >= minRepeats times, cut back to a single copy. (Indexing is UTF-16 code
 *  units vs Python code points; identical for BMP text, which is all this
 *  domain produces.) */
export function truncateRepeats(
  text: string,
  minUnit = 8,
  minRepeats = 4,
  maxUnit = 120,
): { text: string; repetition: boolean } {
  const n = text.length;
  const top = Math.min(maxUnit, Math.trunc(n / minRepeats));
  for (let unitLen = minUnit; unitLen <= top; unitLen++) {
    const unit = text.slice(n - unitLen, n);
    let reps = 1;
    while (
      reps < 1000 &&
      n - (reps + 1) * unitLen >= 0 &&
      text.slice(n - (reps + 1) * unitLen, n - reps * unitLen) === unit
    ) {
      reps++;
    }
    if (reps >= minRepeats) {
      const start = n - reps * unitLen;
      return { text: text.slice(0, start + unitLen).trimEnd(), repetition: true };
    }
  }
  return { text, repetition: false };
}
