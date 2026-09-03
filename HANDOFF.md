# Handoff — 2026-09-03

You are taking over **Mote** (`llmcoder`): a browser-only coding agent where a
local WebLLM model edits an HTML/CSS/JS project that renders in a sandboxed
iframe. `PLAN.md` is the spec, `AGENTS.md` the constraints. This file is what
is true on disk right now, what was measured, and what to do next.

## Snapshot

- `main`, deployed to **Cloudflare Workers static assets** at
  `https://mote.jonjaques.com`. Package manager **pnpm**.
- `pnpm build` (tsc + vite), `pnpm test` (vitest, 97 tests including the replay
  fixtures) and `pnpm lint` (only the pre-existing shadcn fast-refresh warnings)
  are green.
- **The agent work is the most recent layer**: six tools instead of five,
  prettier on every write, project checks after a writing round, a runtime
  experiment surface, raw transcripts, a replay suite, and a harness rebuilt
  around variants and fixtures. Read "Tool loop" and "Harness" below before
  changing any of it, and the landmines before changing a tool result string —
  several of them are measured wording, not opinion.
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
trigger on `<tool_call>` and on a Markdown fence (and, off by default, on a bare
`{"name":…}` object); `at_least_one` on the first round; tool blocks executed as
soon as they are whole while the stream continues; a read-before-overwrite rule
for edited files; a repeat guard for inspection loops; Stop keeps what ran and
starts nothing more; Continue on `finish_reason === "length"`; usage stats from
the final chunk.

Six tools now: `write_file`, `edit_file`, `read_file`, `list_files`, `run_js`,
`get_dom`. `edit_file` replaces one exact passage, matching exactly first and
then with whitespace treated as elastic — a model reproducing a block from memory
gets the indentation wrong far more often than the words.

**Everything a tool writes is formatted** (`src/llm/format.ts`, prettier 3.9
loaded lazily in the tab, ~264 KB gzipped across five chunks, on the first write
and never at boot). That is half cosmetic and half the point: `format` is the
only parser in the project, so CSS and JavaScript that cannot be parsed throw
with a line and a column, and a broken write becomes a failed tool call with one
precise sentence instead of a page the model reports as done. HTML is different —
prettier repairs mis-nested tags and never raises, but leaves an unparseable
inline `<script>` alone, so those are parsed separately and reported in
whole-file coordinates. ⌘S in the editor goes through the same formatter.

**The project is checked after a writing round** (`src/llm/verify.ts`): a page
that references a file nobody wrote or that is still the untouched starter, and
classes styled but never applied. Findings go back as one `<tool_response>`, once
per turn. This replaced the model-family special case (`smartPageNeedsStyles`).

**The experiment surface** (`src/llm/config.ts`). Ten knobs — prompt override,
sampling, round budget, enabled tools, triggers, formatting, verification,
history compaction, the refusal shape, the project inventory — patched at runtime
through `window.__llmcoder.setConfig`. Nothing in `src/ui` reads it; the defaults
are what ships. `src/llm/transcript.ts` keeps the raw output of the last twenty
runs, which is what the harness saves and `pnpm replay` re-runs.

**Chat.** Live status line ("Writing index.html · 1.8 KB · 14s"), a box that
streams the model's raw output including the tool payload, a stats line
(seconds, tokens, tok/s, rounds), tool cards that link paths to the editor
and show run_js code, results, console lines and runtime errors, Clear
context, New session, Esc to stop, chat and project persisted in
`localStorage`.

**Automation** (`src/automation.ts`). `window.__llmcoder` carries `phase`,
`model`, `progress`, `error`, `generating` plus `send(text)`, `stop()`,
`getMessages()`, `clearChat()`, `getProject()`, `setProject(files)`,
`resetProject()`, `seedProject()`, `runInSandbox(code)`, `getConsole()`,
`getConfig()`, `setConfig(patch)`, `resetConfig()`, `getTranscripts()` and
`clearTranscripts()`.

