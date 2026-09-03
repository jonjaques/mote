import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'

import { prepareEngine } from './engine'
import { SMART_MODEL_ID } from './models'
import { pageBuilderPrompt } from './prompts'
import {
  parseToolCalls,
  runTool,
  structuralTag,
  visibleAssistantText,
  type ToolCall,
  type ToolResult,
} from './tools'

const MAX_ROUNDS = 8

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
  const smartModelLoaded = engine.modelId?.some((id) => id.startsWith(SMART_MODEL_ID)) ?? false
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: pageBuilderPrompt },
    ...history,
    { role: 'user', content: input },
  ]
  let finalVisibleText = ''

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      response_format: {
        type: 'structural_tag',
        structural_tag: structuralTag,
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
    const completed: Array<{ call: ToolCall; result: ToolResult }> = []
    for (const [index, call] of calls.entries()) {
      const id = activityId(round, index)
      callbacks.onTool({ id, call, status: 'running' })
      const result = await runTool(call)
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
      smartModelLoaded &&
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
