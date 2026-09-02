# llmcoder — WebLLM sandbox proof of concept

A browser-only coding agent. A local LLM (WebLLM, WebGPU) runs in a Web Worker, chats in a
side pane, and edits an HTML/CSS/JS project that renders live in a sandboxed iframe by calling
tools. No server, no API keys; the weights are cached in the browser after the first load.

This document is the plan plus the reverse-engineering notes that justify it. Everything under
"Already done" exists in the repo and has been run on this machine (Apple M5, 32 GB, macOS 26,
Chrome 152).

---

## 0. Decisions at a glance

| Topic | Decision | Why |
|---|---|---|
| Package manager | **pnpm** (`pnpm-lock.yaml` is present; `bun` is the machine default but the lockfile wins) | Mixing lockfiles is worse than either choice |
| Inference | `@mlc-ai/web-llm` **0.2.84** via `WebWorkerMLCEngine` | Keeps the React UI responsive; chat.webllm.ai uses a service worker only to survive reloads, which a POC doesn't need |
| Where weights come from | Hugging Face `mlc-ai/*` repos + prebuilt wasm from `binary-mlc-llm-libs`, exactly as chat.webllm.ai does; **optionally served from `./models/` in dev** | HF is rate-limited and 4 GB re-downloads hurt; a local mirror also lets us serve models that aren't in the prebuilt list |
| Fast model | `Qwen3-0.6B-q4f16_1-MLC` — 320 MB weights, 1.4 GB VRAM | Smallest model that was trained on `<tool_call>` tool use; thinking can be switched off per request |
| Smart model | `Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC` — 830 MB weights, 1.6 GB VRAM | Code-tuned, same chat family and tool format as the fast model; the 7B was started and stopped at 2 GB because the download was too heavy for this pass (partial mirror kept, resumable) |
| Tool calling | `response_format: { type: "structural_tag" }` (XGrammar), **not** WebLLM's `tools` parameter | `tools` is hard-gated to five Hermes models; structural tags work with any model and guarantee parseable calls |
| Tool results back to the model | `user` message wrapped in `<tool_response>…</tool_response>` | WebLLM throws `Role is not supported: tool` for Qwen templates (their `roles` map has no `tool`); the wrapper is what Qwen's own chat template emits |
| Sandbox | `<iframe sandbox="allow-scripts" srcdoc=…>` + `postMessage` bridge | Opaque origin: the model's code can't touch the host page, storage, or the model cache |

---

## 1. Already done (this session)

- **`@mlc-ai/web-llm@0.2.84` added** to `package.json` with pnpm. It imports cleanly in Node, which
  is what lets the model script read the real prebuilt list instead of a copy.
- **`scripts/webllm-models.mjs`** (`pnpm models …`): list / resolve / download / verify / index
  WebLLM models. Zero dependencies. See §3.
- **`scripts/cdp-trace.mjs`** (`pnpm cdp:trace …`): launches Chrome with remote debugging, attaches
  to every target (page, workers, service workers) over raw CDP, and records every model artifact
  request. Zero dependencies. See §2 for what it found.
- **Both models mirrored** to `./models/` (gitignored) with `models/index.json` describing them as
  WebLLM `ModelRecord`s pointing at `/models/<id>/`. A stopped, partial mirror of
  `Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` (35 of 88 shards, 2 GB) sits alongside; it is not in the
  index and `pnpm models download <id>` resumes it, or `rm -r` it to reclaim the space.
- `.gitignore` covers `models/`, `.cdp-profile/`, `cdp-trace*.json`.

Nothing under `src/` has been touched yet; it is still the Vite template.

---

## 2. How chat.webllm.ai serves models (reverse-engineered)

Method: drove https://chat.webllm.ai in Chrome (extension session, then headless via
`scripts/cdp-trace.mjs`), sent one message so the default model loaded, then dumped the page's
Cache API and the CDP network log. Cross-checked against the WebLLM source
(`src/engine.ts`, `src/config.ts`, `src/cache_util.ts`, `src/support.ts`) and the
`mlc-ai/web-llm-chat` source that the site is built from.

