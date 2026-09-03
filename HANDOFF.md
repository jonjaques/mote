# Handoff — 2026-09-02

You are taking over **Mote** (`llmcoder`): a browser-only coding agent where a
local WebLLM model edits an HTML/CSS/JS project that renders in a sandboxed
iframe. `PLAN.md` is the spec, `AGENTS.md` the constraints. This file is what
is true on disk right now, what was measured, and what to do next.

## Snapshot

- Branch `main`, no remote. Package manager **pnpm**.
- `pnpm build` (tsc + vite), `pnpm test` (vitest, 49 tests) and `pnpm lint`
  (only the pre-existing shadcn fast-refresh warnings) are green.
- Dev server: `pnpm dev --port 5180 --strictPort` → http://localhost:5180/.
  Other agents on this machine use 5173/5174.
- Local mirrors in `./models/` (gitignored), all verified complete with
  `pnpm models verify <id>`:

| model_id | Role | Size | Context |
|---|---|---|---|
| `Qwen3-0.6B-q4f16_1-MLC` | fast / tests | 320 MB | 4096 |
| `Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC` | smart / simple pages | 830 MB | 8192 |
| `Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` | page builder | 4.4 GB | 8192 |

The 7B is the one that builds and edits pages reliably. It needs 5.1 GB of
the 6 GB VRAM budget and 50–140 s per page on this machine.

## What exists

All five PLAN milestones are implemented and measured.

**Runtime.** Worker engine, picker over local mirror ∪ Hugging Face records
(grouped, with VRAM and cache state), progress, storage estimate, VRAM and
feature guards, `?model=&autoload=1`, and the last loaded model is remembered
and loaded again on the next visit when its weights are cached.

**Sandbox.** Opaque-origin iframe (`allow-scripts allow-forms`, no
`allow-same-origin`), strict CSP with `form-action 'none'`, host/iframe
bridge, Preview (desktop / 390 px widths, Reload), Files (CodeMirror editor,
Save with ⌘S, Discard), Console (with an error badge on the tab), Export as
zip, dev-only Seed, inline-confirmed Reset. `alert`/`confirm`/`prompt` inside
the sandbox become an in-page toast plus a console line; an unhandled form
submit is reported the same way instead of vanishing.

**Tool loop** (`src/llm/agent.ts`, `src/llm/tools.ts`). Structural tags that
trigger on `<tool_call>` and on a Markdown fence; `at_least_one` on the first
round; tool blocks executed as soon as they are whole while the stream
continues; a read-before-overwrite rule for edited files; a repeat guard for
inspection loops; Stop keeps what ran and starts nothing more; Continue on
`finish_reason === "length"`; usage stats from the final chunk.

**Chat.** Live status line ("Writing index.html · 1.8 KB · 14s"), a box that
streams the model's raw output including the tool payload, a stats line
(seconds, tokens, tok/s, rounds), tool cards that link paths to the editor
and show run_js code, results, console lines and runtime errors, Clear
context, New session, Esc to stop, chat and project persisted in
`localStorage`.

**Automation** (`src/automation.ts`). `window.__llmcoder` carries `phase`,
`model`, `progress`, `error`, `generating` plus `send(text)`, `stop()`,
`getMessages()`, `clearChat()`, `getProject()`, `resetProject()`,
`seedProject()`, `runInSandbox(code)`, `getConsole()`.

**Harness** (`scripts/cdp-agent.mjs`, plumbing in `scripts/cdp.mjs`).
`pnpm cdp:agent --scenario blue|alert|m3|coffee|all --trials N [--model id]
[--prompt "…"] [--headless] [--keep-open]`. Launches a visible Chrome with
its own profile (`.cdp-profile/`, weights cached there), autoloads the model,
drives the app only through `window.__llmcoder`, probes the rendered sandbox
through the bridge, and writes `cdp-report*.json`. It survives a page reload
mid-run (the trial fails, the run continues) and prints `!! target crashed`
when the Inspector domain reports one.

**Colour.** Four signal channels (`--signal-live` cyan / `--signal-write`
green / `--signal-read` blue / `--signal-net` gold), applied through
`.channel-*` classes that set a local `--channel`. Tool cards carry the
channel of their tool, so a round of inspection no longer looks like a
rewrite; the load bar runs gold while shards arrive from Hugging Face and
cyan once they go to the GPU (the local mirror stays cyan — those bytes never
leave the machine); the file tree tints icons by type and dots authored files
green; the editor ships its own `HighlightStyle` instead of CodeMirror's.
Documented in `DESIGN.md` > Colors, and `detect.mjs` reports no findings.

**Unit suite.** `vitest` + `happy-dom`, tests beside the sources: tool
parsing and scanning, the agent loop against a scripted engine, srcdoc
assembly, the virtual filesystem, the model catalog.

## Measurements

Final configuration unless noted. One trial = one fresh project.

