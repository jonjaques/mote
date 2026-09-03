import { normalizeProjectPath, projectFS } from '@/sandbox/fs'
import { sandboxBridge } from '@/sandbox/runtime'

import { getAgentConfig, type ToolTrigger } from './config'
import { formatProjectFile } from './format'

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
  properties: Record<string, { type: string; description?: string }>
  required?: string[]
  additionalProperties: false
}

interface ToolDefinition {
  name: string
  /** One line, used verbatim in the generated system prompt. */
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

/**
 * The one path that changes a file: format, store, wait for the preview to come back, and
 * report what the page said while reloading. Both writing tools go through it so the formatter
 * and the runtime-error check cannot drift apart.
 */
async function applyWrite(path: string, content: string, turn: TurnContext): Promise<ToolResult> {
  const format = getAgentConfig().formatOnWrite
    ? await formatProjectFile(path, content)
    : { content, changed: false, formatted: false, error: undefined }

  // Handing a model the file it asked to overwrite has a failure mode of its own: the 1.5B
  // copies it back verbatim and the turn ends reporting success over a page nothing happened
  // to. A write that changes nothing is the one write we can be certain did not do the job.
  const before = projectFS.exists(path) ? projectFS.read(path) : undefined
  if (before === format.content) {
    return {
      ok: false,
      summary: `${normalizedKey(path)} is unchanged: what you sent is byte-for-byte what is already there. Send the file with the requested change applied, or use edit_file to make just that change.`,
    }
  }

  const writtenAt = Date.now()
  const sandboxRevision = sandboxBridge.getDocumentRevision()
  // Stored even when it does not parse. A refused write would leave read_file answering with
  // content the model never sent, and the model would be debugging a file it cannot see.
  const bytes = projectFS.write(path, format.content)
  turn.writtenPaths.add(normalizedKey(path))

  await sandboxBridge.waitForReloadAfter(sandboxRevision)
  // The runtime announces itself before app.js executes, so allow its first task to settle.
  await wait(75)
  const runtimeErrors = sandboxBridge
    .getConsoleEntries()
    .filter((entry) => entry.level === 'error' && entry.timestamp >= writtenAt)
    .map((entry) => entry.args.join(' '))

  const wrote = `Wrote ${path} (${bytes} bytes).`
  return {
    ok: !format.error && runtimeErrors.length === 0,
    summary: format.error
      ? `${wrote} It has a syntax error at ${format.error} Fix it and write the file again.`
      : wrote,
    value: { path, bytes, formatted: format.formatted && format.changed },
    runtimeErrors: runtimeErrors.length ? runtimeErrors : undefined,
  }
}

const HAND_OVER_LIMIT = 8_000

/**
 * A refusal that answers the question behind it: here is the file you have not seen. Recorded
 * on the turn, because after this the model *has* seen it and a second refusal would be a loop.
 *
 * The wording is measured. "Here it is. Call read_file and copy the exact text" contradicts its
 * own payload and the 1.5B kept re-sending the identical failed call; "Here it is. Write it
 * again in full" got the file echoed back byte-for-byte with the requested change missing. The
 * summary has to say both that the content is attached and that the change still has to happen.
 */
function handOver(key: string, turn: TurnContext, summary: string): ToolResult {
  const content = projectFS.read(key)
  turn.readPaths.add(key)
  return {
    ok: false,
    summary,
    value: {
      path: key,
      content:
        content.length > HAND_OVER_LIMIT
          ? `${content.slice(0, HAND_OVER_LIMIT)}\n\n<!-- truncated after ${HAND_OVER_LIMIT} characters -->`
          : content,
    },
  }
}

// Matching, in four passes of decreasing strictness. A model reproducing a passage from memory
// gets its formatting wrong far more often than its words, and every refused edit sends it back
// to rewriting the whole file by hand — which is the failure edit_file exists to prevent.
//
//   exact       what it sent is in the file
//   spacing     the amount of whitespace differs: an indent, a wrapped line
//   packing     whitespace is present on one side and absent on the other — `margin:0` against
//               a file that says `margin: 0`, `.a{` against `.a {`
//   formatted   the fragment, run through prettier for the file's language, is in the file.
//               Files are formatted on write, so this settles quote style, semicolons, `<br>`
//               against `<br />` — differences no amount of whitespace handling can reach.
//
// `packing` can in principle join two words into one (`a b` matching `ab`), so like every other
// pass it has to land on exactly one place unless the caller asked for all of them.
export type MatchTier = 'exact' | 'spacing' | 'packing' | 'formatted'

interface Span {
  start: number
  end: number
}

// The normalised text plus, per character, where it came from — so a match found in normalised
// coordinates can be spliced out of the original.
function normalizeWhitespace(text: string, keepSeparators: boolean): { text: string; index: number[] } {
  let out = ''
  const index: number[] = []
  let pendingSpace = false
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) {
      pendingSpace = out.length > 0
      continue
    }
    if (pendingSpace && keepSeparators) {
      out += ' '
      index.push(i)
    }
    pendingSpace = false
    out += text[i]
    index.push(i)
  }
  return { text: out, index }
}