### 2.1 The fetch sequence

`engine.reload(model_id)` looks up a `ModelRecord` in `appConfig.model_list` and fetches, in
this order, caching each in a named Cache API bucket:

| Step | URL | Cache bucket | Size (Llama-3.2-1B q4f32) |
|---|---|---|---|
| 1 | `https://huggingface.co/mlc-ai/<model_id>/resolve/main/mlc-chat-config.json` | `webllm/config` | 2 KB |
| 2 | `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/<modelVersion>/<lib>-webgpu.wasm` | `webllm/wasm` | 4.0 MB |
| 3 | `…/resolve/main/ndarray-cache.json` (shard manifest) | `webllm/model` | 67 KB |
| 4 | `…/resolve/main/tokenizer.json` (only this one; `vocab.json`/`merges.txt` are never fetched) | `webllm/model` | 2–11 MB |
| 5 | `…/resolve/main/params_shard_<N>.bin` for every record in `ndarray-cache.json` | `webllm/model` | 22 shards, 663 MB |

Measured with the tracer, fresh profile, this network: **26 requests, 670 MB, 27 s** (≈25 MB/s).
Prefill/decode on the M5 for that 1B q4f32 model: 296 / 55 tok/s.

Facts that shape the design:

- **Weights are per-repo, kernels are per-architecture.** The wasm is chosen by
  architecture + quantisation + context config, not by repo:
  `Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` runs on `Qwen2-7B-Instruct-q4f16_1_cs1k-webgpu.wasm`.
  So an arbitrary Hugging Face repo needs an explicit `model_lib`; there are 97 distinct wasm
  files across the 163 prebuilt records in 0.2.84.
- **The wasm prefix is pinned to the npm version.** 0.2.84 uses `v0_2_84/base/`; the deployed
  chat.webllm.ai (built on ^0.2.81) still fetches `v0_2_48/…-ctx4k_cs1k-webgpu.wasm`. Upgrade the
  npm package and every cached wasm becomes stale while the weights stay valid — which is why the
  mirror script records the upstream version per model.
- **HF redirects.** `/resolve/main/<file>` answers `302` to a signed CDN URL
  (`us.aws.cdn.hf.co/xet-bridge-us/…`, ~1 h expiry) and exposes `x-linked-size` on the redirect.
  The browser follows it; the Cache API key stays the logical `huggingface.co` URL.
- **Fetches happen off the page.** On a first visit the site's service worker isn't controlling
  the page yet, so it falls back to `WebWorkerMLCEngine` (tracer saw `issued from: worker`). On
  later visits the `ServiceWorkerMLCEngine` in `sw.js` does the fetching and *nothing appears in
  the tab's network log*, which is why the tracer attaches to all targets rather than one tab.
- **Cache is the source of truth, not the site.** `hasModelInCache(id, appConfig)` and
  `deleteModelAllInfoInCache(id, appConfig)` are exported; the three bucket names above are
  fixed. Our app shares nothing with chat.webllm.ai because cache storage is per origin.
- **This machine:** WebGPU adapter `apple / metal-3`, `shader-f16` present,
  `maxBufferSize` 4 GB, 32 GB unified memory. `q4f16_1` variants are the right pick (they need
  `shader-f16`, halve VRAM versus `q4f32_1`); anything up to ~9B fits.

### 2.2 How WebLLM tool calling actually works

- `chat.completions.create({ tools })` throws `UnsupportedModelIdError` unless the model is one
  of five Hermes-2-Pro / Hermes-3 ids. For those it injects a Hermes system prompt and forces
  `response_format: json_object` with a "list of {name, arguments}" schema. Not usable here.
- The general mechanism is `response_format: { type: "structural_tag", structural_tag }`
  (XGrammar). The bundled build accepts formats `triggered_tags`, `tags_with_separator`, `tag`,
  `json_schema`, `any_text`, `const_string`, `regex`, `grammar`, `sequence`, `or`,
  `qwen_xml_parameter`. The official `examples/structural-tag-tool-use` does exactly the loop we
  need, with `Llama-3.2-1B` — free text is allowed until the model emits a trigger
  (`<tool_call>`), after which the arguments are constrained to that tool's JSON schema.
