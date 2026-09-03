import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'

import { projectFS } from '@/sandbox/fs'

import { getAgentConfig, type AgentConfig } from './config'
import { prepareEngine } from './engine'
import { buildSystemPrompt } from './prompts'
import { liveStream } from './stream'
import {
  createTurnContext,
  parseToolBlock,
  runTool,
  scanToolBlocks,
  structuralTagFor,
  visibleAssistantText,
  type ToolCall,
  type ToolResult,
} from './tools'
import { recordRound, startTranscript, type Transcript } from './transcript'
import { inspectProject } from './verify'

// Small models re-issue inspection calls: the same run_js once it "worked" in the DOM, or
// read_file cycling over every project file. Nothing read can change until something is
// written, so a round made only of calls already answered since the last write_file is a
// repeat. Two nudges are enough to redirect a model that can be redirected; then stop.
const MAX_REPEATED_ROUNDS = 2

export interface AgentToolActivity {
  id: string
  call: ToolCall
  status: 'running' | 'complete' | 'error'
  result?: ToolResult
}

// Where the current generation is, for the chat to show something better than "Thinking…"
// while a 7B model spends two minutes streaming a tool call the user cannot see yet.
export interface AgentProgress {
  phase: 'prefill' | 'text' | 'tool'
  tool?: string
  path?: string
  chars: number
  round: number
  startedAt: number
}

export interface AgentStats {
  seconds: number
  rounds: number
  completionTokens: number
  promptTokens: number
  tokensPerSecond?: number
}

export interface AgentCallbacks {
  onText(content: string): void
  onTool(activity: AgentToolActivity): void
  onProgress?(progress: AgentProgress): void
}

export interface AgentResult {
  content: string
  cutOff: boolean
  stopped: boolean
  rounds: number
  stats: AgentStats
}

// The last open tag decides what the model is doing right now: a name and, for file tools,
// the path arrive within the first few dozen characters, long before the payload ends.
export function describeStreaming(rawContent: string): Pick<AgentProgress, 'phase' | 'tool' | 'path' | 'chars'> {
  const openers = [...rawContent.matchAll(/<tool_call>|```(?:json)?\s*\{|(?:^|\n)\{(?=[ \t]*"name")/g)]
  const last = openers.at(-1)
  if (!last || last.index === undefined) {
    return { phase: rawContent.length ? 'text' : 'prefill', chars: rawContent.length }
  }
  const tail = rawContent.slice(last.index)
  if (/<\/tool_call>\s*$|```\s*$/.test(tail) && tail.length > 12) {
    return { phase: 'text', chars: rawContent.length }
  }
  const tool = tail.match(/"name"\s*:\s*"([^"]*)"/)?.[1]
  const path = tail.match(/"path"\s*:\s*"([^"]*)"/)?.[1]
  return { phase: 'tool', tool, path, chars: tail.length }
}

function activityId(round: number, index: number): string {
  return `tool-${Date.now()}-${round}-${index}`
}

function toolResponse(call: ToolCall, result: ToolResult): string {
  return `<tool_response>${JSON.stringify({
    name: call.name,
    ok: result.ok,
    result: result.value,
    summary: result.summary,
    runtime_errors: result.runtimeErrors,
  })}</tool_response>`
}

function noteResponse(fields: Record<string, unknown>): ChatCompletionMessageParam {
  return { role: 'user', content: `<tool_response>${JSON.stringify(fields)}</tool_response>` }
}

const COMPACT_ABOVE = 300

// A page the model just wrote goes into the history twice: once as the assistant turn that
// contains the write_file payload, and once more as whatever it writes next. In an 8k window
// that is the whole budget by round three, and the second round is where follow-up edits
// happen. The payload is replaced by its length: the tool response already confirms the write,
// and read_file can bring the file back if the model needs to see it again.
export function compactAssistantTurn(raw: string): string {
  const blocks = scanToolBlocks(raw)
  if (blocks.length === 0) return raw
  let out = ''
  let cursor = 0
  for (const block of blocks) {
    let payload: unknown
    try {
      payload = JSON.parse(block.json)
    } catch {
      continue
    }
    if (!payload || typeof payload !== 'object') continue
    const call = payload as { arguments?: Record<string, unknown> }
    if (!call.arguments || typeof call.arguments !== 'object') continue
    let compacted = false
    for (const [key, value] of Object.entries(call.arguments)) {
      if (typeof value === 'string' && value.length > COMPACT_ABOVE) {
        call.arguments[key] = `<${value.length} characters, sent>`
        compacted = true
      }
    }
    if (!compacted) continue
    out += raw.slice(cursor, block.jsonStart) + JSON.stringify(payload)
    cursor = block.jsonStart + block.json.length
  }
  return cursor === 0 ? raw : out + raw.slice(cursor)
}

