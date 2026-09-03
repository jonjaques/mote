// Real model output, replayed through the tool layer with no GPU.
//
// Every other test in this directory feeds the loop text a human wrote, which is text that
// parses. The failures worth guarding against are the ones a 1.5B produces at temperature 0.2 on
// a Tuesday: a fence where a tag belonged, a closing brace that never arrived, a page with a
// ``` inside a <pre>. `pnpm cdp:agent` records those verbatim; the few that were interesting
// are curated into evals/fixtures/ and re-run here in a second, so a change to the scanner or
// the formatter is checked against what models actually emit before anything loads weights.
//
// What this cannot check is the model's reaction to a change: the recorded rounds were
// conditioned on the tool responses of the day. Prompts and tool descriptions still have to be
// measured with `pnpm cdp:agent`. This is the regression net underneath that.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { projectFS } from '@/sandbox/fs'

import { resetAgentConfig, setAgentConfig, type AgentConfig } from './config'
import { parseToolCalls } from './tools'
import type { Transcript } from './transcript'

interface Fixture {
  file: string
  scenario?: string
  variant?: string
  model?: string
  transcript: Transcript
}

// Through Vite's glob rather than node:fs: this file is compiled by the app project, which
// has DOM libs and no node types, and `pnpm build` type-checks it along with everything else.
const fixtures: Fixture[] = Object.entries(
  import.meta.glob<Omit<Fixture, 'file'>>('../../evals/fixtures/*.json', { eager: true, import: 'default' }),
).map(([file, contents]) => ({ ...contents, file: file.split('/').pop() ?? file }))

const create = vi.fn()
vi.mock('./engine', () => ({
  prepareEngine: async () => ({
    engine: { modelId: ['replay'], chat: { completions: { create } } },
    appConfig: {},
    models: [],
  }),
}))

vi.mock('@/sandbox/runtime', () => ({
  sandboxBridge: {
    getDocumentRevision: () => 0,
    waitForReloadAfter: async () => {},
    getConsoleEntries: () => [],
    run: async () => ({ type: 'mote:response', id: 'x', ok: true, result: 'null' }),
    getDom: async () => ({ type: 'mote:response', id: 'x', ok: true, result: '<html></html>' }),
  },
}))

const { runAgent } = await import('./agent')

function scriptEngine(transcript: Transcript) {
  create.mockReset()
  for (const round of transcript.rounds) {
    create.mockImplementationOnce(async () =>
      (async function* () {
        // One chunk: the scanner's streaming behaviour has its own tests, and a fixture is here
        // to check what the text means, not how it arrives.
        yield { choices: [{ delta: { content: round.raw }, finish_reason: round.finishReason ?? 'stop' }] }
      })(),
    )
  }
  // A loop that asks for more rounds than were recorded has changed its mind about when to
  // stop; answer with prose so the run ends instead of throwing on an undefined stream.
  create.mockImplementation(async () =>
    (async function* () {
      yield { choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }
    })(),
  )
}

describe.skipIf(fixtures.length === 0)('replaying recorded model output', () => {
  beforeEach(() => {
    projectFS.reset()
    resetAgentConfig()
  })

  it('has fixtures to replay', () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  for (const fixture of fixtures) {
    describe(fixture.file, () => {
      it('extracts the same tool calls the recorded run extracted', () => {
        for (const round of fixture.transcript.rounds) {
          const parsed = parseToolCalls(round.raw).map((call) => call.name)
          expect(parsed, `round ${round.round}`).toEqual(round.calls.map((call) => call.name))
        }
      })

      it('drives the loop to the same files', async () => {
        const config = fixture.transcript.config as Partial<AgentConfig>
        setAgentConfig({ tools: config.tools, triggers: config.triggers, maxRounds: config.maxRounds })
        scriptEngine(fixture.transcript)

        const result = await runAgent(fixture.transcript.input, [], { onText: () => {}, onTool: () => {} })
        expect(result.content).toBeTruthy()

        const written = new Set(
          fixture.transcript.rounds
            .flatMap((round) => round.calls)
            .filter((call) => call.ok !== false && (call.name === 'write_file' || call.name === 'edit_file'))
            .map((call) => String(call.arguments.path)),
        )
        for (const file of written) {
          expect(projectFS.list().map((entry) => entry.path)).toContain(file.replace(/^\.\//, ''))
        }
      })
    })
  }
})
