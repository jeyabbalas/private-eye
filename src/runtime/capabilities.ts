/**
 * Device / browser capability detection, centralized. Gates Pipeline selection
 * (Deep Read needs real memory + ideally WebGPU) and feeds the error modal's
 * technical block. Safe to call on the main thread.
 */
export interface Capabilities {
  /** self.crossOriginIsolated — required for multithreaded wllama. */
  crossOriginIsolated: boolean;
  /** A WebGPU adapter was obtained. */
  webgpu: boolean;
  /** navigator.deviceMemory (coarse: 0.25 .. 8), if exposed. */
  deviceMemoryGb?: number;
  /** navigator.hardwareConcurrency. */
  cores: number;
  /** OPFS available (for caching the Deep Read GGUF). */
  opfs: boolean;
  /** Secure context (HTTPS) — prerequisite for OPFS + service worker. */
  secureContext: boolean;
}

export async function detectCapabilities(): Promise<Capabilities> {
  let webgpu = false;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu && typeof gpu.requestAdapter === 'function') {
      webgpu = (await gpu.requestAdapter()) != null;
    }
  } catch {
    webgpu = false;
  }

  const storage = (navigator as Navigator & { storage?: { getDirectory?: unknown } }).storage;
  const opfs = !!storage && typeof storage.getDirectory === 'function';

  return {
    crossOriginIsolated: typeof self !== 'undefined' && !!self.crossOriginIsolated,
    webgpu,
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    cores: navigator.hardwareConcurrency || 4,
    opfs,
    secureContext: typeof self !== 'undefined' && !!self.isSecureContext,
  };
}

/** Plain-language recommendation for whether Deep Read is advisable here. */
export function deepReadAdvisable(caps: Capabilities): boolean {
  const mem = caps.deviceMemoryGb ?? 8; // unknown -> assume capable, the runner preflights too
  if (caps.webgpu) return mem >= 2;
  return mem >= 8; // WASM fallback needs ~4 GB peak; require headroom
}