**Harness** (`scripts/cdp-agent.mjs`, scenarios in `scripts/eval-scenarios.mjs`,
arms in `scripts/eval-variants.mjs`, plumbing in `scripts/cdp.mjs`).
`pnpm cdp:agent --scenario <names|group> --variant <names> --trials N
[--model id] [--compare report.json] [--prompt "…"] [--headless] [--keep-open]`.
Launches Chrome with its own profile (`.cdp-profile/`, weights cached there),
autoloads the model, drives the app only through `window.__llmcoder`, probes the
rendered sandbox through the bridge, and writes `cdp-report*.json` plus one raw
transcript per step under `evals/transcripts/`.

The unit of work is a (scenario, variant, trial). A **variant** is a patch over
`src/llm/config.ts` applied through the automation bridge between steps, so every
arm of an experiment runs against one Chrome with one model already on the GPU —
the alternative was editing `src/`, which reloads the page and throws away a load
that costs a minute and up to 4.4 GB. Trials are the outer loop, so an
interrupted run is still balanced and the report is written after every one.
Scenarios can start from a **fixture** project: "make the header sticky" used to
require building a coffee-shop page first, and now runs against a fixed page in
twenty seconds. Checks are **named**, so the summary's `what failed` column reads
`alerts ×4` rather than a pass rate. `--compare` prints a run against an earlier
report. It survives a page reload mid-run (the trial fails, the run continues)
and prints `!! target crashed` when the Inspector domain reports one.

**Colour.** Four signal channels (`--signal-live` cyan / `--signal-write`
green / `--signal-read` blue / `--signal-net` gold), applied through
`.channel-*` classes that set a local `--channel`. Tool cards carry the
channel of their tool, so a round of inspection no longer looks like a
rewrite; the load bar runs gold while shards arrive from Hugging Face and
cyan once they go to the GPU (the local mirror stays cyan — those bytes never
leave the machine); the file tree tints icons by type and dots authored files
green; the editor ships its own `HighlightStyle` instead of CodeMirror's.
Documented in `DESIGN.md` > Colors, and `detect.mjs` reports no findings.

**Unit suite.** `vitest` + `happy-dom`, tests beside the sources: tool parsing
and scanning, edit matching, formatting and its syntax errors, the project
checks, the agent loop against a scripted engine, srcdoc assembly, the virtual
filesystem, the model catalog.

**Replay** (`pnpm replay`, `src/llm/replay.test.ts`). Curated real transcripts in
`evals/fixtures/` are re-run through the tool layer with no GPU: every round must
still parse into the same calls, and the loop must still reach the same files. It
takes a second, and it is the regression net under any change to the scanner, the
formatter or a tool result. What it cannot check is a model's *reaction* to a
change — those rounds were conditioned on the tool responses of the day, so
prompts and tool descriptions still need `pnpm cdp:agent`.

## Production hardening (this branch)

Everything below was added for the public deploy and verified in a real Chrome
against `pnpm preview`, not only in tests.

**Identity.** `assets/mark.svg` is the brand symbol from `DESIGN.md` — frame,
two corner cells, one lit core — and `pnpm assets` rasterises it into the
favicon, the three PWA icons and `public/og.png` (1200×630) with headless
Chrome. The starter template's purple bolt and its social-icon sheet are gone.
`index.html` carries the title, description, canonical, Open Graph and Twitter
tags pointing at the production origin.

**Analytics.** `analytics()` in `vite.config.ts` injects the gtag pair only when
`GA_MEASUREMENT_ID` is set at build time and matches `G-XXXXXXXXXX`. Verified
both ways: with the variable the tag is in `dist/index.html`, without it the
built HTML contains no reference to googletagmanager and `window.gtag` is
`undefined` in the browser. Three events are sent (`model_loaded`,
`model_load_failed`, `preflight_failed`), carrying model ids and durations only.

**The mirror is dev-only.** `loadLocalRecords()` short-circuits on
`import.meta.env.DEV`; a production build never requests `/models/index.json`.
There is a test asserting `fetch` is not called.

