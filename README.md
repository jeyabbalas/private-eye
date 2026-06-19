# Private Eye

Private Eye turns scanned documents into clean, structured Markdown — **entirely in your
browser**. Upload an image or PDF and it reconstructs the headings, paragraphs, lists,
key–value fields, and tables, then hands you a review surface to check and correct anything it
was unsure about.

It exists for documents you should not upload to a server: clinical records, financial
statements, anything private. The processing that would normally happen in someone else's cloud
happens on your own machine instead.

## Privacy

**No document bytes ever leave your device.** Your files are read, rasterized, OCR'd, and
assembled locally; corrections are saved locally (in your browser's IndexedDB). There is no
backend, no upload, no analytics, and no telemetry.

The *only* network traffic is **inbound**: the app downloads public AI model weights from the
[Hugging Face](https://huggingface.co) CDN the first time you need them (with `cache: 'no-store'`,
so nothing is left behind in the HTTP cache). Nothing derived from your document is ever sent
anywhere. You can confirm this yourself in the browser's Network tab — every request is a `GET`
to `huggingface.co`.

## Two ways to read

| | **Quick Read** | **Deep Read** (opt-in) |
|---|---|---|
| Engine | Deterministic OCR pipeline (PP-DocLayoutV3 → PP-OCRv6 → SLANet) | GLM-OCR vision–language model (via [wllama](https://github.com/ngxson/wllama)) |
| Best for | Clean scans; an exact, faithful transcription | Messy layouts and complex structure |
| Download | ~tens of MB, browser-cached | ~1.4 GB of weights, cached on-device (OPFS) |
| Runs | Off the main thread, in a Web Worker | wllama's own worker pool (WebGPU when available) |

**Deep Read keeps the numbers honest.** A language model can read fluently and still invent a
digit, so every numeric token Deep Read produces is checked against the deterministic OCR of the
same page: exact matches are kept, near-misses are corrected to the OCR reading, and anything the
scan can't confirm is flagged for you. If a page trips the numeric safety gate, Deep Read
**automatically falls back** to Quick Read's exact transcription for that page. The model
contributes structure and hard-to-read glyphs — never an unaudited number.

## Review and correct

Every result comes with a review surface, not just text:

- A **confidence overlay** on the page image, with an adjustable highlight threshold.
- A prioritized **attention queue** — cross-model numeric conflicts first, then unverified or
  possibly-missed numbers, then low-confidence areas and coverage gaps.
- A **verdict banner** summarizing whether the page passed, needs a skim, or fell back to the
  exact transcription.
- Inline **block editing** and **region drawing** (re-OCR a missed area).

Corrections are event-sourced in IndexedDB, so they survive a reload and apply to the exported
Markdown.

## Browser support

- **Best:** desktop **Chrome** or **Edge** with WebGPU — Deep Read runs accelerated and
  multithreaded.
- **Works:** **Firefox** and **Safari** fall back to a slower WASM path; Quick Read is fully
  supported.
- Requires a **secure context** (HTTPS or `localhost`). Cross-origin isolation — needed for
  wllama's multithreading (`SharedArrayBuffer`) — is provided on GitHub Pages by a bundled
  service worker ([`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker)); the page
  reloads once on first visit to activate it.
- Deep Read caches its weights in the **Origin Private File System (OPFS)**, so returning visitors
  don't re-download the model.

## Develop

Requires Node ≥ 22.

```bash
npm install        # also stages vendored ORT + patched wllama assets
npm run dev        # Vite dev server (sets the COOP/COEP headers locally)
npm run build      # production build to dist/
npm run preview    # serve the production build locally
npm run typecheck  # tsc --noEmit
npm test           # vitest — unit tests for the numeric-critical pipeline
```

Append `?debug=1` to the URL to enable the (otherwise silent) diagnostic logger.

## Deploy

Pushing to `main` builds and publishes to **GitHub Pages** via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) (build → typecheck → test →
deploy). The app is served under the `/private-eye/` base path. Model weights are streamed from
Hugging Face at runtime; only the small patched layout graph is vendored into the build.

## How it works

Private Eye is plain TypeScript with imperative DOM — no UI framework — bundled by Vite. The
deterministic engines run on [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html);
Deep Read runs GLM-OCR through wllama (llama.cpp compiled to WebAssembly). Models are fetched
from public Hugging Face repositories:

- Layout — `PP-DocLayoutV3` (ONNX)
- Text detection + recognition — `PP-OCRv6` (ONNX)
- Table structure — `SLANet` (ONNX)
- Deep Read — `GLM-OCR` (GGUF)

## License

MIT
