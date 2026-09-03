# Mote agent guide

`PLAN.md` is the product and architecture specification. Read the relevant section
before changing behavior. This file is only the constraints that are easy to
violate while implementing it.

The product is **Mote**: a browser-only coding agent. A local WebLLM model edits
an HTML/CSS/JS project that renders in a sandboxed iframe. No server, no API keys.

## Toolchain

- Use **pnpm**. `pnpm-lock.yaml` wins even though this machine normally prefers Bun.
- Verify substantive changes with `pnpm build` (`tsc -b && vite build`).
- Do not add `models/`, `.cdp-profile/`, traces, or `dist/` to Git. Weights are
  multi-gigabyte local artifacts.
- Keep commits small and milestone-oriented. Do not mix opportunistic refactors
  into feature commits.
- Do not put `baseUrl` back in `tsconfig.app.json`. TypeScript 6 treats it as
  deprecated and `pnpm build` fails without `ignoreDeprecations`.
- Do not move `./models` into `public/`. Vite copies `public/` into `dist/` and a
  multi-GB copy per build is unacceptable. The `serveModels()` middleware in
  `vite.config.ts` streams `/models/<id>/<file>` in dev only.
- WebLLM cache helpers fetch Hugging Face-shaped paths (`…/resolve/main/<file>`).
  The middleware rewrites that segment onto the on-disk mirror layout. Never
  `next()` a `/models/*` miss to Vite’s HTML fallback — a 200 `index.html` gets
  cached as `mlc-chat-config.json` and every later load throws
  `Unexpected token '<'`.
- If a new Vite 8 worker fails to start, add `optimizeDeps.exclude: ["@mlc-ai/web-llm"]`.
  Do not do this preemptively.

```
pnpm dev
pnpm build
pnpm models list --filter qwen --max-vram 6000
pnpm models download <model_id>
pnpm cdp:trace --url "http://localhost:5173/?model=Qwen3-0.6B-q4f16_1-MLC&autoload=1"
```

## File ownership

| Path | Owns |
|---|---|
| `src/llm/engine.ts` | `WebWorkerMLCEngine` singleton, cache, persist, interrupt |
| `src/llm/worker.ts` | `WebWorkerMLCEngineHandler` only |
| `src/llm/models.ts` | curated ids, local-mirror merge, VRAM/feature guards |
| `src/llm/tools.ts` | tool schemas, structural tag, parse/run |
| `src/llm/agent.ts` | prompt → stream → tool → `<tool_response>` loop |
| `src/llm/prompts.ts` | system prompts |
| `src/sandbox/fs.ts` | virtual filesystem singleton |
| `src/sandbox/runtime.ts` | host/iframe bridge, inlined runtime |
| `src/sandbox/document.ts` | `srcdoc` assembly |
| `src/sandbox/Sandbox.tsx` | the keyed iframe + bridge attach |
| `src/state.tsx` | the only React store (one reducer + context) |
| `src/ui/*` | views; they subscribe to the singletons above |

Do not introduce a store library. Do not duplicate file or console state in React.

## WebLLM

- Keep the engine **out of React state**. Strict Mode remounts effects and the
  React Compiler treats state as immutable; a live engine is neither. Guard
  one-shot effects with a module-level or `useRef` flag.
- Never read `projectFS` or `sandboxBridge` directly inside render or a
  `useMemo` callback. The compiler memoises by reactive inputs; a callback with
  none runs once and the preview silently freezes on the first document. Subscribe
  with `useSyncExternalStore(projectFS.subscribe, projectFS.getSnapshot)` and
  derive from the snapshot (`assembleDocument(snapshot.files)`,
  `listProjectFiles(snapshot.files)`). `pnpm cdp:agent` catches this: every
  trial then reports the same probe values.
- Construct the worker with this literal shape so Vite can split it:

  `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`

- `appConfig.model_list = [...prebuiltAppConfig.model_list, ...localRecords]`.
  Suffix local `model_id` values with ` (local)` so both sources coexist.