- `role: "tool"` messages are only accepted when the conversation template declares a `tool`
  role. Qwen2/Qwen3 templates declare `user`/`assistant` only (the `role_templates.tool`
  entry is unused), so `appendMessage` throws. Tool results go back as `user` text.
- Qwen3 thinking is toggled per request with `extra_body: { enable_thinking: false }`.
- `@mlc-ai/web-xgrammar` is bundled *inside* web-llm, not installed, so the `StructuralTagLike`
  type resolves to `any`. We declare our own type for the tag object.

---

## 3. The scripts

### `pnpm models` — `scripts/webllm-models.mjs`

```
pnpm models list [--filter qwen] [--max-vram 6000] [--json]
pnpm models resolve  <spec> [--model-lib <url>]
pnpm models download <spec> [--out models] [--concurrency 4] [--force]
pnpm models verify   <spec>
pnpm models index
```

`<spec>` is a prebuilt `model_id`, `hf:<org>/<repo>`, or a huggingface.co URL. It does what the
engine does: reads `mlc-chat-config.json` and `ndarray-cache.json` to learn the file list, then
mirrors config + manifest + tokenizer files + shards + the wasm into `models/<model_id>/`,
verifies shard sizes against the manifest, and writes `record.json` (a `ModelRecord` whose
`model`/`model_lib` point at `/models/<id>/…`) plus `models/index.json`. Resumable; honours
`HF_TOKEN`. For a repo that isn't prebuilt it refuses to guess the wasm and prints the prebuilt
candidates for that quantisation.

### `pnpm cdp:trace` — `scripts/cdp-trace.mjs`

```
pnpm cdp:trace --url https://chat.webllm.ai --send hi
pnpm cdp:trace --url "http://localhost:5173/?model=Qwen3-0.6B-q4f16_1-MLC&autoload=1"
```

Launches Chrome (`--headless=new` unless `--headed`; WebGPU works headless on this Mac) with
its own profile, `Target.setAutoAttach(flatten)` + `Network.enable` on every session, optional
`--send` types into the first textarea, then writes a JSON trace with per-request kind, host,
bytes and timing, plus a dump of the `webllm/*` caches. Chrome ≥136 refuses remote debugging on
the default profile, so the profile is always separate (`.cdp-profile/`); use it as a
reproducible prewarm/benchmark target, not to warm your daily browser. Once M1 lands the app
will expose `?model=&autoload=1` and a `window.__llmcoder` status object so the same script can
time our own loads.

---

## 4. Model choices

| Role | model_id | Weights | VRAM | Notes |
|---|---|---|---|---|
| **fast / tests** | `Qwen3-0.6B-q4f16_1-MLC` | 320 MB, 9 shards | 1.4 GB | Prebuilt record caps context to 4096; run with `enable_thinking: false` |
| **smart / pages** | `Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC` | 830 MB, 30 shards | 1.6 GB | Prebuilt record caps context to 4096 — we override to 8192 (KV cache grows, fine here). Simple pages only; expect plain layouts |
| alt fast | `Llama-3.2-1B-Instruct-q4f16_1-MLC` | ~600 MB | 0.9 GB | The model the official structural-tag example uses; switch here if Qwen3-0.6B tool calls prove flaky |
| step up | `Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC` | 1.7 GB, 62 shards | 2.5 GB | First upgrade to try when 1.5B pages look thin |
| step up | `Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` | 4.1 GB, 88 shards | 5.1 GB | The real page builder; 2 GB of it is already on disk, resumable |
| alt smart | `Qwen3-8B-q4f16_1-MLC` | ~4.6 GB | 5.7 GB | Stronger reasoning, thinking on/off; slower first token |
| alt smart | `Qwen3.5-9B-q4f16_1-MLC` | ~5 GB | 6.4 GB | Newest in the 0.2.84 list; untested |

