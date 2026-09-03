# Mote agent guide

`PLAN.md` is the product and architecture specification. `HANDOFF.md` is what
is true on disk right now, what was measured, and what to do next. This file
is only the constraints that are easy to violate while working on the code.

The product is **Mote**: a browser-only coding agent. A local WebLLM model
edits an HTML/CSS/JS project that renders in a sandboxed iframe. No server,
no API keys, weights cached in the browser.

## Toolchain

- Use **pnpm**. `pnpm-lock.yaml` wins even though this machine normally
  prefers Bun.
- Dev server: `pnpm dev --port 5180 --strictPort`. Other agents on this
  machine use 5173/5174; do not let Vite pick a port.
- Verify substantive changes with `pnpm build` (`tsc -b && vite build`) and
  `pnpm test` (vitest, happy-dom). `pnpm lint` (oxlint) should add no warnings
  beyond the pre-existing shadcn fast-refresh ones in `src/components/ui`.
- Do not add `models/`, `.cdp-profile/`, `cdp-trace*.json`, `cdp-report*.json`
  or `dist/` to Git. Weights are multi-gigabyte local artifacts.
- Keep commits small and milestone-oriented. Do not mix opportunistic
  refactors into feature commits.
- Do not put `baseUrl` back in `tsconfig.app.json`. TypeScript 6 treats it as
  deprecated and `pnpm build` fails without `ignoreDeprecations`.
- Do not move `./models` into `public/`. Vite copies `public/` into `dist/`
  and a multi-GB copy per build is unacceptable. The `serveModels()`
  middleware in `vite.config.ts` streams `/models/<id>/<file>` in dev only.
- WebLLM cache helpers fetch Hugging Face-shaped paths
  (`…/resolve/main/<file>`). The middleware rewrites that segment onto the
  on-disk mirror layout. Never `next()` a `/models/*` miss to Vite's HTML
  fallback: a 200 `index.html` gets cached as `mlc-chat-config.json` and every
  later load throws `Unexpected token '<'`.
- A mirror must contain `tensor-cache.json`; 0.2.84 fetches it before
  `ndarray-cache.json`. A missing file surfaces in the browser as
  `Failed to execute 'add' on 'Cache': Request failed`. `pnpm models verify`
  reports it; `pnpm models download` fetches only what is missing.
- `vite.config.ts` ignores `.cdp-profile/**` and `models/**` in the watcher.
  Chrome writes into its profile constantly; without the ignore every write
  is a full page reload in the middle of a harness run.
- If a new Vite 8 worker fails to start, add
  `optimizeDeps.exclude: ["@mlc-ai/web-llm"]`. Do not do this preemptively.

```
pnpm dev --port 5180 --strictPort
pnpm build && pnpm test
pnpm models list --filter qwen --max-vram 6000
pnpm models download <model_id>
pnpm models verify <model_id>
pnpm cdp:agent --scenario m3 --trials 10           # M3 acceptance on the fast model
pnpm cdp:agent --scenario coffee --model Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC
pnpm cdp:trace --url "http://localhost:5180/?model=Qwen3-0.6B-q4f16_1-MLC&autoload=1"
```

## File ownership

| Path | Owns |
|---|---|
| `src/llm/engine.ts` | `WebWorkerMLCEngine` singleton, cache, persist, interrupt |
| `src/llm/worker.ts` | `WebWorkerMLCEngineHandler` only |
| `src/llm/models.ts` | catalog, id parsing, device profile, fit classification, load gate |
| `src/llm/tools.ts` | tool schemas, structural tag, block scanner, turn context, run |
| `src/llm/agent.ts` | prompt → stream → run blocks as they close → `<tool_response>` loop |
| `src/llm/prompts.ts` | system prompts |
| `src/llm/stream.ts` | per-token buffer of the round being generated |
| `src/automation.ts` | `window.__llmcoder`: the only surface the CDP harness touches |
| `src/sandbox/fs.ts` | virtual filesystem singleton, snapshots, persistence |
| `src/sandbox/document.ts` | `srcdoc` assembly from a snapshot, the CSP |
| `src/sandbox/runtime.ts` | host/iframe bridge, inlined runtime (console, run_js, DOM, dialogs, submits) |
| `src/sandbox/Sandbox.tsx` | the keyed iframe and bridge attach |
| `src/state.tsx` | the only React store (one reducer + context) |
| `src/ui/*` | views; they subscribe to the singletons above |
| `scripts/cdp.mjs` | Chrome launch and CDP session plumbing shared by both harness scripts |
| `scripts/cdp-agent.mjs` | scenario runner and sandbox probes |
| `src/sw.js` | the service worker source; emitted to `dist/sw.js` by the build |
| `src/pwa.ts` | registration and the "a new build is waiting" store |
| `src/analytics.ts` | the only place an analytics event may be sent from |
| `assets/*` | brand sources; `pnpm assets` renders them into `public/` |
| `scripts/render-assets.mjs` | headless-Chrome rasteriser for those sources |
| `public/_headers` | Cloudflare Pages response headers |

