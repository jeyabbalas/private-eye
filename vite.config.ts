import { fileURLToPath } from 'node:url';
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
// coi-serviceworker shim (public/coi-serviceworker.js).
//
// COEP must be `credentialless`, NOT `require-corp`: the model weights are
// fetched cross-origin from the HuggingFace CDN, whose responses do NOT carry
// `Cross-Origin-Resource-Policy`. Under `require-corp` those fetches are blocked
// ("Failed to fetch") the moment isolation is active — and in dev there's no
// service worker to inject CORP (Vite's headers make the page isolated on first
// load, so the shim never registers). `credentialless` keeps isolation (and the
// SharedArrayBuffer threads wllama needs) while fetching cross-origin no-cors
// subresources without credentials — exactly right for public model weights.
// index.html forces the production service worker to credentialless to match.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  base: '/private-eye/',
  resolve: {
    // `decode-named-character-reference` (a transitive dep of mdast-util-from-markdown,
    // reached only by the Deep Read markdown-assembly graph) ships a `browser` export
    // condition pointing at index.dom.js, which runs an UNGUARDED module-scope
    // `document.createElement('i')`. That crashes the Deep Read Web Worker with
    // "ReferenceError: document is not defined" at import-eval time — before any code
    // (or wllama) runs. Force its DOM-free Node build (index.js), which decodes via the
    // `character-entities` data map: worker-safe and functionally equivalent for our
    // markdown. Applied everywhere; the main thread works with the Node build too.
    alias: [
      {
        find: /^decode-named-character-reference$/,
        replacement: fileURLToPath(
          new URL('node_modules/decode-named-character-reference/index.js', import.meta.url),
        ),
      },
    ],
  },
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
