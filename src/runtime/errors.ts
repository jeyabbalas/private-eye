/**
 * Typed error taxonomy + normalization for the consumer-facing error modal.
 * Every surfaced error carries a SIMPLE human sentence plus a TECHNICAL block
 * the user can copy/paste into a bug report. No jargon leaks into userMessage.
 */
import type { Capabilities } from './capabilities.ts';

export type AppErrorKind =
  | 'ModelDownload'
  | 'OutOfMemory'
  | 'WebGpuInit'
  | 'Decode'
  | 'Capability'
  | 'Unknown';

export interface AppError {
  kind: AppErrorKind;
  /** One plain sentence for the user. */
  userMessage: string;
  /** Copy/paste diagnostics for a bug report. */
  technical: string;
}

const FRIENDLY: Record<AppErrorKind, string> = {
  ModelDownload: "Couldn't download a model file. Check your connection and try again.",
  OutOfMemory: 'Your device ran low on memory for this step. Close other tabs, or use Quick Read instead of Deep Read.',
  WebGpuInit: "Couldn't start graphics acceleration; falling back to the slower compatibility mode.",
  Decode: "Couldn't read part of this page.",
  Capability: 'This step needs more than your current browser or device can provide.',
  Unknown: 'Something went wrong while reading this document.',
};

export class PrivateEyeError extends Error {
  readonly kind: AppErrorKind;
  readonly userMessage: string;
  readonly detail?: Record<string, unknown>;
  constructor(kind: AppErrorKind, message: string, opts?: { userMessage?: string; detail?: Record<string, unknown>; cause?: unknown }) {
    super(message, opts?.cause != null ? { cause: opts.cause } : undefined);
    this.name = 'PrivateEyeError';
    this.kind = kind;
    this.userMessage = opts?.userMessage ?? FRIENDLY[kind];
    this.detail = opts?.detail;
  }
}

export const modelDownloadError = (message: string, detail?: Record<string, unknown>, cause?: unknown) =>
  new PrivateEyeError('ModelDownload', message, { detail, cause });
export const outOfMemoryError = (message: string, detail?: Record<string, unknown>, cause?: unknown) =>
  new PrivateEyeError('OutOfMemory', message, { detail, cause });
export const decodeError = (message: string, detail?: Record<string, unknown>, cause?: unknown) =>
  new PrivateEyeError('Decode', message, { detail, cause });
export const capabilityError = (message: string, detail?: Record<string, unknown>) =>
  new PrivateEyeError('Capability', message, { detail });

export interface ErrorEnv {
  capabilities?: Capabilities;
  /** e.g. { onnxEp: 'webgpu', vlmEp: 'wasm' } */
  executionProviders?: Record<string, string>;
  /** Where it happened, e.g. 'quick-worker:runE'. */
  context?: string;
}

/** Normalize any throwable into an AppError with a copy-pasteable technical block. */
export function reportError(e: unknown, env: ErrorEnv = {}): AppError {
  const isPe = e instanceof PrivateEyeError;
  const kind: AppErrorKind = isPe ? e.kind : 'Unknown';
  const message = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? e.stack : undefined;
  const detail = isPe ? e.detail : undefined;

  const lines: string[] = [
    `Private Eye ${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'}`,
    `kind: ${kind}`,
    `message: ${message}`,
  ];
  if (env.context) lines.push(`context: ${env.context}`);
  if (env.executionProviders) lines.push(`executionProviders: ${JSON.stringify(env.executionProviders)}`);
  if (detail) lines.push(`detail: ${safeJson(detail)}`);
  if (env.capabilities) lines.push(`capabilities: ${safeJson(env.capabilities)}`);
  lines.push(`crossOriginIsolated: ${typeof self !== 'undefined' ? !!self.crossOriginIsolated : 'n/a'}`);
  if (typeof navigator !== 'undefined') lines.push(`userAgent: ${navigator.userAgent}`);
  if (stack) lines.push(`stack:\n${stack}`);

  return { kind, userMessage: isPe ? e.userMessage : FRIENDLY[kind], technical: lines.join('\n') };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