Do not introduce a store library. Do not duplicate file or console state in
React.

## React and the compiler

- Keep the engine **out of React state**. Strict Mode remounts effects and
  the React Compiler treats state as immutable; a live engine is neither.
  Guard one-shot effects with a module-level or `useRef` flag.
- Never read `projectFS` or `sandboxBridge` inside render or a `useMemo`
  callback. The compiler memoises by reactive inputs; a callback with none
  runs once and the preview silently freezes on the first document. Subscribe
  with `useSyncExternalStore(projectFS.subscribe, projectFS.getSnapshot)` and
  derive from the snapshot (`assembleDocument(snapshot.files)`,
  `listProjectFiles(snapshot.files)`). `pnpm cdp:agent` catches a regression:
  every trial then reports identical probe values.
- No `setState` inside effects and no `Date.now()` in render; oxlint's React
  rules flag both and the compiler bails out of the component. Adjust state
  during render (see `FilesView`) or tick from an interval.
- Per-token updates go through `liveStream`, not the reducer. Only the stream
  box subscribes to it.
- The workspace view, the selected file and the preview width live in the
  store so a tool card can open a file; do not keep a second copy in a view.

## WebLLM

- Construct the worker with this literal shape so Vite can split it:
  `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`.
- `appConfig.model_list = [...prebuiltAppConfig.model_list, ...localRecords]`.
  Suffix local `model_id` values with ` (local)` so both sources coexist, and
  apply overrides by **base id**, before the suffix.
- The picker offers **every prebuilt chat model** (159 of the 163 records; the
  four `snowflake-arctic-embed` entries are embedding models and throw on
  `reload`). Rows are grouped by what the device can hold, not by curation.
- **Fit is decided by the quantisation, not by `required_features`.** Only 29 of
  the 85 `f16` records declare `shader-f16`, so trusting the field offers 56
  unrunnable models to a GPU without half-precision and the failure surfaces as
  a shader compile error deep inside the load.
- The VRAM budget is inferred — WebGPU exposes no VRAM figure, deliberately —
  from `navigator.deviceMemory` (capped at 8 GB by the spec, absent outside
  Chrome) at 75%. That lands on the 6 GB this repo measured the 7B against. It
  is an estimate and the interface says so; do not present it as a measurement.
- `PROVEN_MODEL_IDS` is the only thing allowed to produce a "recommended" label,
  because it is the only list backed by pass rates in `HANDOFF.md`. Adding an id
  there is a claim; measure it with `pnpm cdp:agent` first.
- Context overrides stay keyed to the models they were measured on. The compiled
  kernels carry their own maximum (`…-ctx4k_cs1k-webgpu.wasm`), so raising a
  window by family would fail at load on some members of that family.
- Resolve mirror `model` / `model_lib` to **absolute same-origin URLs**
  before passing them to WebLLM. Root-relative `/models/…` throws
  `Invalid URL` inside its cache helpers.
- Tool calling uses `response_format: { type: "structural_tag" }`, never
  WebLLM's `tools` parameter. In 0.2.84 `tools` throws
  `UnsupportedModelIdError` unless the model is one of five Hermes ids
  (`functionCallingModelIds`). The implementation follows the official
  `examples/structural-tag-tool-use`.