Swapping is a one-line change in `src/llm/models.ts` plus `pnpm models download <id>`.
`pnpm models list --filter coder` / `--filter qwen3` shows the rest. Only one model is loaded
at a time: WebLLM can hold several, but it doubles VRAM and the POC gains nothing from it.

---

## 5. Architecture

```
┌──────────────────────────────┬──────────────────────────────────────────────────┐
│ Side pane                    │ Main area                                        │
│  ┌ Model ─────────────────┐  │  [ Preview ] [ Files ] [ Console ]   (Reset)     │
│  │ ▾ Qwen3-0.6B (local)   │  │ ┌──────────────────────────────────────────────┐ │
│  │ ● cached  [Load] [⌫]   │  │ │                                              │ │
│  │ ▓▓▓▓▓▓▓░░ 71% 12.3 MB/s│  │ │   <iframe sandbox="allow-scripts"            │ │
│  └────────────────────────┘  │ │           srcdoc={assembled project}>        │ │
│  ┌ Chat ──────────────────┐  │ │                                              │ │
│  │ user: make a landing…  │  │ │                                              │ │
│  │ ⚙ write_file index.html│  │ │                                              │ │
│  │   ↳ ok (2.1 KB)        │  │ └──────────────────────────────────────────────┘ │
│  │ assistant: Done — …    │  │  console: [log] mounted   [error] foo is not…    │
│  │ [ message…      ][Send]│  │                                                  │
│  └────────────────────────┘  │                                                  │
└──────────────────────────────┴──────────────────────────────────────────────────┘
```

### 5.1 Files to create

```
src/
  llm/
    worker.ts        WebWorkerMLCEngineHandler — the whole engine lives here
    engine.ts        singleton WebWorkerMLCEngine; appConfig = prebuilt ∪ local mirror; progress events
    models.ts        curated list (the two chosen + alternates), VRAM/feature guard, ctx overrides
    tools.ts         tool definitions {name, description, schema, run} + structural-tag builder
    agent.ts         the loop: prompt → stream → parse <tool_call> → run → <tool_response> → repeat
    prompts.ts       system prompts (chat vs. page-builder)
  sandbox/
    Sandbox.tsx      <iframe> + bridge; assembles srcdoc from the virtual FS
    runtime.ts       script inlined into every srcdoc: console/error capture, run_js, DOM snapshot
    fs.ts            virtual FS (Map<path, content>) + localStorage persistence
  ui/
    SidePane.tsx  ModelPicker.tsx  Chat.tsx  ToolCallCard.tsx  MainArea.tsx  FilesView.tsx  ConsoleView.tsx
  state.tsx          one reducer + context (no store library for a POC)
vite.config.ts       + serveModels() dev middleware for ./models → /models/
```

### 5.2 Engine (`src/llm/engine.ts`)

- Module-level singleton; never in React state (StrictMode double-mounts effects, and the React
  Compiler assumes immutable values — a live engine object is neither).
- `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })` — the `new URL`
  must be literal inside `new Worker` for Vite to detect it.
- `appConfig.model_list = [...prebuiltAppConfig.model_list, ...localRecordsWithSuffix]` where
  local records come from `fetch("/models/index.json")` (dev only; empty array in prod) and get
  their `model_id` suffixed with ` (local)` so both sources can coexist in the picker.
- `initProgressCallback` → reducer → progress bar (WebLLM gives `progress` 0–1 and a text like
  "Fetching param cache[8/22]: 212MB fetched…").
- Guard before load: `vram_required_MB` vs a fixed budget, `required_features ⊆ adapter.features`,
  `navigator.gpu` present, else a clear error in the picker.
- `hasModelInCache` per record for the "cached" badge; `deleteModelAllInfoInCache` behind the ⌫.
- `navigator.storage.persist()` once, so Chrome is less likely to evict 4 GB of shards.

### 5.3 Sandbox (`src/sandbox/`)

- Virtual FS starts with `index.html`, `styles.css`, `app.js`. The host assembles one document:
  `index.html` with `<style>` (styles.css) and `<script>` (app.js) inlined, plus the runtime
  script first. `srcdoc` can't load relative files, and blob URLs or a service worker are not
  worth it for a POC.