- Resolve mirror `model` / `model_lib` to **absolute same-origin URLs** before
  passing them to WebLLM. Root-relative `/models/…` throws `Invalid URL` inside
  its cache helpers.
- Tool calling uses `response_format: { type: "structural_tag" }`, never
  WebLLM's `tools` parameter (hard-gated to a few Hermes models).
- Return tool results as `user` messages wrapped in `<tool_response>`. Qwen
  templates have no `tool` role; `role: "tool"` throws.
- Agent requests: `enable_thinking: false`, `temperature: 0.2`, `max_tokens: 4096`,
  8-round cap. Smart model context override is **8192**.
- Define a local `StructuralTag` type. Upstream `StructuralTagLike` is `any`.
- Keep `window.__llmcoder` and `?model=&autoload=1` working; `pnpm cdp:trace`
  depends on them.
- Call `navigator.storage.persist()` once. Show `estimate()` in the picker.
  Do not silently swallow GPU / VRAM / feature-guard failures.

## Sandbox boundary

- `<iframe sandbox="allow-scripts allow-forms">` **without** `allow-same-origin`.
  The model's code must stay unable to touch the host document, storage, or model
  cache. `allow-forms` exists only so `submit` events fire; the CSP's
  `form-action 'none'` blocks the navigation and the runtime reports the submit.
- The iframe posts to `"*"` because its origin is opaque. The host accepts a
  message only when `event.source === iframe.contentWindow`.
- Keep the restrictive CSP in assembled `srcdoc`. Inline script and style are
  the point; `connect-src 'none'` is load-bearing.
- `srcdoc` cannot resolve virtual relative files. Assemble `index.html`,
  `styles.css`, `app.js`, and the runtime in the host. Prefer replacing
  `<link href="styles.css">` / `<script src="app.js">` when the model wrote
  them, rather than always appending a second copy.
- Escape `</script>` / `</style>` inside inlined content or the document
  terminates early.
- Every `write_file` rebuilds `srcdoc` and resets page state. Wait for the
  bridge `ready` signal (then a short settle) before `run_js` / `get_dom` /
  reading post-write console errors.
- Browser automation cannot click inside the opaque-origin iframe. Drive
  in-page behavior through `run_js`, not host-side pointer events.

## Tools and prompts

- Compact tool results. Do not echo full `write_file` contents. Truncate
  `read_file` around 8 KB.
- Follow-up edits must `read_file` / `list_files` first and preserve unrelated
  content. Do not blindly regenerate the whole project.
- `write_file` currently uses JSON-string content under structural tags. The
  grammar guarantees JSON shape, not sensible HTML-in-a-string. If small models
  emit `\"` soup or truncate, switch `write_file` to the `any_text` raw-content
  tag described in `PLAN.md` §5.4 — do not invent a third format.
- Surface `finish_reason === "length"` as a Continue action. Do not silently
  loop. Stop calls `engine.interruptGenerate()`.

## Interface

- Mote is a small runtime, not a friendly chatbot. Precise debugger language,
  dense controls, visible system state, dark graphite/cyan.
- No purple AI gradients, sparkles, robot imagery, or decorative monospace.
  Monospace is for code, logs, paths, and measurements only.
- Keep keyboard focus, disabled/loading/error/empty states, and the stacked
  mobile layout working whenever UI changes.
- Do not animate layout properties (`width` / `height` / `padding` / `margin`)
  on the load progress bar. The design hook blocks those writes.
- Do not put Inter (or other hook-flagged faces) in **sandbox** starter CSS.
  The host app may keep Inter; generated pages should use a system stack.
- Seed-example is **dev-only**. Do not ship it behind `import.meta.env.DEV` being
  false.

## Verification

- `pnpm build` after any TypeScript or Vite change.
- Exercise Preview / Files / Console / Reset / Seed in the browser for sandbox
  work. Confirm `parent.document` from the iframe still throws.
- Do not load a model in a verification pass unless the change is in the
  engine, agent, or tool loop. Weights are large and load is slow even from
  the local mirror.
- A single screenshot is not verification for UI behavior.