| Scenario | Model | Result | Notes |
|---|---|---|---|
| "make the background blue" ×10 | 0.6B | 10/10 | one round, ~1 s |
| "add a button that alerts hi" ×10 | 0.6B | 9/10 | one round; the miss rendered no button |
| coffee-shop page ×5 | 1.5B | 4/5 | two-file pages; the miss lacked a menu |
| "make the header sticky" ×5 | 1.5B | 1/5 | `run_js` used as an editor 3×; one CSS rewrite with no sticky rule |
| coffee-shop page ×5 | 7B | 4/5 | three files in one round, 52–136 s; one trial lost to a tab reload |
| "make the header sticky" ×5 | 7B | 4/5 | write refused → read → rewrite, stylesheet preserved; the miss added a `.sticky` rule without applying the class |

Decisions these numbers settled:

- M3 acceptance (9/10 valid pages in one round) is met with JSON-string
  `write_file`; the `any_text` fallback in PLAN §5.4 was not needed.
- The 0.6B rewrites `index.html` wholesale rather than editing `styles.css`.
  Inside the bar, but it drops the starter stylesheet and script.
- A stricter prompt demanding one self-contained `index.html` was tried and
  reverted: the 1.5B styled better but dropped requested sections in 2 of 3
  runs. `pageBuilderPrompt` is the original shape plus inspection-only
  `run_js` and read-before-edit.
- The read-before-overwrite rule is what turned the 7B follow-up from
  "replace the stylesheet with one rule" into a real edit.

## Landmines that already cost time

1. **React Compiler memoises render-time reads of singletons.** A `useMemo`
   that reads `projectFS` and never references a reactive value runs once and
   the preview freezes on the first document. Derive everything from
   `useSyncExternalStore(projectFS.subscribe, projectFS.getSnapshot)`. The
   harness shows a regression as identical probe values in every trial.
2. **Editing `src/` during a harness run reloads the page under it.** Wait
   for `report written`. Markdown edits are safe.
3. **Intermittent tab reload during 7B generation.** Twice the harness tab
   came back fresh a few seconds into a 7B generation: no Vite reload logged,
   no crash report on disk, no `!! target crashed` (the Inspector domain was
   enabled only after the second time). Both times another Chrome on the
   machine also had a model in GPU memory. Looks like a renderer crash plus
   Chrome's auto-reload of a visible tab. Unresolved; reproduce with the
   Inspector hook armed and nothing else loaded.
4. **A refreshed harness tab loses the run**, and an interrupted run leaves
   Chrome holding the profile. `pkill -f cdp-profile` before the next run.
5. **`tools` throws for non-Hermes models** in WebLLM 0.2.84. Structural tags
   are the supported path; the code follows the official example.
6. **Missing `tensor-cache.json`** in a mirror surfaces as
   `Failed to execute 'add' on 'Cache': Request failed`.
7. **Node 22+ predefines an undefined `localStorage` global** that vitest's
   DOM environment will not replace; `src/test-setup.ts` polyfills it.
8. **`theme="dark"` on `<CodeMirror>` silently overrides the syntax palette.**
   It injects the library's own highlight style — magenta tags, orange
   strings — on top of any `EditorView.theme`, because a theme only styles
   chrome and a `HighlightStyle` is a separate extension. That is where the
   editor's foreign palette came from; `FilesView` now passes `theme="none"`
   and supplies `syntaxHighlighting(highlight)`. `@codemirror/language` and
   `@lezer/highlight` are direct dependencies for this reason — pnpm's strict
   layout will not resolve them transitively.
9. **A conditionally mounted view panel loses its local state.** `FilesView`
   holds the unsaved editor draft in `useState`, so while the workspace
   mounted panels on `view === id`, switching to Preview and back silently
   discarded an in-progress edit. Files and Console now mount on first open
   and stay mounted, hiding with `visibility` the way the preview iframe
   always has. Anything added to that section must do the same.
10. Still true from earlier: `resolve/main/` in local records, JSON 404 for
   mirror misses, absolute same-origin URLs, `user` + `<tool_response>` for
   Qwen, no `baseUrl`, no `models/` in `public/`, `.cdp-profile/` and
   `models/` ignored by Vite's watcher.

## Unverified

- Nothing was measured against Hugging Face-served records; every run used
  the local mirror.
- Continue (`finish_reason === "length"`) was never triggered by a harness
  prompt.
- The stacked layout was checked by screenshot at 390 and 760 px, not on a
  device; the model menu and the editor were not tried on touch.

## Next

1. Reproduce landmine 3 with `pnpm cdp:agent --scenario coffee --trials 3
   --model Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` and no other model loaded
   anywhere. If `!! target crashed` prints, it is memory; consider lowering
   the 7B's context override or unloading before a switch.
2. Make the 7B the default when its mirror is present (`SMART_MODEL_ID` or a
   new default in `src/llm/models.ts`); it is the model that works.
3. For the 1.5B follow-up failure, the remaining lever is a `write_file`
   nudge in the `run_js` result when the code mutates the DOM (`classList`,
   `.style`, `innerHTML`). Measure before keeping it.
4. For the 7B miss (CSS class never applied), a post-write check that new
   class selectors in `styles.css` appear in `index.html` could feed a hint
   back as a tool result. Measure before keeping it.
5. Interface not done: Markdown in replies, a diff view for tool writes, file
   create/delete in the editor, cancelling a model load (WebLLM has no cancel;
   `unload()` after). Do not add "open preview in a new tab": a blob URL
   escapes the opaque origin.
6. `chatPrompt` in `src/llm/prompts.ts` is unused.