**The whole catalog.** The picker now offers all 159 prebuilt chat models
(embeddings excluded — they throw on `reload`), each row showing the real id,
its quantisation, VRAM, `1k context` where that applies, and its role. Rows are
grouped by what the device can hold: on this machine 3 recommended, 144 fitting,
9 tight, 3 disabled as beyond it. The budget is inferred from
`navigator.deviceMemory` at 75% (6 GB here, matching the figure the 7B was
measured against) and the adapter line states it. Two findings came out of
building it: only 29 of the 85 `f16` records declare `shader-f16`, so fit is
decided by the quantisation string instead; and six ids in the Phi family carry
no size token at all, so their parameter counts are a small explicit table.

**Default selection.** `chooseDefaultModel` prefers an explicit `?model=` or the
remembered id, then the largest cached model, then the *starter* — the smallest
proven model that still builds whole pages (the 1.5B coder, 830 MB), not the
most capable one. `Best fit` in the readout names the 7B and selects it in one
click. `?model=&autoload=1` is unchanged, so both harness scripts still work.

**PWA and service worker.** `src/sw.js` is emitted to `dist/sw.js` with a
precache manifest and a content-addressed build id. Navigations are network
first with the cached shell as the offline answer; `/assets/*` is cache-first;
icons and fonts are stale-while-revalidate. Cross-origin URLs, `/models/*` and
range requests are never handled, so nothing sits in front of a weight fetch.
Verified: with the preview server killed, a reload rendered the full shell from
cache; `parent.document` and `localStorage` still throw `SecurityError` inside
the sandbox; pressing "Update ready" swapped the waiting worker, reloaded, and
deleted the previous caches.

**Cloudflare.** `public/_headers` carries HSTS, nosniff, frame denial,
referrer policy, COOP, a permissions policy, immutable caching for `/assets/*`
and `must-revalidate` for `/sw.js`. `.node-version`, `packageManager`,
`robots.txt`, `sitemap.xml` and `manifest.webmanifest` round it out.

## Measurements

One trial = one fresh project. The first block predates the agent work below and
used the two-step coffee → sticky shape; the second block uses the fixture-based
`sticky` scenario, which starts from a fixed, larger page and is harder.

| Scenario | Model | Result | Notes |
|---|---|---|---|
| "make the background blue" ×10 | 0.6B | 10/10 | one round, ~1 s |
| "add a button that alerts hi" ×10 | 0.6B | 9/10 | one round; the miss rendered no button |
| coffee-shop page ×5 | 1.5B | 4/5 | two-file pages; the miss lacked a menu |
| "make the header sticky" ×5 | 1.5B | 1/5 | `run_js` used as an editor 3×; one CSS rewrite with no sticky rule |
| coffee-shop page ×5 | 7B | 4/5 | three files in one round, 52–136 s; one trial lost to a tab reload |
| "make the header sticky" ×5 | 7B | 4/5 | write refused → read → rewrite, stylesheet preserved; the miss added a `.sticky` rule without applying the class |

After the agent work (six tools, formatting, project checks, the new harness):

| Scenario | Model | Result | Notes |
|---|---|---|---|
| `blue` ×10 | 0.6B | 10/10 | one round |
| `alert` ×10 | 0.6B | 8/10 | one miss rendered no script, one write never parsed |
| `m3` ×10 | 0.6B | 6/10 | both steps must pass in one trial; `blue` never failed |
| `m3` ×10, baseline vs `no-edit` | 0.6B | 4/10 vs 7/10 | measured before several of the fixes below, but the direction held |
| `sticky` ×6, baseline vs `no-edit` | 1.5B | 0/6 vs 0/6 | it rewrites `index.html` and never writes a rule; `pinned` failed every trial in both arms |
| `sticky` ×4, baseline vs `no-edit` | 7B | 1/4 vs 1/3 | three baseline trials hit the 300 s cap re-sending an edit for a stylesheet it had invented |

