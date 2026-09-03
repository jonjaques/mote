import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'

import { prepareEngine } from './engine'
import { isPageBuilderModel } from './models'
import { pageBuilderPrompt } from './prompts'
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

const MAX_ROUNDS = 8
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
  const openers = [...rawContent.matchAll(/<tool_call>|```(?:json)?\s*\{/g)]
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

export async function runAgent(
  input: string,
  history: ChatCompletionMessageParam[],
  callbacks: AgentCallbacks,
): Promise<AgentResult> {
  const { engine } = await prepareEngine()
  const pageBuilderLoaded = isPageBuilderModel(engine.modelId)
  const turn = createTurnContext()
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: pageBuilderPrompt },
    ...history,
    { role: 'user', content: input },
  ]
  let finalVisibleText = ''
  const answeredSinceWrite = new Set<string>()
  let repeatedRounds = 0
  const startedAt = Date.now()
  const stats: AgentStats = { seconds: 0, rounds: 0, completionTokens: 0, promptTokens: 0 }
  const finish = (content: string, flags: { cutOff?: boolean; stopped?: boolean }, round: number): AgentResult => {
    stats.rounds = round + 1
    stats.seconds = (Date.now() - startedAt) / 1_000
    liveStream.clear()
    return { content, cutOff: flags.cutOff ?? false, stopped: flags.stopped ?? false, rounds: round + 1, stats }
  }

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    liveStream.set('')
    callbacks.onProgress?.({ phase: 'prefill', chars: 0, round, startedAt })
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      stream_options: { include_usage: true },
      response_format: {
        type: 'structural_tag',
        structural_tag: structuralTagFor({ requireCall: round === 0 }),
      },
      max_tokens: 4_096,
      temperature: 0.2,
      extra_body: { enable_thinking: false },
    })

    let rawContent = ''
    let finishReason: string | null = null
    let lastProgressKey = ''

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
        if (call.name === 'write_file') answeredSinceWrite.clear()
        else answeredSinceWrite.add(signature)
        entries.push({ call, repeat: false, result: execute(call, entries.length) })
      }
    }

    for await (const chunk of stream) {
      if (chunk.usage) {
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

    // Stop keeps whatever already ran (those cards are on screen) but starts nothing more.
    if (finishReason === 'abort') {
      await queue
      return finish(finalVisibleText || 'Stopped.', { stopped: true }, round)
    }

    if (finishReason === 'length') {
      await queue
      return finish(
        finalVisibleText || 'The model output was cut off before it could finish.',
        { cutOff: true },
        round,
      )
    }

    absorbBlocks(true)

    if (entries.length === 0) {
      return finish(finalVisibleText || visibleAssistantText(rawContent), {}, round)
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
      messages.push({
        role: 'user',
        content: `<tool_response>${JSON.stringify({
          ok: false,
          summary:
            'You already made this call and nothing has changed since, so its result would be identical. To change the project, write_file the complete updated file now.',
        })}</tool_response>`,
      })
      continue
    }

    const completed: Array<{ call: ToolCall; result: ToolResult }> = []
    for (const entry of entries) {
      if (entry.parseError !== undefined) {
        messages.push({
          role: 'user',
          content: `<tool_response>${JSON.stringify({
            ok: false,
            summary: `The tool call could not be parsed: ${entry.parseError}. Emit a corrected tool call.`,
          })}</tool_response>`,
        })
        continue
      }
      if (!entry.call) continue
      if (entry.repeat || !entry.result) {
        messages.push({
          role: 'user',
          content: `<tool_response>${JSON.stringify({
            name: entry.call.name,
            ok: false,
            summary: 'Already answered this turn and nothing has changed since; the result would be identical.',
          })}</tool_response>`,
        })
        continue
      }
      const result = await entry.result
      completed.push({ call: entry.call, result })
      messages.push({ role: 'user', content: toolResponse(entry.call, result) })
    }

    const writtenPaths = completed
      .filter(({ call }) => call.name === 'write_file')
      .map(({ call }) => call.arguments.path)
      .filter((path): path is string => typeof path === 'string')
    const writtenHtml = completed.find(
      ({ call }) => call.name === 'write_file' && call.arguments.path === 'index.html',
    )?.call.arguments.content
    const smartPageNeedsStyles =
      pageBuilderLoaded &&
      typeof writtenHtml === 'string' &&
      /href=["'](?:\.\/)?styles\.css["']/i.test(writtenHtml) &&
      !writtenPaths.includes('styles.css')
    if (
      writtenPaths.length > 0 &&
      completed.every(({ result }) => result.ok) &&
      entries.every((entry) => entry.parseError === undefined) &&
      !smartPageNeedsStyles
    ) {
      const uniquePaths = [...new Set(writtenPaths)]
      const summary = `Updated ${uniquePaths.join(', ')} and reloaded the preview.`
      callbacks.onText(summary)
      return finish(summary, {}, round)
    }
  }

  const content = finalVisibleText || 'I reached the eight-round safety limit before finishing.'
  callbacks.onText(content)
  return finish(content, {}, MAX_ROUNDS - 1)
}
