import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'

import { prepareEngine } from './engine'
import { isPageBuilderModel } from './models'
import { pageBuilderPrompt } from './prompts'
import {
  createTurnContext,
  parseToolCalls,
  runTool,
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

export interface AgentCallbacks {
  onText(content: string): void
  onTool(activity: AgentToolActivity): void
}

export interface AgentResult {
  content: string
  cutOff: boolean
  rounds: number
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

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
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
    for await (const chunk of stream) {
      rawContent += chunk.choices[0]?.delta.content ?? ''
      finishReason = chunk.choices[0]?.finish_reason ?? finishReason
      const visible = visibleAssistantText(rawContent)
      if (visible) {
        finalVisibleText = visible
        callbacks.onText(visible)
      }
    }

    if (finishReason === 'length') {
      return {
        content: finalVisibleText || 'The model output was cut off before it could finish.',
        cutOff: true,
        rounds: round + 1,
      }
    }

    let calls: ToolCall[]
    try {
      calls = parseToolCalls(rawContent)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      messages.push({ role: 'assistant', content: rawContent })
      messages.push({
        role: 'user',
        content: `<tool_response>${JSON.stringify({
          ok: false,
          summary: `The tool call could not be parsed: ${message}. Emit a corrected tool call.`,
        })}</tool_response>`,
      })
      continue
    }

    if (calls.length === 0) {
      return {
        content: finalVisibleText || visibleAssistantText(rawContent),
        cutOff: false,
        rounds: round + 1,
      }
    }

    messages.push({ role: 'assistant', content: rawContent })

    const signatures = calls.map((call) => JSON.stringify(call))
    if (signatures.every((signature) => answeredSinceWrite.has(signature))) {
      repeatedRounds += 1
      if (repeatedRounds >= MAX_REPEATED_ROUNDS) {
        const content =
          finalVisibleText ||
          'Stopped: the model kept repeating tool calls without changing the project.'
        callbacks.onText(content)
        return { content, cutOff: false, rounds: round + 1 }
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
    for (const signature of signatures) answeredSinceWrite.add(signature)
    if (calls.some((call) => call.name === 'write_file')) answeredSinceWrite.clear()

    const completed: Array<{ call: ToolCall; result: ToolResult }> = []
    for (const [index, call] of calls.entries()) {
      const id = activityId(round, index)
      callbacks.onTool({ id, call, status: 'running' })
      const result = await runTool(call, turn)
      callbacks.onTool({
        id,
        call,
        status: result.ok ? 'complete' : 'error',
        result,
      })
      completed.push({ call, result })
      messages.push({ role: 'user', content: toolResponse(call, result) })
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
      !smartPageNeedsStyles
    ) {
      const uniquePaths = [...new Set(writtenPaths)]
      const summary = `Updated ${uniquePaths.join(', ')} and reloaded the preview.`
      callbacks.onText(summary)
      return { content: summary, cutOff: false, rounds: round + 1 }
    }
  }

  const content = finalVisibleText || 'I reached the eight-round safety limit before finishing.'
  callbacks.onText(content)
  return { content, cutOff: false, rounds: MAX_ROUNDS }
}
