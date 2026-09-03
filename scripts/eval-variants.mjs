// Arms of an experiment. Each is a patch over `src/llm/config.ts`, applied through
// `window.__llmcoder.setConfig` between steps — no page reload, no second model load.
//
// One rule: a variant here is a question with an answer that belongs in HANDOFF.md. Anything
// permanent enough to stop asking should be folded into the default config and dropped from
// this file, and anything still listed is something this repo does not yet have numbers for.

export const VARIANTS = {
  /** Whatever ships. Always run it as the control arm; the machine is not a constant. */
  baseline: {},

  // Does replacing a passage beat rewriting the file? The 1.5B failed "make the header sticky"
  // 4 times in 5 by regenerating the stylesheet from one rule.
  'no-edit': { tools: ['write_file', 'read_file', 'list_files', 'run_js', 'get_dom'] },
  'edit-only': { tools: ['write_file', 'edit_file', 'read_file', 'list_files'] },

  // Is the formatter worth its round trip, and does reporting a syntax error back actually get
  // it fixed, or just burn a round?
  'no-format': { formatOnWrite: false },

  // Do the project findings fix pages, or argue with a model that has already stopped?
  'no-verify': { verifyWrites: false },

  // Does dropping the file payload out of the assistant turn help the second round, or lose the
  // model the thread of what it wrote?
  'no-compact': { compactHistory: false },

  // Answering the read-before-overwrite refusal with the file itself should save a round.
  'strict-refusal': { refusalIncludesFile: false },

  // Does naming the files in the prompt save a list_files round, or just cost tokens?
  'no-inventory': { projectInventory: false },

  // Small models that emit a naked {"name":…} object currently produce nothing at all.
  bare: { triggers: ['tag', 'fence', 'bare'] },

  // Sanity arms, not proposals.
  hot: { temperature: 0.7 },
  greedy: { temperature: 0 },

  // The prompt shape that was tried and reverted before this harness could compare them
  // properly: one self-contained document, no stylesheet.
  'single-file': {
    systemPrompt: `You are Mote, a coding agent inside a browser sandbox.

Build and edit one self-contained HTML document by calling tools. Put all CSS in a <style> element and all JavaScript in a <script> element inside index.html. Do not link styles.css or app.js.

Rules:
- To change the page: read_file index.html, then edit_file the exact passage that changes. Leave the rest alone.
- Use write_file only for a new page or a full rewrite; it replaces the whole file.
- Do not use frameworks, external scripts, network APIs, or server features.
- Build mobile-first, semantic, accessible interfaces with working interactions and a complete stylesheet.
- run_js and get_dom only inspect the preview; nothing they do persists.
- After tool work succeeds, stop calling tools and summarize the result in one sentence.

Available tools:
- write_file {"path": string, "content": string} — create or replace a project file.
- edit_file {"path": string, "old_text": string, "new_text": string} — replace one exact passage.
- read_file {"path": string} — read a project file.
- list_files {} — list project file paths and byte sizes.
- run_js {"code": string} — evaluate JavaScript in the rendered preview.
- get_dom {"maxChars"?: number} — return the rendered document HTML.

When the user requests a project change, begin with a tool call. Tool calls must use this exact form:
<tool_call>
{"name":"tool_name","arguments":{...}}
</tool_call>`,
  },
}