Decisions these numbers settled:

- M3 acceptance is met with JSON-string `write_file`; the `any_text` fallback in
  PLAN §5.4 was not needed.
- The 0.6B rewrites `index.html` wholesale rather than editing `styles.css`.
  Inside the bar, but it drops the starter stylesheet and script.
- A stricter prompt demanding one self-contained `index.html` was tried and
  reverted: the 1.5B styled better but dropped requested sections in 2 of 3
  runs. It survives as the `single-file` variant, still unmeasured at n≥5.
- The read-before-overwrite rule is what turned the 7B follow-up from
  "replace the stylesheet with one rule" into a real edit. Answering that
  refusal with the file collapses it from three rounds to two.
- **`edit_file` is not free.** The 0.6B is worse with it in the list, and it is
  what the 7B reaches for first. It is enabled for every model because the
  cross-over is unmeasured; `--variant baseline,no-edit` is how to settle it,
  and a size-gated default (as `PAGE_BUILDER_MIN_PARAMS_B` already does for
  model selection) is the obvious shape if the 0.6B result holds up at n≥30.
- Nothing has been measured with `verifyWrites: false`, `compactHistory: false`,
  `projectInventory: false` or `triggers: bare` at a useful n. Those variants
  exist; the numbers do not.

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
10. **A host CSP with `script-src` kills the sandbox, silently.** A policy on
   the host document is inherited by srcdoc children. Measured against the real
   iframe attributes and the real sandbox CSP: with no header, inline script and
   `new Function` run; with `default-src 'self'; script-src 'self'`, the frame
   goes dead with nothing in the console the host can see; with
   `object-src 'none'; base-uri 'self'; frame-ancestors 'none';
   form-action 'self'`, everything runs. `public/_headers` ships the third.
11. **A service worker sits in front of the weight fetches too.** Workers created
   by a controlled page are controlled. `sw.js` therefore handles same-origin
   GETs only and never `/models/*`, cross-origin, or range requests. A broad
   runtime-caching rule would duplicate gigabytes into a second cache and evict
   the one WebLLM reads.
12. **`vite preview` defaults to port 4173, and so does every other Vite app.**
   Testing the built app there registers Mote's worker on an origin another
   project may already own (a foreign `inertialref-v1` cache was sitting in it),
   which is why the first load showed "Update ready" — correctly. Unregister
   when done, or preview on a port of your own.
13. **A prompt sentence can be worth three points of pass rate.** Rewriting the
   rules list and losing "You may replace index.html with a full document
   containing inline CSS and JavaScript" took the 0.6B from 9/10 to 0/10 on
   `alert`: it rendered the button every time and wrote no script at all. The
   sentence is back, with a comment saying not to tidy it away.
14. **A compacted assistant turn gets imitated.** Replacing the file payload in
   the model's own last turn with `<1177 characters, sent>` taught the 1.5B to
   send exactly that string as file content — 4 of 12 trials, and once it
   started it did it every round. Compaction now runs one turn behind: the
   newest assistant turn is always verbatim.
15. **A failing write has to count as a repeat.** The repeat record was cleared
   on any write, so a write that failed was never a repeat and the 0.6B sent
   the same 132 bytes of `onclick='alert('hi')'` eight times. It is cleared
   only when a write succeeds.
16. **A refusal that hands over the file must record that as a read**, or the
   retry is refused again and the turn spends every round being handed the same
   file. And it must say the change still has to be made: "Here it is. Write it
   again in full" got the file echoed back byte-for-byte with nothing changed,
   which is why a write that changes nothing is now itself refused.
17. **A tool result is a prompt.** Two measured failures were pure wording:
   "Call read_file and copy the exact text" while the file was attached to the
   same message, and an edit-miss that never said the content was in `result`.
   Both had models re-sending an identical failing call until the repeat guard
   stopped them.
