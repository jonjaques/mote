import { describe, expect, it, vi } from 'vitest'

import { createTurnContext, parseToolCalls, runTool, scanToolBlocks, structuralTag, visibleAssistantText } from './tools'

const call = (name: string, args: Record<string, unknown>) =>
  `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`

describe('parseToolCalls', () => {
  it('extracts every structural-tag call in order', () => {
    const content = `Sure.\n${call('read_file', { path: 'index.html' })}\n${call('list_files', {})}`
    expect(parseToolCalls(content)).toEqual([
      { name: 'read_file', arguments: { path: 'index.html' } },
      { name: 'list_files', arguments: {} },
    ])
  })

  it('keeps HTML inside a JSON string intact', () => {
    const html = '<!doctype html>\n<html><body><p class="x">a & b</p></body></html>'
    const [parsed] = parseToolCalls(call('write_file', { path: 'index.html', content: html }))
    expect(parsed.arguments.content).toBe(html)
  })

  it('returns no calls for plain prose', () => {
    expect(parseToolCalls('The header is now sticky.')).toEqual([])
  })

  it('accepts fenced calls for registered tools, in order', () => {
    const fenced = 'Plan:\n```json\n{"name":"read_file","arguments":{"path":"index.html"}}\n```\nthen\n```json\n{"name":"list_files","arguments":{}}\n```'
    expect(parseToolCalls(fenced)).toEqual([
      { name: 'read_file', arguments: { path: 'index.html' } },
      { name: 'list_files', arguments: {} },
    ])
  })

  it('ignores fenced JSON that is not a registered tool call', () => {
    expect(parseToolCalls('```json\n{"name":"config","arguments":{"a":1}}\n```')).toEqual([])
    expect(parseToolCalls('```json\n{"theme":"dark"}\n```')).toEqual([])
  })

  it('ignores fenced content that is not JSON at all', () => {
    expect(parseToolCalls('```json\n{ not json }\n```')).toEqual([])
  })

  it('scans a streaming fence whose file content contains braces and fences', () => {
    const content = '```json\n{"name":"write_file","arguments":{"path":"index.html","content":"<pre>```js\\nif (a) { b() }\\n```</pre>"}}\n```\nDone.'
    const [block] = scanToolBlocks(content)
    expect(block).toMatchObject({ wrapper: 'fence', closed: true })
    expect(JSON.parse(block.json).arguments.content).toContain('if (a) { b() }')
    expect(content.slice(block.end)).toBe('\nDone.')
    // The same block mid-stream, cut inside the string, is not closed and not whole.
    const partial = scanToolBlocks(content.slice(0, 60))
    expect(partial).toHaveLength(1)
    expect(partial[0].closed).toBe(false)
    expect(parseToolCalls(content.slice(0, 60))).toEqual([])
  })

  it('rejects a structural-tag call without a name', () => {
    expect(() => parseToolCalls('<tool_call>{"arguments":{}}</tool_call>')).toThrow(/name/)
  })
})

describe('visibleAssistantText', () => {
  it('drops thinking, tool calls and fenced calls wherever they appear', () => {
    const content = `<think>plan</think>Done.\n${call('list_files', {})}\n\`\`\`json\n{"name":"x","arguments":{}}\n\`\`\`\nMore.`
    expect(visibleAssistantText(content)).toBe('Done.\n\n\nMore.')
  })

  it('hides an unterminated fenced call while it streams', () => {
    expect(visibleAssistantText('Sure.\n```json\n{"name":"write_file","arguments":{"path"')).toBe('Sure.')
    expect(visibleAssistantText('Sure.\n```json\n{"name')).toBe('Sure.')
    expect(visibleAssistantText('Sure.\n```json\n')).toBe('Sure.')
  })

  it('hides an unterminated tool call while it streams', () => {
    expect(visibleAssistantText('Working.\n<tool_call>\n{"name":"write_file"')).toBe('Working.')
  })
})

describe('structuralTag', () => {
  it('declares a tag per tool for both the Qwen trigger and a Markdown fence', () => {
    const { format } = structuralTag
    const names = ['write_file', 'read_file', 'list_files', 'run_js', 'get_dom']
    expect(format.triggers).toEqual(['<tool_call>', '```'])
    expect(format.tags.map((tag) => tag.begin)).toEqual([
      ...names.map((name) => `<tool_call>\n{"name":"${name}","arguments":`),
      ...names.map((name) => `\`\`\`json\n{"name":"${name}","arguments":`),
    ])
    for (const tag of format.tags) {
      expect(tag.begin.startsWith(format.triggers.find((t) => tag.begin.startsWith(t)) ?? '\0')).toBe(true)
      expect(['}\n</tool_call>', '}\n```']).toContain(tag.end)
      expect(tag.content.json_schema.additionalProperties).toBe(false)
    }
  })
})

describe('runTool', () => {
  it('reports an unknown tool instead of throwing', async () => {
    await expect(runTool({ name: 'deploy', arguments: {} })).resolves.toMatchObject({
      ok: false,
      summary: 'Unknown tool: deploy',
    })
  })

  it('reports argument validation failures as tool errors', async () => {
    await expect(runTool({ name: 'read_file', arguments: {} })).resolves.toMatchObject({
      ok: false,
      summary: expect.stringContaining('path'),
    })
  })

  it('lists the starter project', async () => {
    const result = await runTool({ name: 'list_files', arguments: {} })
    expect(result.ok).toBe(true)
    expect((result.value as Array<{ path: string }>).map((file) => file.path)).toEqual([
      'app.js',
      'index.html',
      'styles.css',
    ])
  })

  it('refuses to overwrite an edited file the turn has not read, then allows it', async () => {
    const { projectFS } = await import('@/sandbox/fs')
    vi.mock('@/sandbox/runtime', () => ({
      sandboxBridge: {
        getDocumentRevision: () => 0,
        waitForReloadAfter: async () => {},
        getConsoleEntries: () => [],
      },
    }))
    projectFS.reset()
    const turn = createTurnContext()

    // Untouched starter files are free to replace: a fresh build costs no extra round.
    await expect(runTool({ name: 'write_file', arguments: { path: 'styles.css', content: 'a{}' } }, turn)).resolves.toMatchObject({ ok: true })

    // A second turn finds an edited file it has not seen.
    const later = createTurnContext()
    const refused = await runTool({ name: 'write_file', arguments: { path: './styles.css', content: 'b{}' } }, later)
    expect(refused.ok).toBe(false)
    expect(refused.summary).toMatch(/read_file/)
    expect(projectFS.read('styles.css')).toBe('a{}')

    await runTool({ name: 'read_file', arguments: { path: 'styles.css' } }, later)
    await expect(runTool({ name: 'write_file', arguments: { path: './styles.css', content: 'b{}' } }, later)).resolves.toMatchObject({ ok: true })
    expect(projectFS.read('styles.css')).toBe('b{}')

    // Rewriting a file written earlier in the same turn is an edit the model can see.
    await expect(runTool({ name: 'write_file', arguments: { path: 'styles.css', content: 'c{}' } }, later)).resolves.toMatchObject({ ok: true })
    projectFS.reset()
  })

  it('truncates long files on read', async () => {
    const { projectFS } = await import('@/sandbox/fs')
    projectFS.write('big.txt', 'x'.repeat(9_000))
    const result = await runTool({ name: 'read_file', arguments: { path: 'big.txt' } })
    expect(result.ok).toBe(true)
    expect(String(result.value)).toHaveLength(8_000 + '\n\n<!-- truncated after 8000 characters -->'.length)
    projectFS.reset()
  })
})