function exactSpans(source: string, needle: string): Span[] {
  const spans: Span[] = []
  for (let from = source.indexOf(needle); from !== -1; from = source.indexOf(needle, from + 1)) {
    spans.push({ start: from, end: from + needle.length })
  }
  return spans
}

function normalizedSpans(source: string, needle: string, keepSeparators: boolean): Span[] {
  const haystack = normalizeWhitespace(source, keepSeparators)
  const target = normalizeWhitespace(needle, keepSeparators)
  if (!target.text) return []
  return exactSpans(haystack.text, target.text).map((span) => ({
    start: haystack.index[span.start],
    end: haystack.index[span.end - 1] + 1,
  }))
}

/** The strictest pass that finds anything. Exported for its own tests. */
export function findEditSpans(source: string, needle: string): { spans: Span[]; tier: MatchTier } {
  const exact = exactSpans(source, needle)
  if (exact.length) return { spans: exact, tier: 'exact' }
  const spacing = normalizedSpans(source, needle, true)
  if (spacing.length) return { spans: spacing, tier: 'spacing' }
  return { spans: normalizedSpans(source, needle, false), tier: 'packing' }
}

// The measured miss is a model editing `<header>` in a page whose header is
// `<header class="site-header">`: it has the right element and the wrong text. Naming the line
// it meant is worth more than "not found", which sends a small model back to rewriting the
// whole file. Longest matching prefix, so the answer is a line that really is in the file.
function nearestLine(source: string, oldText: string): string | undefined {
  const wanted = oldText.split('\n').map((line) => line.trim()).find((line) => line.length >= 4)
  if (!wanted) return undefined
  for (let length = wanted.length; length >= 4; length -= 1) {
    const at = source.indexOf(wanted.slice(0, length))
    if (at === -1) continue
    const start = source.lastIndexOf('\n', at) + 1
    const end = source.indexOf('\n', at)
    return source.slice(start, end === -1 ? undefined : end).trim().slice(0, 160)
  }
  return undefined
}

export interface EditOutcome {
  content?: string
  replacements?: number
  /** How the passage was found. Anything but `exact` is worth saying out loud in the result. */
  tier?: MatchTier
  error?: string
}

