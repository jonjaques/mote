// What the model actually said, kept so an experiment can be explained rather than just scored.
//
// A pass rate tells you a variant is worse; it never tells you that the model answered in a
// Markdown fence, invented a sixth tool, or spent 900 tokens apologising before its first call.
// The harness pulls this after every step and writes it beside the report, and the replay suite
// re-drives recorded rounds through the tool layer with no GPU at all — which is what makes a
// parser or formatter change a one-second test instead of a twenty-minute measurement.

import type { AgentConfig } from './config'
import type { ToolCall } from './tools'

export interface TranscriptRound {
  round: number
  /** Exactly what the model emitted, tool payloads and all. */
  raw: string
  finishReason: string | null
  promptTokens: number
  completionTokens: number
  calls: Array<{ name: string; arguments: Record<string, unknown>; ok?: boolean; summary?: string; repeat?: boolean }>
  parseErrors: string[]
  /** Project findings fed back after this round, when any were.  */
  findings?: string[]
}

export interface Transcript {
  id: string
  startedAt: number
  input: string
  model?: string
  config: AgentConfig
  rounds: TranscriptRound[]
  outcome?: { content: string; rounds: number; cutOff: boolean; stopped: boolean; seconds: number }
}

const HISTORY = 20
const transcripts: Transcript[] = []

export function startTranscript(input: string, config: AgentConfig, model?: string): Transcript {
  const transcript: Transcript = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    input,
    model,
    config,
    rounds: [],
  }
  transcripts.push(transcript)
  if (transcripts.length > HISTORY) transcripts.shift()
  return transcript
}

export function recordRound(transcript: Transcript, round: Omit<TranscriptRound, 'calls'> & { calls: ToolCall[] }): TranscriptRound {
  const entry: TranscriptRound = { ...round, calls: round.calls.map((call) => ({ ...call })) }
  transcript.rounds.push(entry)
  return entry
}

export function getTranscripts(): Transcript[] {
  return transcripts
}

export function getLastTranscript(): Transcript | undefined {
  return transcripts.at(-1)
}

export function clearTranscripts(): void {
  transcripts.length = 0
}
