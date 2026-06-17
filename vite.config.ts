import { defineConfig } from 'vite';

/**
 * Private Eye is a GitHub Pages project site served under a subpath, so `base`
 * must prefix every asset URL. All same-origin runtime assets (onnxruntime-web
 * WASM, the memory-patched wllama runtime, the patched layout graph, the COI
 * service worker, logos, calibration.json) are staged into `public/` by
 * scripts/prepare-build.ts and copied verbatim into dist/ under `base`. Large
 * model weights are fetched at runtime from the HuggingFace CDN (see
 * src/runtime/assets.ts) — only public weights are downloaded inbound; no user
 * document ever leaves the browser.
 */

// Cross-origin isolation (COOP/COEP) lets wllama run multithreaded. Vite can
// send these in dev/preview; GitHub Pages cannot, so production relies on the
// coi-serviceworker shim (public/coi-serviceworker.min.js).
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: '/private-eye/',
  define: {
    __APP_VERSION__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? 'dev'),
  },
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
  // The ML runtimes ship their own WASM/worker assets and break Vite's dep
  // pre-bundling; we load them via same-origin URLs, so exclude them.
  optimizeDeps: {
    exclude: ['onnxruntime-web', '@wllama/wllama'],
  },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
});