/** Needs no filesystem or sandbox, so the replacement rules can be tested on strings alone. */
export async function applyEdit(
  source: string,
  oldText: string,
  newText: string,
  { path = 'the file', replaceAll = false }: { path?: string; replaceAll?: boolean } = {},
): Promise<EditOutcome> {
  // The 7B sends an empty old_text when it means to add something rather than replace it, so
  // the message has to answer the question it was actually asking.
  if (!oldText) {
    return {
      error:
        '“old_text” is the text to replace and must not be empty. To add something, edit_file the passage it should follow, or write_file the whole file.',
    }
  }
  if (oldText === newText) return { error: '“old_text” and “new_text” are identical, so there is nothing to change.' }

  let { spans, tier } = findEditSpans(source, oldText)
  if (spans.length === 0) {
    // Last pass: canonicalise the fragment the way the file itself was canonicalised on write.
    // A fragment often will not parse on its own (`<header>` becomes `<header></header>`, a
    // lone declaration is not a stylesheet), and that is fine — an unusable normalisation
    // simply finds nothing, exactly as the raw text did.
    const formatted = (await formatProjectFile(path, oldText)).content.trim()
    if (formatted && formatted !== oldText) {
      const retry = findEditSpans(source, formatted)
      if (retry.spans.length) {
        spans = retry.spans
        tier = 'formatted'
      }
    }
  }

  if (spans.length === 0) {
    const near = nearestLine(source, oldText)
    return {
      error: `${path} does not contain that text.${near ? ` Its closest line is “${near}”.` : ''} Copy the exact text from the file and call edit_file again.`,
    }
  }
  if (spans.length > 1 && !replaceAll) {
    return {
      error: `“old_text” matches ${spans.length} places in ${path}. Include more of the surrounding lines so it matches once, or pass "replace_all": true.`,
    }
  }

  let content = ''
  let cursor = 0
  for (const span of replaceAll ? spans : spans.slice(0, 1)) {
    content += source.slice(cursor, span.start) + newText
    cursor = span.end
  }
  return { content: content + source.slice(cursor), replacements: replaceAll ? spans.length : 1, tier }
}