- Return tool results as `user` messages wrapped in `<tool_response>`. Qwen
  templates have no `tool` role; `role: "tool"` throws.
- Agent requests: `enable_thinking: false`, `temperature: 0.2`,
  `max_tokens: 4096`, `stream_options.include_usage`, 8-round cap.
  `at_least_one: true` on the first round only. Coder models (1.5B and 7B)
  get an 8192 context override.
- Define a local `StructuralTag` type. Upstream `StructuralTagLike` is `any`.
- Keep `window.__llmcoder` (status fields **and** methods) and
  `?model=&autoload=1` working; both harness scripts depend on them.
- Call `navigator.storage.persist()` once. Show `estimate()` in the picker.
  Do not silently swallow GPU / VRAM / feature-guard failures.

## Sandbox boundary

- `<iframe sandbox="allow-scripts allow-forms">` **without**
  `allow-same-origin`. The model's code must stay unable to touch the host
  document, storage, or model cache. `allow-forms` exists only so `submit`
  events fire; the CSP's `form-action 'none'` blocks the navigation and the
  runtime turns an unhandled submit into a toast and a console line.
- The iframe posts to `"*"` because its origin is opaque. The host accepts a
  message only when `event.source === iframe.contentWindow`.
- Keep the restrictive CSP in the assembled `srcdoc`. Inline script, style
  and `'unsafe-eval'` are the point (`run_js` uses `new Function`);
  `connect-src 'none'` and `form-action 'none'` are load-bearing.
- No `allow-modals`. The runtime replaces `alert`/`confirm`/`prompt` with an
  in-page toast plus a console line so nothing blocks the tab or automation.
- `srcdoc` cannot resolve virtual relative files. `document.ts` inlines
  `styles.css` and `app.js` **only** where `index.html` links them. A page
  the model wrote as a single self-contained document must not inherit the
  starter stylesheet.
- Escape `</script>` / `</style>` inside inlined content or the document
  terminates early.
- The iframe is keyed on the project revision and attached in a layout
  effect. Every write is a real navigation, even when the content is
  unchanged; otherwise the bridge waits forever for `ready`.
- Browser automation cannot click inside the opaque-origin iframe. Drive
  in-page behavior through `run_js` / `window.__llmcoder.runInSandbox`.

## Tools and prompts

- Tool blocks run as soon as `scanToolBlocks` reports them whole, while the
  stream continues. Never parse the stream with a regex to the closing tag:
  file content contains braces and fences. A whole object whose closer never
  arrived still counts at the end of a round.
- The structural tag triggers on `<tool_call>` **and** on a Markdown fence.
  Qwen2.5-Coder answers with ```` ```json ```` blocks; unconstrained they
  carry raw newlines and cannot be parsed. Fenced JSON that is not a
  registered call is prose, never a "broken tool call" reply.
- `write_file` refuses to overwrite a file that diverged from the starter and
  was not read or written this turn (`TurnContext`). Tool payloads never
  enter the chat history, so without this a follow-up replaces a stylesheet
  with the one rule it was asked for. Untouched starter files are exempt.
- A round made only of inspection calls already answered since the last
  write gets one nudge, then the turn stops.
- Compact tool results. Do not echo full `write_file` contents. Truncate
  `read_file` around 8 KB.
- `write_file` uses JSON-string content under structural tags. Measured
  10/10 and 9/10 on the fast model; the `any_text` fallback in `PLAN.md`
  §5.4 was not needed. Do not invent a third format.
- Surface `finish_reason === "length"` as a Continue action. Stop calls
  `engine.interruptGenerate()`; `finish_reason === "abort"` keeps tools that
  already ran and starts nothing more.
- The prompt wording is measured, not guessed. A stricter single-file prompt
  made the 1.5B drop requested sections; change `pageBuilderPrompt` only with
  `pnpm cdp:agent` numbers before and after.

## Interface

- Mote is a small runtime, not a friendly chatbot. Precise debugger
  language, dense controls, visible system state, dark graphite/cyan.
- No purple AI gradients, sparkles, robot imagery, or decorative monospace.
  Monospace is for code, logs, paths, and measurements only.
- Keep keyboard focus, disabled/loading/error/empty states, and the stacked
  layout (≤760 px) working whenever UI changes. The side pane has
  `min-height: 0; overflow: hidden` so the chat scrolls instead of pushing
  the composer off-screen; the stacked grid uses `minmax(0, 1fr)`.
- Confirmations are inline (Reset, cache deletion); no `window.confirm`.
- Do not animate layout properties (`width` / `height` / `padding` /
  `margin`) on the load progress bar. The design hook blocks those writes.
- Do not put Inter (or other hook-flagged faces) in **sandbox** starter CSS.
  The host app may keep Inter; generated pages should use a system stack.
- Seed-example is **dev-only**. Do not ship it behind `import.meta.env.DEV`
  being false.

## Production build and deploy

Cloudflare Pages, from `main`, at `https://mote.jonjaques.com`. Build `pnpm build`,
output `dist`, Node pinned by `.node-version` (verified on 22.23.2), pnpm by
`packageManager`.

