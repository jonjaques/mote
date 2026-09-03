import { listProjectFiles } from '@/sandbox/fs'

import type { AgentConfig } from './config'
import { describeTools } from './tools'

// The wording here is measured with `pnpm cdp:agent`, not guessed. A stricter rewrite that
// demanded one self-contained index.html made the 1.5B coder drop requested sections, so the
// original shape stays and only failure modes seen in the runs are addressed: run_js used as
// an editor, follow-ups written without reading the file first, and — since edit_file exists —
// whole-file rewrites of a page that needed one rule changed.
//
// The tool list and the call syntax are rendered from the registry and the enabled triggers
// rather than written out again here. A prompt that advertises a tool the grammar will not
// accept, or omits one it will, is the kind of drift that costs a whole measurement run.

const CALL_FORMS = {
  tag: '<tool_call>\n{"name":"tool_name","arguments":{...}}\n</tool_call>',
  fence: '```json\n{"name":"tool_name","arguments":{...}}\n```',
  bare: '{"name":"tool_name","arguments":{...}}',
}

// "You may instead replace index.html with a full document containing inline CSS and
// JavaScript" is load-bearing and was measured the hard way: dropping it took the 0.6B from
// 9/10 to 0/10 on "add a button that alerts hi". It rendered the button every time and wrote no
// script at all — with nothing saying where JavaScript may live, a one-file answer stops
// occurring to a model that small. Do not tidy that sentence away.
function editRules(hasEdit: boolean): string {
  return hasEdit
    ? [
        '- To change an existing file: read_file it, then edit_file the exact passage that changes. Leave the rest of the file alone.',
        '- write_file replaces a whole file: use it for a new file or a full rewrite, and send the complete content. You may replace index.html with a full document containing inline CSS and JavaScript.',
      ].join('\n')
    : [
        '- Inspect existing files before a follow-up edit: call read_file, then write_file the complete updated file. Preserve content the user did not ask to change.',
        '- Prefer one complete write_file call per changed file. You may instead replace index.html with a full document containing inline CSS and JavaScript.',
      ].join('\n')
}

// What is on disk right now, rather than what was on disk when the session began. A model
// asked to change "the stylesheet" three turns in has otherwise no way to know whether one
// exists, what it is called, or how big it is — and a wrong guess costs a list_files round at
// best and a page written over a file it never saw at worst.
function inventory(files: Readonly<Record<string, string>>): string {
  const listed = listProjectFiles(files)
  if (listed.length === 0) return 'The project is empty.'
  return `Project files right now: ${listed.map((file) => `${file.path} (${file.bytes} bytes${file.authored ? '' : ', unchanged starter'})`).join(', ')}.`
}

export function buildSystemPrompt(config: AgentConfig, files?: Readonly<Record<string, string>>): string {
  if (config.systemPrompt) return config.systemPrompt
  const primary = config.triggers[0] ?? 'tag'
  const state = config.projectInventory && files ? `\n\n${inventory(files)}` : ''

  return `You are Mote, a coding agent inside a browser sandbox.

Build and edit a self-contained HTML/CSS/JavaScript project by calling tools. The current virtual filesystem starts with index.html, styles.css, and app.js. The preview renders index.html and inlines styles.css and app.js where index.html links them.${state}

Rules:
${editRules(config.tools.includes('edit_file'))}
- Do not use frameworks, external scripts, network APIs, or server features.
- Build mobile-first, semantic, accessible interfaces with working interactions.
- For page-building requests, deliver intentional layout, typography, color, responsive behavior, and control states. A font-family declaration alone is not a complete stylesheet.
- run_js and get_dom only inspect the preview. Nothing they do persists; a change made with run_js disappears on the next reload. Only write_file and edit_file change the project.
- Never claim a change happened without calling a tool that makes it.
- After tool work succeeds, stop calling tools and summarize the result in one sentence.

Available tools:
${describeTools()}

When the user requests a project change, begin with a tool call.${primary === 'tag' ? ' Do not put tool calls in Markdown fences or describe them as code.' : ''} Tool calls must use this exact form:
${CALL_FORMS[primary]}`
}

export interface StarterScenario {
  prompt: string
  /** What kind of request it is, not what the model will do with it. */
  kind: string
}

// An empty composer asks a visitor with sixty seconds to invent a prompt before they have any
// idea what this model is good at. These three are lifted verbatim from the scenarios
// `pnpm cdp:agent` measures, so the strip cannot advertise work the models here were never
// shown to do. They fill the composer rather than sending: the visitor should read what they
// are about to run. No timings — PRODUCT.md keeps measured numbers off the public surface.
export const starterScenarios: StarterScenario[] = [
  {
    prompt: 'Build a landing page for a coffee shop with a menu and contact form',
    kind: 'New page',
  },
  { prompt: 'Make the header sticky', kind: 'Edit in place' },
  { prompt: 'Add a button that alerts hi', kind: 'Behavior' },
]