- `sandbox="allow-scripts"` **without** `allow-same-origin`. Origin becomes `null`; the iframe
  posts to `"*"`, the host accepts messages only when `event.source === iframe.contentWindow`.
- A `<meta http-equiv="Content-Security-Policy">` in the srcdoc:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https:` —
  inline code is the whole point, but the page can't call out to arbitrary endpoints.
- Runtime (`runtime.ts`, inlined): wraps `console.*`, `window.onerror`,
  `unhandledrejection`, and answers `{type:"run", id, code}` with the JSON-serialised result of
  `new Function(code)()`, and `{type:"dom"}` with a trimmed `document.documentElement.outerHTML`.
- Every `write_file` re-renders the iframe (new `srcdoc`), which also resets state — acceptable.

### 5.4 Tools (`src/llm/tools.ts`)

| Tool | Arguments | Effect / returns |
|---|---|---|
| `write_file` | `{ path, content }` | Create or replace a file; sandbox re-renders; returns byte count |
| `read_file` | `{ path }` | Returns the file (truncated past ~8 KB with a marker) |
| `list_files` | `{}` | Paths + sizes |
| `run_js` | `{ code }` | Evaluates inside the sandbox; returns value, thrown error, and console lines since last call |
| `get_dom` | `{ maxChars? }` | Rendered DOM snapshot, for "why is the header not sticky" questions |

Wire format is the official one and also Qwen's native one:

```
<tool_call>
{"name": "write_file", "arguments": {"path": "index.html", "content": "<!doctype html>…"}}
</tool_call>
```

built as `{ type: "structural_tag", format: { type: "triggered_tags", triggers: ["<tool_call>"],
tags: tools.map(t => ({ begin: `<tool_call>\n{"name": "${t.name}", "arguments": `, content: { type: "json_schema", json_schema: t.schema }, end: "}\n</tool_call>" })), at_least_one: false, stop_after_first: false } }`.

The grammar only guarantees *shape*. HTML inside a JSON string costs escapes, which small
models get wrong more often than the grammar can fix (the grammar forces valid JSON, but the
model may then emit `\"` soup or truncate). **Fallback, kept in the design:** switch `write_file`
to a raw-content tag — `begin: '<write_file path="'`, path as `regex`, then `content: { type: "any_text" }`,
`end: "</write_file>"` — the `any_text` format is in the bundle for exactly this. Decide in M3
by measuring how often each form produces a page that parses.

### 5.5 Agent loop (`src/llm/agent.ts`)

1. `messages = [system(prompt for current mode), ...history, user(input)]`.
2. `engine.chat.completions.create({ messages, stream: true, response_format: structuralTag,
   max_tokens: 4096, temperature: 0.2, extra_body: { enable_thinking: false } })`.
3. Stream deltas to the chat; on finish, extract `<tool_call>` blocks with the regex from the
   official example.
4. No calls → done. Calls → run each, append the assistant text verbatim, then a `user` message
   `<tool_response>{"name":…,"result":…}</tool_response>` per call, go to 2. Cap at 8 rounds.
5. `finish_reason === "length"` → surface "output was cut off" and offer a continue button
   rather than silently looping.
6. Stop button → `engine.interruptGenerate()`; sandbox errors after a `write_file` are
   auto-appended as the next tool response so the model fixes its own runtime errors.

System prompt for page building (short, imperative): one self-contained `index.html`, inline CSS
and JS, no external scripts, no frameworks, mobile-first, call `write_file` once with the full
document, then stop and summarise in one sentence. The fast model gets the same prompt; its job in
tests is "change the background to blue", not "build a landing page".

### 5.6 Serving the mirror in dev (`vite.config.ts`)

Tiny `configureServer` middleware: for `GET /models/<id>/<file>` stream `./models/<id>/<file>`
with `Content-Length` and a `Content-Type` of `application/wasm` / `application/json` /
`application/octet-stream`. WebLLM fetches whole files, so no range support is needed.
`./models` stays outside `public/` on purpose: `vite build` copies `public/` into `dist/` and a
4 GB copy per build is not acceptable. Production would point records at a static bucket instead.