- **The local mirror is development-only.** `loadLocalRecords()` returns `[]` unless
  `import.meta.env.DEV`. A deploy must never fetch `/models/index.json`: Pages answers an
  unknown path with a 200 HTML shell, and HTML parsed as a record list is the cache
  poisoning AGENTS has warned about since the beginning. There is a test for this.
- **Analytics are a build variable.** `analytics()` in `vite.config.ts` injects the gtag
  pair into `index.html` only when `GA_MEASUREMENT_ID` (or `VITE_…`) is set *and* matches
  `G-XXXXXXXXXX`. The shape check is not cosmetic: the value comes from a deploy dashboard
  and lands inside an inline `<script>`. Events go through `src/analytics.ts` and carry
  model ids and durations only — never prompts, output, or file contents.
- **`sw.js` must keep its blind spots.** A service worker sits in front of every fetch a
  controlled page makes, including the WebLLM worker's shard fetches. It handles same-origin
  GETs only, and never `/models/*`, never a cross-origin URL, never a range request. Not
  calling `respondWith` leaves the browser's own networking alone; that is the default for
  everything else. Do not add a runtime-caching rule "for completeness" — a 4 GB download
  duplicated into a second cache blows the origin quota and evicts the copy that matters.
- **No `script-src` in the host CSP.** A policy on the host document is inherited by srcdoc
  children, and the sandbox *is* a srcdoc document that must run inline script and
  `new Function`. Measured against the real iframe: `default-src 'self'; script-src 'self'`
  kills the sandbox silently; `object-src 'none'; base-uri 'self'; frame-ancestors 'none';
  form-action 'self'` does not. `public/_headers` ships the second set and nothing more.
  The frame keeps its own far stricter policy, and that is the boundary that matters.
- **`dist/sw.js` is generated.** `serviceWorker()` reads `src/sw.js`, substitutes the
  precache list and a build id hashed from the asset names *and* the emitted `index.html`
  (the one precached file whose name never changes), and emits it. The plugin is
  `enforce: 'post'` because Vite's own HTML plugin emits `index.html` during
  `generateBundle`. It never calls `skipWaiting` on install: the running tab holds lazy
  chunks from the build it loaded. The waiting worker takes over when the visitor presses
  the "Update ready" chip in the brand header.
- **Brand assets are committed build outputs.** `assets/mark.svg`, `assets/icon-maskable.svg`
  and `assets/og.html` are the sources; `pnpm assets` renders the PNGs and the favicon with
  headless Chrome. Edit the source and re-render — never hand-edit a file in `public/`.
- **`/sw.js` must not be cached.** `_headers` sets `max-age=0, must-revalidate` for it. A
  cached service worker is one no deploy can replace.

## Verification

- `pnpm build` and `pnpm test` after any TypeScript or Vite change.
- Exercise Preview / Files / Console / Reset / Seed in the browser for
  sandbox work. Confirm `parent.document` from the iframe still throws.
- Changes to the engine, agent, tool loop or prompts are verified with
  `pnpm cdp:agent`, which loads a model. Everything else should not load one;
  weights are large and load is slow even from the local mirror.
- **Do not edit `src/` while a harness run is going.** Vite reloads the page
  under it and the trial is lost. Wait for `report written`.
- A single screenshot is not verification for UI behavior.