const tools: ToolDefinition[] = [
  {
    name: 'write_file',
    description: 'create or replace a project file with its complete new content.',
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
        const withEdit = getAgentConfig().tools.includes('edit_file')
          ? ' Use edit_file for a small change, or write_file the whole file again'
          : ' Write the whole file again'
        // Sending the file back with the refusal collapses read → write into one round. The
        // model asked to replace it; the reason it must not is that it has not seen it, and
        // the cheapest way to fix that is to answer the question it did not know to ask.
        // Handing it over *is* the read — without recording that, the retry is refused again
        // and the turn spends every round being handed the same file.
        if (getAgentConfig().refusalIncludesFile) {
          return handOver(
            key,
            turn,
            `${key} already exists and you have not read it this turn. Its current content is in "result".${withEdit} — with the change the user asked for applied, and everything else left exactly as it is.`,
          )
        }
        return {
          ok: false,
          summary: `${key} already exists with ${projectFS.read(path).length} characters you have not read this turn. Call read_file on it first, then write_file the complete updated file that keeps everything the user did not ask to change.`,
        }
      }
      return applyWrite(path, content, turn)
    },
  },
  {
    name: 'edit_file',
    description:
      'replace one exact passage in an existing file. Cheaper and safer than rewriting a file you only need to change part of.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        old_text: { type: 'string', description: 'Exact text to replace, copied from the file.' },
        new_text: { type: 'string', description: 'Text to put in its place.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring one.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
    async run(arguments_, turn) {
      const path = requireString(arguments_, 'path')
      const source = projectFS.read(path)
      const key = normalizedKey(path)
      const outcome = await applyEdit(source, requireString(arguments_, 'old_text'), requireString(arguments_, 'new_text'), {
        path: key,
        replaceAll: arguments_.replace_all === true,
      })
      if (outcome.content === undefined) {
        // Measured twice: the 1.5B edits `<header>` in a page whose header is
        // `<header class="site-header">`, and the 7B invents `/* Add your styles here */` for a
        // stylesheet it never read. Both then repeat the same call. Neither is a matching
        // problem — the answer is the file, and the summary has to say the file is attached.
        const error = outcome.error ?? 'The edit did not apply.'
        return getAgentConfig().refusalIncludesFile && !turn.readPaths.has(key)
          ? handOver(key, turn, `${error} Its current content is in "result" — work from that.`)
          : { ok: false, summary: error }
      }

      // An applied edit proves the model has seen the file, which is what the write guard asks.
      turn.readPaths.add(key)
      const result = await applyWrite(path, outcome.content, turn)
      // Say when the passage did not match as sent: the model is being told its memory of the
      // file is approximate, which is the thing it can act on next time.
      const how = outcome.tier === 'exact' ? '' : ` (matched ignoring ${outcome.tier === 'formatted' ? 'formatting' : 'whitespace'})`
      return {
        ...result,
        summary: result.ok
          ? `Edited ${key}${how}: ${outcome.replacements} ${outcome.replacements === 1 ? 'replacement' : 'replacements'}, ${outcome.content.length} characters now.`
          : result.summary,
      }
    },
  },
  {
    name: 'read_file',
    description: 'read a project file. Long files are truncated.',
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
    description: 'list project file paths and byte sizes.',
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
      'evaluate JavaScript in the rendered preview and return its value plus new console lines. Inspection only.',
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
      // Say so when the sandbox truncated: otherwise the model reads a partial log as the
      // whole story and "concludes" from output it never saw.
      const dropped = response.consoleDropped ?? 0
      const ran = response.ok ? 'JavaScript ran in the sandbox.' : 'Sandbox JavaScript threw.'
      return {
        ok: response.ok,
        summary: dropped ? `${ran} ${dropped} further console lines were dropped.` : ran,
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
    description: 'return the rendered document HTML for inspection.',
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

function enabledTools(): ToolDefinition[] {
  const names = getAgentConfig().tools
  return names.map((name) => toolMap.get(name)).filter((tool): tool is ToolDefinition => tool !== undefined)
}

// `write_file {"path": string, "content": string}` — the prompt's tool list is rendered from
// the schemas rather than written twice. A tool added without its prompt line was the obvious
// way for this to go wrong, and the prompt wording is measured, so it must not drift.
function signatureOf(tool: ToolDefinition): string {
  const required = new Set(tool.schema.required ?? [])
  const fields = Object.entries(tool.schema.properties).map(
    ([name, property]) => `"${name}"${required.has(name) ? '' : '?'}: ${property.type}`,
  )
  return `${tool.name} {${fields.join(', ')}}`
}

/** The `Available tools:` block of the system prompt, for whichever tools are enabled. */
export function describeTools(): string {
  return enabledTools()
    .map((tool) => `- ${signatureOf(tool)} — ${tool.description}`)
    .join('\n')
}

export function enabledToolNames(): string[] {
  return enabledTools().map((tool) => tool.name)
}

// Wrappers, one wire format. `<tool_call>` is Qwen's native trigger. The Markdown fence is a
// trigger because Qwen2.5-Coder habitually answers with a ```json block instead: left as free
// text the JSON inside carries raw newlines and quotes and cannot be parsed, so a full page is
// generated and thrown away. Once the fence itself activates the grammar the block is valid.
// `bare` covers models that emit the object with no wrapper at all; it is off by default
// because it arms the grammar on any object whose first key is "name".
const FENCE = '```'
const WRAPPERS: Record<ToolTrigger, { trigger: string; begin(name: string): string; end: string }> = {
  tag: { trigger: '<tool_call>', begin: (name) => `<tool_call>\n{"name":"${name}","arguments":`, end: '}\n</tool_call>' },
  fence: { trigger: FENCE, begin: (name) => `${FENCE}json\n{"name":"${name}","arguments":`, end: `}\n${FENCE}` },
  bare: { trigger: '{"name":', begin: (name) => `{"name":"${name}","arguments":`, end: '}' },
}

// `requireCall` mirrors the official structural-tag example, which forces at least one tag on
// the turn that answers the user. The agent sets it for the first round only: a request must
// start with a tool call, but the rounds after a tool result must be free to answer in prose
// or the loop could never end with a summary.
export function structuralTagFor({ requireCall }: { requireCall: boolean }): StructuralTag {
  const wrappers = getAgentConfig().triggers.map((name) => WRAPPERS[name])
  const available = enabledTools()
  return {
    type: 'structural_tag',
    format: {
      type: 'triggered_tags',
      triggers: wrappers.map((wrapper) => wrapper.trigger),
      tags: wrappers.flatMap((wrapper) =>
        available.map((tool) => ({
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

export interface ToolBlock {
  // Character offsets in the scanned content: where the opener starts and where the block ends.
  start: number
  end: number
  /** Offset of the `{` that opens `json`, so a caller can rewrite the payload in place. */
  jsonStart: number
  json: string
  wrapper: 'tag' | 'fence' | 'bare'
  // False while the closing tag or fence has not arrived; the JSON itself is already complete.
  closed: boolean
}

// End offset (exclusive) of the JSON object starting at `start`, or -1 while it is incomplete.
// Walks strings and escapes so a brace or a fence inside file content cannot end it early.
function balancedObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

// Every tool block in `content` from offset `from`, in order, including one still streaming
// (closed: false). The agent scans the growing stream with this so a call can run as soon as
// its JSON is whole, and parseToolCalls uses it at the end of a turn.
export function scanToolBlocks(content: string, from = 0): ToolBlock[] {
  const blocks: ToolBlock[] = []
  // Tags and fences are always scanned — a model emits them whether or not the grammar armed
  // them. A bare object is scanned only when its trigger is enabled, and even then only at the
  // start of a line with "name" as its first key: anything looser would swallow JSON literals
  // out of the page the model is writing.
  const opener = getAgentConfig().triggers.includes('bare')
    ? /<tool_call>|```(?:json)?[ \t]*\r?\n?|(?:^|\n)[ \t]*(?=\{[ \t]*"name"[ \t]*:)/g
    : /<tool_call>|```(?:json)?[ \t]*\r?\n?/g
  opener.lastIndex = from
  let match: RegExpExecArray | null
  while ((match = opener.exec(content)) !== null) {
    const wrapper: ToolBlock['wrapper'] = match[0].startsWith('<') ? 'tag' : match[0].includes(FENCE) ? 'fence' : 'bare'
    const brace = content.indexOf('{', match.index + match[0].length)
    if (brace === -1) break
    // Only whitespace may sit between the opener and the object; anything else is prose.
    if (content.slice(match.index + match[0].length, brace).trim() !== '') continue
    const objectEnd = balancedObjectEnd(content, brace)
    if (objectEnd === -1) {
      blocks.push({
        start: match.index,
        end: content.length,
        jsonStart: brace,
        json: content.slice(brace),
        wrapper,
        closed: false,
      })
      break
    }
    // A bare object has no closer, so the balanced brace is the whole of it.
    const closer = wrapper === 'tag' ? /^\s*<\/tool_call>/ : /^\s*```/
    const closed = wrapper === 'bare' ? null : closer.exec(content.slice(objectEnd))
    const end = closed ? objectEnd + closed[0].length : objectEnd
    blocks.push({
      start: match.index,
      end,
      jsonStart: brace,
      json: content.slice(brace, objectEnd),
      wrapper,
      closed: wrapper === 'bare' || Boolean(closed),
    })
    opener.lastIndex = end
  }
  return blocks
}

// Parse a finished block. Registered fenced and bare calls are accepted; any other fence is
// prose (a config sample, a snippet) and must not become a side effect or a "broken tool call"
// complaint. A <tool_call> that is not a call object is an error the model should hear about.
export function parseToolBlock(block: ToolBlock): ToolCall | undefined {
  if (block.wrapper === 'tag') return parseToolCallObject(block.json)
  try {
    const call = parseToolCallObject(block.json)
    return toolMap.has(call.name) ? call : undefined
  } catch {
    return undefined
  }
}

export function parseToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = []
  for (const block of scanToolBlocks(content)) {
    // An unterminated block whose object is whole still counts: the model may hit its stop
    // token right after the closing brace, and the call is not less real for that.
    const hasWholeObject = balancedObjectEnd(block.json, 0) === block.json.length
    if (!block.closed && !hasWholeObject) continue
    const call = parseToolBlock(block)
    if (call) calls.push(call)
  }
  if (calls.length > 0) return calls

  const trimmed = content.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const call = parseToolCallObject(trimmed)
      if (toolMap.has(call.name)) calls.push(call)
    } catch {
      // Bare JSON that is not a call object is prose.
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
    // While streaming, an open fence is a tool call in progress the moment it starts an object.
    .replace(/```(?:json)?\s*\{[\s\S]*$/i, '')
    .replace(/```(?:json)?\s*$/i, '')
    .replace(/(?:^|\n)[ \t]*\{[ \t]*"name"[ \t]*:[\s\S]*$/, '')
    .trim()
}

export async function runTool(call: ToolCall, turn: TurnContext = createTurnContext()): Promise<ToolResult> {
  const tool = getAgentConfig().tools.includes(call.name) ? toolMap.get(call.name) : undefined
  if (!tool) {
    return { ok: false, summary: `Unknown tool: ${call.name}. Available tools: ${enabledToolNames().join(', ')}.` }
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
