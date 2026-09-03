# Handoff — 2026-09-02 (evening)

You are taking over **Mote** (`llmcoder`). The product spec is `PLAN.md`. The
constraints that are easy to violate are `AGENTS.md`. Read both before editing.
This file is only what is true on disk right now, what was measured, and what
to do next.

## Snapshot

- Branch: `main`. No remote. Package manager is **pnpm**.
- Dev server: `pnpm dev --port 5180 --strictPort` → http://localhost:5180/.
  Another agent on this machine uses 5173/5174; keep 5180.
- `pnpm build` (tsc + vite) and `pnpm test` (vitest, 49 tests) are green; `pnpm lint`
  reports only the pre-existing shadcn fast-refresh warnings.
- Local mirrors in `./models/` (gitignored), all three verified complete with
  `pnpm models verify <id>`: `Qwen3-0.6B-q4f16_1-MLC` (fast),
  `Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC` (smart),
  `Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` (step-up, 4.4 GB).

## What changed today

1. **Automation API.** `window.__llmcoder` (`src/automation.ts`) now carries
   methods next to the status fields: `send(text)` → `AutomationRun`,
   `stop()`, `getMessages()`, `clearChat()`, `getProject()`,
   `resetProject()`, `seedProject()`, `runInSandbox(code)`, `getConsole()`.
   `pnpm cdp:trace` still reads `phase` / `error` / `generating`.
2. **Headed harness.** `pnpm cdp:agent --scenario m3|coffee|all --trials N`
   (`scripts/cdp-agent.mjs`, shared plumbing in `scripts/cdp.mjs`) drives the
   real app in a visible Chrome, probes the rendered sandbox through the
   bridge, and writes `cdp-report*.json`. `--model <id>` overrides the model,
   `--prompt "…"` runs ad hoc prompts, `--headless` hides the window.
3. **Sandbox fixes found by the harness.**
   - The iframe is keyed on the project revision and attached in a layout
     effect. Before, an unchanged `srcdoc` string never reloaded and the
     bridge waited forever for `ready` (Reset when already reset, or a model
     rewriting a file with identical content).
   - `script-src` now includes `'unsafe-eval'`. `run_js` had never worked:
     the runtime uses `new Function(code)` and every call threw an EvalError.
   - `assembleDocument` moved to `src/sandbox/document.ts` and takes the
     store snapshot. `Sandbox` and `FilesView` subscribe with
     `projectFS.getSnapshot`. See the React Compiler landmine below.
