/**
 * The ONLY runtime seam. Pipeline/engine code depends on this interface, never
 * on node:* / sharp / onnxruntime-node / onnxruntime-web directly (enforced by
 * tests/unit/hygiene.test.ts). Node and browser provide concrete adapters.
 */
import type { InferenceSession } from 'onnxruntime-common';
import type { RasterImage } from '../core/types.ts';

export interface ModelSpec {
  id: string;
  /** Path/URL the adapter resolves: a models/-relative path; node reads disk, browser fetches. */
  url: string;
  /** Optional sibling external-data file (e.g. <model>.onnx.data) to co-locate before load. */
  externalData?: string[];
}

/** A path (node) or URL (browser) string identifying an input image. */
export type ImageSource = string;

export type ExecutionProvider = 'cpu' | 'wasm' | 'webgpu';

export interface OrtSessionOpts {
  ep?: ExecutionProvider;
  threads?: number;
}

// --- text LLM seam (Pipeline F) ---

export type TextLlmStopReason = 'eogToken' | 'maxTokens' | 'abort' | 'other';

export interface TextLlmGenerateOptions {
  /** JSON schema for grammar-constrained decoding (llama.cpp GBNF now, XGrammar in the browser). */
  jsonSchema?: Readonly<Record<string, unknown>>;
  maxTokens?: number;
  /** Default 0 (greedy — determinism is part of the eval contract). */
  temperature?: number;
  seed?: number;
  /** Force the response to start with this text (style anchor; must satisfy the grammar). */
  responsePrefix?: string;
}

export interface TextLlmResult {
  text: string;
  stopReason: TextLlmStopReason;
  /** Approximate (input text only, excluding chat-template framing). */
  promptTokens: number;
  responseTokens: number;
}

export interface TextLlm {
  /** Continue the current chat (so a retry turn sees the model's prior output). */
  prompt(text: string, opts?: TextLlmGenerateOptions): Promise<TextLlmResult>;
  /** Back to the system-prompt-only state; KV memory stays allocated (per-page batch hygiene). */
  resetChat(): Promise<void>;
  countTokens(text: string): number;
  dispose(): Promise<void>;
}

export interface TextLlmOptions {
  systemPrompt?: string;
  /** Tokens of chat context (default 12288). */
  contextSize?: number;
  /** false → CPU-only (reproducibility runs); default lets the runtime pick (Metal on Apple silicon). */
  gpu?: boolean;
  /** Suppress reasoning segments (Qwen3 thinking budget → 0). */
  disableThinking?: boolean;
}

export interface RuntimeContext {
  kind: 'node' | 'browser';
  /** Decode an encoded image (path/url) to RGBA pixels. */
  decodeImage(src: ImageSource): Promise<RasterImage>;
  /** Read raw encoded bytes of an image or asset (for engines that need them, e.g. tesseract). */
  readBytes(src: ImageSource): Promise<Uint8Array>;
  /** Fetch model bytes, counting them toward the download metric. */
  fetchModel(spec: ModelSpec): Promise<{ data: Uint8Array; bytes: number }>;
  /** Resolve a models/-relative path to a runtime-appropriate location
   *  (node absolute path / browser URL), e.g. for tesseract's langPath. */
  assetUrl(relPath: string): string;
  /** Size in bytes of a models/-relative asset, for the download metric. */
  assetSize(relPath: string): Promise<number>;
  /** Create an ONNX inference session from model bytes (or spec for external-data models). */
  createSession(spec: ModelSpec, opts?: OrtSessionOpts): Promise<InferenceSession>;
  /** Create a chat text LLM from a GGUF spec. Optional: Node-only in v0
   *  (node-llama-cpp/Metal); the browser path is WebLLM+XGrammar (NEXT_PIPELINES §F). */
  createTextLlm?(spec: ModelSpec, opts?: TextLlmOptions): Promise<TextLlm>;
  now(): number;
}
