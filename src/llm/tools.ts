import { normalizeProjectPath, projectFS } from '@/sandbox/fs'
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

// What one agent turn has already seen. Tool payloads never enter the chat history, so a
// model asked for a follow-up has no memory of the file it wrote last turn; without this
// record it happily replaces a 700-byte stylesheet with the one rule the user asked for.
export interface TurnContext {
  readPaths: Set<string>
  writtenPaths: Set<string>
}

export function createTurnContext(): TurnContext {
  return { readPaths: new Set(), writtenPaths: new Set() }
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
  run(arguments_: Record<string, unknown>, turn: TurnContext): Promise<ToolResult>
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

// The filesystem normalises "./styles.css" and "styles.css" to one entry; the turn record
// must agree with it or a read under one spelling would not license a write under the other.
const normalizedKey = normalizeProjectPath

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
    async run(arguments_, turn) {
      const path = requireString(arguments_, 'path')
      const content = requireString(arguments_, 'content')
      const key = normalizedKey(path)
      if (!projectFS.isPristine(path) && !turn.readPaths.has(key) && !turn.writtenPaths.has(key)) {
        const existing = projectFS.read(path)
        return {
          ok: false,
          summary: `${key} already exists with ${existing.length} characters you have not read this turn. Call read_file on it first, then write_file the complete updated file that keeps everything the user did not ask to change.`,
        }
      }
      const writtenAt = Date.now()
      const sandboxRevision = sandboxBridge.getDocumentRevision()
      const bytes = projectFS.write(path, content)
      turn.writtenPaths.add(key)

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
    async run(arguments_, turn) {
      const path = requireString(arguments_, 'path')
      const content = projectFS.read(path)
      turn.readPaths.add(normalizedKey(path))
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
    description:
      'Evaluate JavaScript inside the live preview and return its value and new console lines. For inspection only: DOM changes are discarded on the next reload, so use write_file to change the project.',
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
    description: 'Return the rendered document HTML for inspection.',
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

// Two wrappers, one wire format. `<tool_call>` is Qwen's native trigger. The Markdown fence is
// a trigger because Qwen2.5-Coder habitually answers with a ```json block instead: left as free
// text the JSON inside carries raw newlines and quotes and cannot be parsed, so a full page is
// generated and thrown away. Once the fence itself activates the grammar the block is valid.
const FENCE = '```'
const wrappers = [
  { begin: (name: string) => `<tool_call>\n{"name":"${name}","arguments":`, end: '}\n</tool_call>' },
  { begin: (name: string) => `${FENCE}json\n{"name":"${name}","arguments":`, end: `}\n${FENCE}` },
]

// `requireCall` mirrors the official structural-tag example, which forces at least one tag on
// the turn that answers the user. The agent sets it for the first round only: a request must
// start with a tool call, but the rounds after a tool result must be free to answer in prose
// or the loop could never end with a summary.
export function structuralTagFor({ requireCall }: { requireCall: boolean }): StructuralTag {
  return {
    type: 'structural_tag',
    format: {
      type: 'triggered_tags',
      triggers: ['<tool_call>', FENCE],
      tags: wrappers.flatMap((wrapper) =>
        tools.map((tool) => ({
          type: 'tag' as const,
          begin: wrapper.begin(tool.name),
          content: { type: 'json_schema' as const, json_schema: tool.schema },
          end: wrapper.end,
        })),
      ),
      at_least_one: requireCall,
      stop_after_first: false,
    },
  }
}

export const structuralTag: StructuralTag = structuralTagFor({ requireCall: false })

export function parseToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = []
  const pattern = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

  for (const match of content.matchAll(pattern)) {
    calls.push(parseToolCallObject(match[1]))
  }

  if (calls.length > 0) return calls

  // Fenced calls: valid JSON when the grammar produced them, arbitrary text when the model
  // wrote a fence the grammar did not cover. Accept only registered call objects and treat
  // anything else as prose, so a config sample or snippet never becomes a side effect or a
  // "broken tool call" complaint sent back to the model.
  const fenced = [...content.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi)].map((m) => m[1])
  const trimmed = content.trim()
  const raw = trimmed.startsWith('{') && trimmed.endsWith('}') ? [trimmed] : []
  for (const candidate of fenced.length ? fenced : raw) {
    try {
      const call = parseToolCallObject(candidate)
      if (toolMap.has(call.name)) calls.push(call)
    } catch {
      // Not a call object.
    }
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
    .replace(/```(?:json)?\s*\{[\s\S]*?"name"\s*:[\s\S]*?```/gi, '')
    .replace(/```(?:json)?\s*\{[\s\S]*?"name"\s*:[\s\S]*$/i, '')
    .trim()
}

export async function runTool(call: ToolCall, turn: TurnContext = createTurnContext()): Promise<ToolResult> {
  const tool = toolMap.get(call.name)
  if (!tool) {
    return { ok: false, summary: `Unknown tool: ${call.name}` }
  }

  try {
    return await tool.run(call.arguments, turn)
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
    }
  }
}