export async function runAgent(
  input: string,
  history: ChatCompletionMessageParam[],
  callbacks: AgentCallbacks,
): Promise<AgentResult> {
  const { engine } = await prepareEngine()
  // Snapshotted once: a variant switched mid-turn would produce a run that belongs to neither.
  const config: AgentConfig = { ...getAgentConfig() }
  const turn = createTurnContext()
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(config, projectFS.getSnapshot().files) },
    ...history,
    { role: 'user', content: input },
  ]
  const transcript: Transcript = startTranscript(input, config, String(engine.modelId ?? ''))
  let finalVisibleText = ''
  const answeredSinceWrite = new Set<string>()
  let repeatedRounds = 0
  let findingRounds = 0
  const startedAt = Date.now()
  const stats: AgentStats = { seconds: 0, rounds: 0, completionTokens: 0, promptTokens: 0 }
  const finish = (content: string, flags: { cutOff?: boolean; stopped?: boolean }, round: number): AgentResult => {
    stats.rounds = round + 1
    stats.seconds = (Date.now() - startedAt) / 1_000
    liveStream.clear()
    const result = { content, cutOff: flags.cutOff ?? false, stopped: flags.stopped ?? false, rounds: round + 1, stats }
    transcript.outcome = { content, rounds: result.rounds, cutOff: result.cutOff, stopped: result.stopped, seconds: stats.seconds }
    return result
  }

  for (let round = 0; round < config.maxRounds; round += 1) {
    liveStream.set('')
    callbacks.onProgress?.({ phase: 'prefill', chars: 0, round, startedAt })
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      stream_options: { include_usage: true },
      response_format: {
        type: 'structural_tag',
        structural_tag: structuralTagFor({ requireCall: round === 0 && config.requireFirstCall }),
      },
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      extra_body: { enable_thinking: false },
    })

    let rawContent = ''
    let finishReason: string | null = null
    let lastProgressKey = ''
    let promptTokens = 0
    let completionTokens = 0

    // Calls run as soon as their block is whole, while the model is still streaming the rest
    // of its turn. A 7B page arrives as three write_file blocks over two minutes; running each
    // on arrival puts the page in the preview a file at a time instead of all at the end.
    interface RoundEntry {
      call?: ToolCall
      parseError?: string
      repeat: boolean
      result?: Promise<ToolResult>
    }
    const entries: RoundEntry[] = []
    let scanFrom = 0
    let queue: Promise<unknown> = Promise.resolve()
    const execute = (call: ToolCall, index: number): Promise<ToolResult> => {
      const id = activityId(round, index)
      callbacks.onTool({ id, call, status: 'running' })
      const run = queue.then(async () => {
        const result = await runTool(call, turn)
        callbacks.onTool({ id, call, status: result.ok ? 'complete' : 'error', result })
        return result
      })
      queue = run.catch(() => undefined)
      return run
    }
    const absorbBlocks = (final: boolean) => {
      for (const block of scanToolBlocks(rawContent, scanFrom)) {
        if (!block.closed) {
          // Whole object, missing closer: only at the end of the stream does that count.
          const whole = final && block.json.trimEnd().endsWith('}')
          if (!whole) break
        }
        scanFrom = block.end
        let call: ToolCall | undefined
        try {
          call = parseToolBlock(block)
        } catch (error) {
          entries.push({ parseError: error instanceof Error ? error.message : String(error), repeat: false })
          continue
        }
        if (!call) continue
        const signature = JSON.stringify(call)
        if (answeredSinceWrite.has(signature)) {
          entries.push({ call, repeat: true })
          continue
        }
        // Writes are recorded like everything else and the set is cleared when one actually
        // succeeds, below. Clearing here instead made a *failing* write un-repeatable: a 0.6B
        // that could not fix `onclick='alert('hi')'` sent the same 132 bytes eight times.
        answeredSinceWrite.add(signature)
        entries.push({ call, repeat: false, result: execute(call, entries.length) })
      }
    }

    for await (const chunk of stream) {
      if (chunk.usage) {
        completionTokens = chunk.usage.completion_tokens
        promptTokens = chunk.usage.prompt_tokens
        stats.completionTokens += chunk.usage.completion_tokens
        stats.promptTokens += chunk.usage.prompt_tokens
        stats.tokensPerSecond = chunk.usage.extra?.decode_tokens_per_s ?? stats.tokensPerSecond
      }
      rawContent += chunk.choices[0]?.delta.content ?? ''
      finishReason = chunk.choices[0]?.finish_reason ?? finishReason
      liveStream.set(rawContent)
      const visible = visibleAssistantText(rawContent)
      if (visible) {
        finalVisibleText = visible
        callbacks.onText(visible)
      }
      if (callbacks.onProgress) {
        const described = describeStreaming(rawContent)
        // One dispatch per phase change or per ~256 characters keeps the chat from
        // re-rendering on every token without hiding a stalled stream.
        const key = `${described.phase}:${described.tool ?? ''}:${described.path ?? ''}:${described.chars >> 8}`
        if (key !== lastProgressKey) {
          lastProgressKey = key
          callbacks.onProgress({ ...described, round, startedAt })
        }
      }
      absorbBlocks(false)
    }

    const closeRound = () =>
      recordRound(transcript, {
        round,
        raw: rawContent,
        finishReason,
        promptTokens,
        completionTokens,
        calls: entries.filter((entry) => entry.call).map((entry) => entry.call as ToolCall),
        parseErrors: entries.map((entry) => entry.parseError).filter((error): error is string => error !== undefined),
      })

    // Stop keeps whatever already ran (those cards are on screen) but starts nothing more.
    if (finishReason === 'abort') {
      await queue
      closeRound()
      return finish(finalVisibleText || 'Stopped.', { stopped: true }, round)
    }

    if (finishReason === 'length') {
      await queue
      closeRound()
      return finish(
        finalVisibleText || 'The model output was cut off before it could finish.',
        { cutOff: true },
        round,
      )
    }

    absorbBlocks(true)
    const record = closeRound()

    if (entries.length === 0) {
      return finish(finalVisibleText || visibleAssistantText(rawContent), {}, round)
    }

    // Compaction runs one turn behind. Measured: with the newest assistant turn compacted, 4 of
    // 12 trials had the 1.5B copy `<1177 characters, sent>` out of its own history into a real
    // write_file, and once it started it did that every round. A model imitates the turn it
    // just made, so that one stays verbatim and only older ones lose their payloads.
    if (config.compactHistory) {
      const previous = messages.findLast((message) => message.role === 'assistant')
      if (previous && typeof previous.content === 'string') previous.content = compactAssistantTurn(previous.content)
    }
    messages.push({ role: 'assistant', content: rawContent })

    if (entries.every((entry) => entry.repeat)) {
      repeatedRounds += 1
      if (repeatedRounds >= MAX_REPEATED_ROUNDS) {
        const content =
          finalVisibleText ||
          'Stopped: the model kept repeating tool calls without changing the project.'
        callbacks.onText(content)
        return finish(content, {}, round)
      }
      messages.push(
        noteResponse({
          ok: false,
          summary:
            'You already made this exact call and nothing has changed since, so the result would be identical. Do something different: fix what the last result reported, or write the complete updated file now.',
        }),
      )
      continue
    }

    const completed: Array<{ call: ToolCall; result: ToolResult }> = []
    // The transcript holds only the entries that parsed into a call, so its index walks
    // separately from the entry index a parse error also occupies.
    let index = -1
    for (const entry of entries) {
      if (entry.call) index += 1
      if (entry.parseError !== undefined) {
        messages.push(
          noteResponse({
            ok: false,
            summary: `The tool call could not be parsed: ${entry.parseError}. Emit a corrected tool call.`,
          }),
        )
        continue
      }
      if (!entry.call) continue
      if (entry.repeat || !entry.result) {
        record.calls[index] = { ...record.calls[index], repeat: true }
        messages.push(
          noteResponse({
            name: entry.call.name,
            ok: false,
            summary: 'Already answered this turn and nothing has changed since; the result would be identical.',
          }),
        )
        continue
      }
      const result = await entry.result
      record.calls[index] = { ...record.calls[index], ok: result.ok, summary: result.summary }
      // Only a write that landed makes earlier answers stale.
      if (result.ok && (entry.call.name === 'write_file' || entry.call.name === 'edit_file')) {
        answeredSinceWrite.clear()
      }
      completed.push({ call: entry.call, result })
      messages.push({ role: 'user', content: toolResponse(entry.call, result) })
    }

    const written = completed.filter(({ call }) => call.name === 'write_file' || call.name === 'edit_file')
    const roundSucceeded =
      written.length > 0 &&
      completed.every(({ result }) => result.ok) &&
      entries.every((entry) => entry.parseError === undefined)
    if (!roundSucceeded) continue

    // The project is only finished if it holds together. One round of findings, once per turn:
    // a second would be arguing with a model that has already been told, and every extra round
    // is a minute on the 7B.
    const findings = config.verifyWrites ? inspectProject(projectFS.getSnapshot().files) : []
    if (findings.length > 0 && findingRounds < 1) {
      findingRounds += 1
      record.findings = findings
      messages.push(noteResponse({ ok: false, summary: findings.join(' ') }))
      continue
    }

    const paths = [
      ...new Set(
        written
          .map(({ call }) => call.arguments.path)
          .filter((path): path is string => typeof path === 'string'),
      ),
    ]
    const summary = `Updated ${paths.join(', ')} and reloaded the preview.`
    callbacks.onText(summary)
    return finish(summary, {}, round)
  }

  const content = finalVisibleText || `I reached the ${config.maxRounds}-round safety limit before finishing.`
  callbacks.onText(content)
  return finish(content, {}, config.maxRounds - 1)
}