---

## 6. Milestones

Each one is a `pnpm dev` demo; type-check with `pnpm build` (tsc runs first).

**M1 — chat with the fast model.** Worker engine, model picker over prebuilt ∪ local records,
progress bar, cached badge, streaming chat. Accept: `Qwen3-0.6B-q4f16_1-MLC` loads both from
`/models/` and from Hugging Face; reload page → "cached" and load < 5 s; `pnpm cdp:trace` against
`localhost:5173/?model=…&autoload=1` reports the shard requests hitting `localhost`.
Verify first that Vite 8 pre-bundles `@mlc-ai/web-llm` without complaint; if the worker fails
to start, add `optimizeDeps.exclude: ["@mlc-ai/web-llm"]`.

**M2 — sandbox.** Iframe, bridge, Files and Console tabs, a dev-only "seed example" button that
writes three files. Accept: console and thrown errors from the iframe appear in the Console tab;
the host page is provably unreachable from inside (`parent.document` throws).

**M3 — tool loop with the fast model.** Structural tags, `write_file`/`read_file`/`list_files`/
`run_js`. Accept: "make the background blue" and "add a button that alerts hi" each complete in
one round with a valid page 9/10 times; decide JSON-vs-`any_text` for `write_file` here.

**M4 — page generation with the smart model.** Context override 8192, page-builder prompt,
`get_dom`, error-feedback round. Accept: "build a landing page for a coffee shop with a menu and
contact form" renders a complete styled page; a follow-up "make the header sticky" edits rather
than regenerates.

**M5 — polish, only if time.** Persist FS + chat in `localStorage`, export project as a zip,
model VRAM guard UI, `navigator.storage.estimate()` in the picker, dark theme.

---

## 7. Risks and gotchas (things that will otherwise cost an afternoon)

- **Vite + workers:** the worker file must be imported via a literal `new URL()` inside
  `new Worker()`, options must be static; `{ type: "module" }` is required because web-llm is ESM.
- **StrictMode / React Compiler:** engine and iframe bridge live outside React state; effects are
  idempotent (guard with a module flag).
- **Cache eviction & quota:** Chrome allows one origin a large share of free disk, but 4 GB is
  evictable; call `navigator.storage.persist()`, show `estimate()`. The local mirror is the real
  answer — a re-warm from `localhost` is disk speed, not network speed.
- **Version coupling:** upgrading `@mlc-ai/web-llm` changes `modelVersion` → new wasm URLs → run
  `pnpm models download <id>` again (skips complete shards, fetches only the new wasm).
- **HF rate limits:** anonymous `/resolve/` calls get throttled during bulk pulls; set `HF_TOKEN`.
  Observed throughput here fluctuated 5–25 MB/s.
- **Small-model tool use:** grammar guarantees syntax, not judgement; cap rounds, keep prompts
  short, keep temperature low, turn thinking off. If Qwen3-0.6B disappoints, Llama-3.2-1B is the
  proven fallback (it is what the official example uses).
- **Context length:** a full landing page is 1.5–3 K tokens; with system prompt + history +
  `read_file` echo, 4096 is tight. 8192 for the smart model; keep `read_file` truncation; don't
  echo written files back in tool responses.
- **`tool` role:** never send `role: "tool"` to Qwen models (throws); use the
  `<tool_response>` wrapper in a `user` message.
- **Structural tag typing:** define a local `StructuralTag` type; the upstream type is `any`.
- **CDP on the default profile:** impossible on Chrome ≥136; the tracer's separate profile is not
  your browser's cache.

---

## 8. Commands

```bash
pnpm install
pnpm models list --filter qwen --max-vram 6000       # what's available
pnpm models download Qwen3-0.6B-q4f16_1-MLC           # already done → models/…
pnpm models download Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC   # already done
pnpm models download Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC     # resumes the partial 2 GB mirror, when wanted
pnpm models verify Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC
pnpm cdp:trace --url https://chat.webllm.ai --send hi # reproduce §2.1
pnpm dev                                              # http://localhost:5173
pnpm build                                            # tsc -b && vite build
```

