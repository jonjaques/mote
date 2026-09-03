import { projectFS } from '@/sandbox/fs'
import { sandboxBridge } from '@/sandbox/runtime'

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  ok: boolean
  summary: string
  value?: unknown
  runtimeErrors?: string[]
}

interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: false
}

interface ToolDefinition {
  name: string
  description: string
  schema: JsonSchema
  run(arguments_: Record<string, unknown>): Promise<ToolResult>
}

export interface StructuralTag {
  type: 'structural_tag'
  format: {
    type: 'triggered_tags'
    triggers: string[]
    tags: Array<{
      type: 'tag'
      begin: string
      content: { type: 'json_schema'; json_schema: JsonSchema }
      end: string
    }>
    at_least_one: boolean
    stop_after_first: boolean
  }
}

function requireString(arguments_: Record<string, unknown>, key: string): string {
  const value = arguments_[key]
  if (typeof value !== 'string') throw new Error(`“${key}” must be a string.`)
  return value
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const tools: ToolDefinition[] = [
  {
    name: 'write_file',
    description: 'Create or replace a project file with complete content.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        content: { type: 'string', description: 'Complete file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(arguments_) {
      const path = requireString(arguments_, 'path')
      const content = requireString(arguments_, 'content')
      const writtenAt = Date.now()
      const sandboxRevision = sandboxBridge.getDocumentRevision()
      const bytes = projectFS.write(path, content)

      await sandboxBridge.waitForReloadAfter(sandboxRevision)
      // The runtime announces itself before app.js executes, so allow its first task to settle.
      await wait(75)
      const runtimeErrors = sandboxBridge
        .getConsoleEntries()
        .filter((entry) => entry.level === 'error' && entry.timestamp >= writtenAt)
        .map((entry) => entry.args.join(' '))

      return {
        ok: runtimeErrors.length === 0,
        summary: `Wrote ${path} (${bytes} bytes).`,
        value: { path, bytes },
        runtimeErrors: runtimeErrors.length ? runtimeErrors : undefined,
      }
    },
  },
  {
    name: 'read_file',
    description: 'Read a project file. Long files are truncated to keep context available.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(arguments_) {
      const path = requireString(arguments_, 'path')
      const content = projectFS.read(path)
      const limit = 8_000
      return {
        ok: true,
        summary: `Read ${path}.`,
        value:
          content.length > limit
            ? `${content.slice(0, limit)}\n\n<!-- truncated after ${limit} characters -->`
            : content,
      }
    },
  },
  {
    name: 'list_files',
    description: 'List project files and their byte sizes.',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async run() {
      return {
        ok: true,
        summary: 'Listed project files.',
        value: projectFS.list().map(({ path, bytes }) => ({ path, bytes })),
      }
    },
  },
  {
    name: 'run_js',
    description: 'Evaluate JavaScript inside the isolated preview and return its value and new console lines.',
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript function body to evaluate.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    async run(arguments_) {
      const code = requireString(arguments_, 'code')
      const response = await sandboxBridge.run(code)
      return {
        ok: response.ok,
        summary: response.ok ? 'JavaScript ran in the sandbox.' : 'Sandbox JavaScript threw.',
        value: {
          result: response.result,
          error: response.error,
          console: response.console?.map((entry) => ({
            level: entry.level,
            text: entry.args.join(' '),
          })),
        },
      }
    },
  },
  {
    name: 'get_dom',
    description: 'Return the rendered document HTML for visual debugging.',
    schema: {
      type: 'object',
      properties: {
        maxChars: {
          type: 'number',
          description: 'Maximum characters to return, from 500 to 40000.',
        },
      },
      additionalProperties: false,
    },
    async run(arguments_) {
      const value = arguments_.maxChars
      const maxChars = typeof value === 'number' ? value : undefined
      const response = await sandboxBridge.getDom(maxChars)
      return {
        ok: response.ok,
        summary: 'Captured the rendered DOM.',
        value: response.result,
      }
    },
  },
]

const toolMap = new Map(tools.map((tool) => [tool.name, tool]))

export const structuralTag: StructuralTag = {
  type: 'structural_tag',
  format: {
    type: 'triggered_tags',
    triggers: ['<tool_call>'],
    tags: tools.map((tool) => ({
      type: 'tag',
      begin: `<tool_call>\n{"name":"${tool.name}","arguments":`,
      content: { type: 'json_schema', json_schema: tool.schema },
      end: '}\n</tool_call>',
    })),
    at_least_one: false,
    stop_after_first: false,
  },
}

export function parseToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = []
  const pattern = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

  for (const match of content.matchAll(pattern)) {
    calls.push(parseToolCallObject(match[1]))
  }

  if (calls.length > 0) return calls

  // Qwen2.5-Coder sometimes describes an exact call in a JSON fence instead of emitting the
  // trigger. Accept only a single registered call object; broader JSON recovery would turn
  // ordinary assistant examples into side effects.
  const fenced = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)?.[1]
  const raw = content.trim().startsWith('{') && content.trim().endsWith('}')
    ? content.trim()
    : undefined
  const fallback = fenced ?? raw
  if (fallback) {
    const call = parseToolCallObject(fallback)
    if (toolMap.has(call.name)) calls.push(call)
  }
  return calls
}

function parseToolCallObject(value: string): ToolCall {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object') throw new Error('Tool call must be an object.')
  const call = parsed as Partial<ToolCall>
  if (typeof call.name !== 'string' || !call.arguments || typeof call.arguments !== 'object') {
    throw new Error('Tool call needs a name and arguments object.')
  }
  return { name: call.name, arguments: call.arguments }
}

export function visibleAssistantText(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/g, '')
    .replace(/```(?:json)?\s*\{[\s\S]*?"name"\s*:[\s\S]*?```\s*$/i, '')
    .trim()
}

export async function runTool(call: ToolCall): Promise<ToolResult> {
  const tool = toolMap.get(call.name)
  if (!tool) {
    return { ok: false, summary: `Unknown tool: ${call.name}` }
  }

  try {
    return await tool.run(call.arguments)
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
    }
  }
}
