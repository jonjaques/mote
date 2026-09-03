// The experiment surface. Every knob here is a decision that needs numbers rather than an
// opinion, and each one was a source edit away from being measurable before this file existed:
// changing a prompt meant editing `prompts.ts`, which reloads the page under the harness and
// throws away a loaded model — 4.4 GB of weights and a minute of wall clock per variant.
//
// `pnpm cdp:agent --variant a,b` now patches this singleton over the automation bridge between
// steps, so one Chrome with one loaded model measures every arm of an experiment interleaved.
// Nothing in `src/ui` reads it; the defaults are what ships.

export type ToolTrigger = 'tag' | 'fence' | 'bare'

export interface AgentConfig {
  /** Whole system prompt, replacing the one generated from the enabled tools. */
  systemPrompt?: string
  temperature: number
  maxTokens: number
  maxRounds: number
  /** Force the first round to open with a tool call (the official structural-tag example does). */
  requireFirstCall: boolean
  /** Enabled tools, in the order the generated prompt lists them. */
  tools: string[]
  /** Which wrappers arm the tool grammar. `bare` lets a naked `{"name":…}` object count. */
  triggers: ToolTrigger[]
  /** Run the formatter on every write and report a syntax error back as a failed call. */
  formatOnWrite: boolean
  /** After a writing round, check the project for broken references and feed findings back. */
  verifyWrites: boolean
  /** Replace file payloads in the assistant turns of the history with a one-line placeholder. */
  compactHistory: boolean
  /** Send the current file along with a read-before-overwrite refusal, saving a round. */
  refusalIncludesFile: boolean
  /** List the project's files and sizes in the system prompt. */
  projectInventory: boolean
}

export const ALL_TOOLS = ['write_file', 'edit_file', 'read_file', 'list_files', 'run_js', 'get_dom']

export const defaultAgentConfig: AgentConfig = {
  temperature: 0.2,
  maxTokens: 4_096,
  maxRounds: 8,
  requireFirstCall: true,
  tools: ALL_TOOLS,
  triggers: ['tag', 'fence'],
  formatOnWrite: true,
  verifyWrites: true,
  compactHistory: true,
  refusalIncludesFile: true,
  projectInventory: true,
}

let current: AgentConfig = { ...defaultAgentConfig }

export function getAgentConfig(): AgentConfig {
  return current
}

/** Shallow patch; `undefined` values are ignored so a caller can send a sparse object. */
export function setAgentConfig(patch: Partial<AgentConfig>): AgentConfig {
  const next: AgentConfig = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) Object.assign(next, { [key]: value })
  }
  // A variant that names one unknown tool would silently disable everything; fail loudly here
  // instead of two minutes later as "the model called no tools".
  const unknown = next.tools.filter((name) => !ALL_TOOLS.includes(name))
  if (unknown.length) throw new Error(`Unknown tool(s): ${unknown.join(', ')}`)
  current = next
  return current
}

export function resetAgentConfig(): AgentConfig {
  current = { ...defaultAgentConfig }
  return current
}