---

## Appendix A — Evidence

Cache API of chat.webllm.ai after loading `Llama-3.2-1B-Instruct-q4f32_1-MLC` (extension session,
service worker `https://chat.webllm.ai/sw.js` controlling the page):

```
webllm/config  1 entry   …/mlc-chat-config.json
webllm/wasm    1 entry   raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_48/Llama-3.2-1B-Instruct-q4f32_1-ctx4k_cs1k-webgpu.wasm  (4.2 MB)
webllm/model  24 entries tokenizer.json (9.1 MB), ndarray-cache.json (67 KB), params_shard_0..21.bin  (671.8 MB total)
```

`scripts/cdp-trace.mjs` summary, headless, fresh profile:

```
Chrome/152.0.7977.76  →  https://chat.webllm.ai
issued from: worker   wall: 27.3s   total:    669.8 MB
  config        1 req      0.0 MB
  wasm          1 req      4.0 MB
  tokenizer     1 req      2.3 MB
  manifest      1 req      0.0 MB
  shard        22 req    663.4 MB
  huggingface.co               25 req    665.7 MB
  raw.githubusercontent.com     1 req      4.0 MB
```

Hugging Face redirect for one shard (`curl -I`):

```
HTTP/2 302
location: https://us.aws.cdn.hf.co/xet-bridge-us/<hash>?…&Expires=…&Signature=…
x-linked-size: 77791232
```

`ndarray-cache.json` metadata for `Qwen3-0.6B-q4f16_1-MLC`: `ParamSize 339, ParamBytes
335 372 288, BitsPerParam 3.57`, 9 records of format `raw-shard`.

## Appendix B — Sources read

- WebLLM 0.2.84 source: `src/config.ts` (ModelRecord, prebuiltAppConfig, modelVersion),
  `src/engine.ts` (reloadInternal, tool post-processing), `src/openai_api_protocols/chat_completion.ts`
  (tools gate, ResponseFormat), `src/conversation.ts` (roles, appendMessage), `src/support.ts`
  (cleanModelUrl, Hermes prompt), `src/cache_util.ts` (asyncLoadTokenizer, cache helpers),
  `examples/structural-tag-tool-use`, `examples/qwen3`, `examples/json-schema`.
- `mlc-ai/web-llm-chat`: `app/client/webllm.ts` (ServiceWorker/WebWorker engine selection),
  `app/constant.ts` (model list filtered against `prebuiltAppConfig`), `app/worker/web-worker.ts`.
- Hugging Face API: `/api/models/mlc-ai/<id>/tree/main`, `mlc-chat-config.json`, `ndarray-cache.json`.

## Appendix C — Brand

The project is called **Mote**.

A *mote* is something tiny, discrete, and self-contained—a fitting metaphor for a complete software development environment living inside a browser tab. Mote contains its own model, virtual filesystem, runtime, and rendered application environment, with hardware-accelerated local LLM inference happening directly on the user's machine.

The brand should feel **small, powerful, local, technical, and slightly strange**. Think of Mote as a tiny autonomous unit of computation: a little world with enough intelligence and machinery inside it to build software.

Avoid generic "AI product" aesthetics such as purple gradients, sparkles, robot imagery, glowing brains, or overly friendly assistant branding. Mote should feel closer to a **runtime, debugger, operating system, or piece of computing infrastructure** than a chatbot.

Suggested positioning language:

**Mote — a complete AI development environment inside your browser.**

Supporting themes:

* Local-first
* Hardware accelerated
* Self-contained
* Browser-native
* Fast and immediate
* Developer-focused
* Minimal, precise, technical

Visual motifs can draw from **particles, pixels, memory cells, tiny contained worlds, computational nodes, or a single point of energy surrounded by structure**.

The core emotional idea is:

**A surprisingly powerful machine, reduced to a mote.**