4. **Tool loop.**
   - Structural tag triggers on `<tool_call>` **and** on a Markdown fence.
     Qwen2.5-Coder emits ```` ```json ```` calls; unconstrained, that JSON
     carries raw newlines and cannot be parsed, so whole pages were discarded.
   - `at_least_one: true` on the first round only (the official
     `structural-tag-tool-use` example does this on its tool turn). Later
     rounds stay free so a summary can end the turn.
   - Repeat guard: a round made only of inspection calls already answered
     since the last `write_file` gets one nudge, then the turn stops. This
     ended the `run_js` and `read_file` cycles that burned all eight rounds.
   - Fenced JSON that is not a registered call is prose, not a parse error.
5. **Models.** The local mirror's smart-model record never received the 8192
   context override (the lookup ran after the ` (local)` suffix was added).
   Fixed; a unit test pins it.
6. **Vite.** `server.watch.ignored` covers `.cdp-profile/` and `models/`.
   Chrome writes into its profile constantly and each write was a full page
   reload in the middle of a run.
7. **Unit suite.** `vitest` + `happy-dom`; tests beside the sources
   (`*.test.ts`), `src/test-setup.ts` polyfills `localStorage` because Node
   22+ ships an undefined `localStorage` global that the DOM environment will
   not overwrite.
8. Page title is “Mote”. `PLAN.md` §1/§3/§4 refreshed.
9. **Eager tool execution.** `scanToolBlocks` in `src/llm/tools.ts` walks the
   growing stream (string-aware, so braces and fences inside file content
   cannot end a block early). The agent runs each call the moment its object
   is whole; a 7B page written as three files lands in the preview one file
   at a time. A whole object whose closing tag never arrived still counts.
   Stop keeps what already ran and starts nothing more.
10. **Interface** (`e947d28`): last model remembered and auto-loaded when
    cached; live status line + raw stream box under the pending reply
    (`src/llm/stream.ts` is the per-token buffer, outside React state); stats
    line (seconds, tokens, tok/s, rounds); Clear context / New session; Esc
    stops; tool cards link paths to the editor and show run_js code, results
    and runtime errors; CodeMirror editor with Save (⌘S) / Discard; preview
    width toggle and Reload; inline confirmations; grouped model menu; version
    from `package.json`. Sandbox `alert`/`confirm`/`prompt` become a toast
    plus a console line; `allow-forms` + `form-action 'none'` turn a submit
    into feedback instead of nothing.

## Measurements (all with the final configuration unless noted)

| Scenario | Model | Result | Notes |
|---|---|---|---|
| M3 “make the background blue” ×10 | 0.6B | 10/10 | one round each, ~1 s; re-measured with the final loop and interface |
| M3 “add a button that alerts hi” ×10 | 0.6B | 9/10 | one round each; the miss rendered no button |
| M4 coffee-shop page ×5 | 1.5B | 4/5 pages | two-file pages; the miss lacked a menu |
| M4 “make the header sticky” ×5 | 1.5B | 1/5 | 3× `run_js` used as an editor, 1× rewrote `styles.css` without a sticky rule |
| M4 coffee-shop page ×3 (+2 final) | 7B | 3/3, then 1/2 | writes all three files in one round; 52–136 s per page. One final trial was lost to the tab reloading mid-generation (see landmines) |
| M4 “make the header sticky” ×3 (+2 final) | 7B | 3/3, then 1/2 | overwrite rule: write refused → read → rewrite, stylesheet preserved 100%. The miss appended a `.sticky` rule without applying the class in the HTML |

The M3 acceptance (9/10 valid pages in one round) is met with the JSON
`write_file` format; the `any_text` fallback in PLAN §5.4 was not needed. The
0.6B rewrites `index.html` wholesale rather than editing `styles.css`, which
is inside the M3 bar but drops the starter stylesheet and script.

A stricter prompt that demanded one self-contained `index.html` was tried and
reverted: the 1.5B produced better stylesheets but dropped requested sections
(form or heading) in 2 of 3 runs. The current `pageBuilderPrompt` is the
original shape plus two rules the runs justified (inspection-only `run_js`,
read before a follow-up write).

## Landmines that already cost time

1. **React Compiler memoises render-time reads of singletons.** A `useMemo`
   whose callback reads `projectFS` and never references a reactive value runs
   once; every later document is the first one. The harness shows this as
   identical probe values in every trial. Derive from
   `useSyncExternalStore(projectFS.subscribe, projectFS.getSnapshot)`.
2. **Chrome writes into `.cdp-profile/`** and Vite reloads the page for it
   unless the watcher ignores the directory.
3. **Editing `src/` during a harness run reloads the page under it** (Vite
   full reload for non-component modules). Wait for `report written`.
   Twice, the harness tab also came back fresh a few seconds into a **7B**
   generation with no Vite reload logged and no crash report on disk. It
   looks like a renderer crash followed by Chrome's auto-reload of a visible
   tab; both times another Chrome on the machine also had a model in GPU
   memory. `scripts/cdp.mjs` now enables the Inspector domain and prints
   `!! target crashed` when it can see one. Unresolved.
4. **A refreshed harness tab loses the run.** The harness polls a promise on
   `window`; after a manual refresh it waits out `--step-timeout`. Kill the
   `cdp-agent` process and the Chrome it spawned (`pkill -f cdp-profile`)
   before starting another run, or the profile lock refuses the launch.
5. **`tools` throws for non-Hermes models** in WebLLM 0.2.84
   (`functionCallingModelIds` in `lib/index.js`). Structural tags are the
   supported path; the implementation matches the official example.
6. **The mirror must contain `tensor-cache.json`.** 0.2.84 fetches it before
   `ndarray-cache.json`; a 404 surfaces as
   `Failed to execute 'add' on 'Cache': Request failed`. `pnpm models verify`
   reports it, `pnpm models download` fetches only what is missing.
7. Everything in the previous handoff's list still applies: `resolve/main/`
   in local records, JSON 404 for mirror misses, absolute same-origin URLs,
   `user` + `<tool_response>` for Qwen, no `baseUrl`, no `models/` in `public/`.

## What is unverified

- Nothing has been measured against Hugging Face-served records; every run
  used the local mirror.
- The Continue action was not exercised (no harness prompt is long enough to
  hit `finish_reason === "length"`).
- The stacked (≤760 px) layout was checked by screenshot at 390 and 760 px,
  not on a device; the model menu and the editor were not tried on touch.

## Next

1. The 7B is the page builder that works. It has the 8192 context override
   and counts as a page-builder model; consider making it the default pick
   when the mirror is present (5.1 GB VRAM against the 6 GB budget).
2. **Read-before-overwrite rule** (`write_file` in `src/llm/tools.ts`): a
   write to a file that diverged from the starter and was not read or written
   this turn is refused with an instruction to `read_file` first. Untouched
   starter files are exempt so a fresh build costs no extra round. This is
   what turned the 7B follow-up from “replace the stylesheet with one rule”
   into a real edit.
3. For the 1.5B follow-up failure, the remaining lever is a `write_file`
   nudge in the `run_js` tool result when the code mutates the DOM
   (`classList`, `.style`, `innerHTML`). Measure it with
   `pnpm cdp:agent --scenario coffee --trials 5` before keeping it.
4. `chatPrompt` in `src/llm/prompts.ts` is still unused.
5. Interface ideas not done: Markdown in assistant replies, a diff view for
   tool writes, an "open preview in new tab" (needs a blob URL and would
   escape the opaque origin — do not), file create/delete in the editor,
   cancelling a model load (WebLLM has no cancel; `unload()` after).
