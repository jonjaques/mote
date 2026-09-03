# Handoff — 2026-09-02

You are taking over **Mote** (`llmcoder`). The product spec is `PLAN.md`. The
constraints that are easy to violate are `AGENTS.md`. Read both before editing.
This file is only what is true on disk right now, what was verified, and what
to do next.

## Snapshot

- Branch: `main` at `7d142b2`. No remote.
- Dev server is already running: `pnpm dev` → **http://localhost:5174/** (5173
  was taken). Do not start a second one.
- Package manager is **pnpm**. Do not use bun.
- `pnpm build` was green after the last code change.

```
7d142b2 Wire the agent loop, persistence, and project export
b072e2a Stop Vite from poisoning the local model cache
04d403f Expand the agent guide with implementation guardrails
a531764 Document Mote implementation guardrails
1a8d1ee Add the isolated project sandbox
26db72e Build the local WebLLM runtime shell
e09a3af Initial commit
```

Local mirrors in `./models/` (gitignored):

| model_id | Role | On disk |
|---|---|---|
| `Qwen3-0.6B-q4f16_1-MLC` | Fast / tests | Complete (~320 MB) |
| `Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC` | Smart / pages | Complete (~830 MB) |
| `Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` | Step-up | Complete and in `models/index.json` (PLAN still says partial — stale) |

## What is implemented

**M1 — runtime shell.** Worker engine, picker over prebuilt ∪ local records,
progress, cached badge, storage estimate, streaming chat, `?model=&autoload=1`,
`window.__llmcoder`. Engine lives in `src/llm/engine.ts`, never React state.

**M2 — sandbox.** Opaque-origin iframe (`allow-scripts` only), host/iframe
bridge, Files / Console / Preview, dev-only Seed example, Reset. Isolation was
verified: `contentWindow.document` throws `SecurityError`.

**M3 — tool loop (code complete, not acceptance-tested).** Structural tags,
`write_file` / `read_file` / `list_files` / `run_js` / `get_dom`, 8-round cap,
`<tool_response>` as `user` messages, interrupt, Continue on `finish_reason ===
"length"`, tool cards in chat. JSON-string `write_file` is still the format;
the `any_text` fallback in PLAN §5.4 has not been measured.

**M4 — partly in.** Smart-model context override is 8192. Page-builder prompt
is the only prompt the agent uses. After a successful `write_file` round the
loop stops early and summarises. If the smart model writes `index.html` that
links `styles.css` without writing that file, the loop continues.

**M5 — mostly in.** FS persist (`mote:project:v1`), chat persist
(`mote:chat:v1`), zip export via `@zip.js/zip.js`, VRAM guard, storage
estimate, dark graphite/cyan theme.

## Landmines that already cost time

1. **WebLLM appends `resolve/main/` to every model URL.** Local records must
   include that segment (`src/llm/models.ts` `toAbsoluteModelUrl`). The Vite
   middleware rewrites it onto `./models/<id>/<file>`.
2. **Never let `/models/*` fall through to the SPA.** A 200 `index.html` is
   cached as `mlc-chat-config.json`. The next load throws
   `Unexpected token '<'`. Middleware now returns JSON 404. `loadModel` also
   deletes cache and retries once on that error. If a tester still sees it,
   click the trash can on the model row and Load again.
3. **Root-relative `/models/…` is an `Invalid URL` inside WebLLM.** Always
   pass absolute same-origin URLs.
4. **Qwen rejects `role: "tool"`.** Tool results are `user` + `<tool_response>`.
5. **Do not use WebLLM's `tools` parameter.** Hermes-only. Use structural tags.
6. **Browser automation cannot click inside the sandbox.** Drive in-page
   behavior with `run_js`.
7. **`srcdoc` assembly now replaces** `<link href="styles.css">` and
   `<script src="app.js">`. If the model writes HTML without those tags, CSS/JS
   are not injected. Starter and seed files include the tags on purpose.
8. **TypeScript 6:** do not put `baseUrl` back in `tsconfig.app.json`.
9. **Do not put `models/` in `public/`.**

## What is unverified

The last in-browser tool-loop attempt failed at **Load model** on the local
0.6B row with the HTML-as-JSON error above. That was before `b072e2a`. No one
has since:

- Loaded `Qwen3-0.6B-q4f16_1-MLC (local)` to `ready`
- Run “make the background blue”
- Run “add a button that alerts hi”
- Built the coffee-shop landing page on the 1.5B coder
- Followed up with “make the header sticky”
- Traced `pnpm cdp:trace --url "http://localhost:5174/?model=Qwen3-0.6B-q4f16_1-MLC&autoload=1"`

Do that before changing tool format or prompts. Acceptance for M3 is ~9/10
valid pages in one round; that measurement decides JSON vs `any_text`.

## First hour

1. Reload http://localhost:5174/. Pick **Qwen3 0.6B · Fast / Local mirror**.
2. Load. If you get `Unexpected token '<'`, delete cache and Load again.
3. Send the two M3 prompts. Watch for a `write_file` card and a real preview
   change. Prefer `run_js` over trying to click the iframe.
4. Only then load the 1.5B coder and try the coffee-shop page.

Useful CDP once load works:

```
pnpm cdp:trace --url "http://localhost:5174/?model=Qwen3-0.6B-q4f16_1-MLC&autoload=1"
```

`window.__llmcoder` reports `{ phase, model, progress, error, generating }`.
The tracer waits for `phase === "ready"` before typing.

## Known incompleteness (do not “fix” blindly)

- `chatPrompt` in `src/llm/prompts.ts` is unused. The agent always uses
  `pageBuilderPrompt`. Fine until someone wants a no-tools chat mode.
- Early-exit after `write_file` helps small models stop looping. It can also
  stop a multi-file page mid-turn if the model writes HTML first and CSS later
  in a later round — the smart-model `styles.css` guard exists for that case
  only.
- `index.html` title is still “llmcoder”. Repo name ≠ product name.
- No test suite. No GitHub remote. Do not `git push` unless asked, and check
  `git remote -v` first (empty today).
- PLAN.md §1 and the 7B “partial mirror” note are stale.

## If you change one thing

Verify the fast-model tool loop. Everything else in the plan is downstream of
whether JSON `write_file` actually produces a page.