18. **`edit_file` misses are usually not a matching problem.** The 1.5B edits
   `<header>` in a page whose header is `<header class="site-header">`; the 7B
   invents `/* Add your styles here */` for a stylesheet it never read. Four
   passes of decreasing strictness (exact, spacing, packing, prettier-formatted)
   cover the formatting differences; the rest is answered by naming the closest
   line and attaching the file.
19. **A trial can be lost to a page reload that is nobody's fault.** Neither
   Vite (a root markdown edit does not reload — measured) nor a reported crash.
   The harness retries such a step once and records it as `void`, out of the
   pass rate, so the machine's bad minute does not land in the model's column.
20. Still true from earlier: `resolve/main/` in local records, JSON 404 for
   mirror misses, absolute same-origin URLs, `user` + `<tool_response>` for
   Qwen, no `baseUrl`, no `models/` in `public/`, `.cdp-profile/` and
   `models/` ignored by Vite's watcher.

## Unverified

- Nothing was measured against Hugging Face-served records; every run used
  the local mirror. The deployed path is exactly the unmeasured one.
- The service worker, the offline shell and the update swap were verified
  against `vite preview` on this machine, not against Cloudflare's edge. The
  `_headers` file has never been applied by a real deploy.
- No model has been loaded from a device without `shader-f16`, so the "blocked"
  tier is reasoned from the quantisation, not observed.
- The PWA was checked as installable (manifest, icons, scope) but never actually
  installed to a home screen.
- Continue (`finish_reason === "length"`) was never triggered by a harness
  prompt.
- The formatter has never run against a page large enough to be slow; the
  measured cost is 1–13 ms, on pages of one to six kilobytes.
- The prettier chunks are in the precache manifest (they match `\.js$`), so the
  offline shell downloads ~264 KB more on install than it did. Nothing has been
  measured about that install.
- The stacked layout was checked by screenshot at 390 and 760 px, not on a
  device; the model menu and the editor were not tried on touch.

## Next

1. **Settle `edit_file` by model size.** The 0.6B is worse with it in the list
   (4/10 vs 7/10 on `m3`, n=10, before later fixes); the 7B reaches for it first
   and now passes `sticky` 2/3 with it. Run `--scenario m3 --variant
   baseline,no-edit --trials 30` and `--scenario sticky --variant
   baseline,no-edit --trials 8 --model …7B…`; if both hold, gate the default
   tool list on parameter count the way model selection already does.
2. **Measure the variants nothing has numbers for**: `no-verify`, `no-compact`,
   `no-inventory`, `bare`, `single-file`. Each is a default this session chose on
   reasoning plus one or two trials, which is not the standard the rest of the
   repo holds itself to.
3. **`sticky` on the 1.5B is 0/6** and worth understanding: it rewrites
   `index.html` instead of touching the stylesheet, and the new used-but-unstyled
   finding was added for exactly that but has not been measured at n≥6 since.
4. **The intermittent page reload is still unexplained** (landmine 3) and still
   costs trials — now visible as `VOID` rather than as a mysterious failure. It
   reproduced during a 7B run with nothing else loaded, so the "another Chrome
   had a model in GPU memory" theory is dead.
2. **The initial payload is 2.3 MB gzipped and ships twice.** `@mlc-ai/web-llm`
   is imported on the main thread (engine + `prebuiltAppConfig`) and again in
   the worker chunk, so a first visit downloads ~4.6 MB of JavaScript before
   anything renders. FCP is 124 ms warm on this machine, so it is a cold-start
   cost only. Fixing it means splitting the device probe out of `models.ts`
   (it is the reason `state.tsx` pulls the library in at all) and importing the
   engine and catalog dynamically after first paint. Measure before and after,
   and re-run `pnpm cdp:agent` — the autoload path is timing-sensitive.
3. Reproduce landmine 3 with `pnpm cdp:agent --scenario coffee --trials 3
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
6. `chatPrompt` was unused and is gone; `isPageBuilderModel` went with it when
   the project checks replaced the stylesheet special case.
