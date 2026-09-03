import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetAgentConfig, setAgentConfig } from './config'
import {
  applyEdit,
  createTurnContext,
  describeTools,
  parseToolCalls,
  runTool,
  scanToolBlocks,
  structuralTagFor,
  visibleAssistantText,
} from './tools'

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
  afterEach(() => resetAgentConfig())

  it('declares a tag per tool for both the Qwen trigger and a Markdown fence', () => {
    const { format } = structuralTagFor({ requireCall: false })
    const names = ['write_file', 'edit_file', 'read_file', 'list_files', 'run_js', 'get_dom']
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

  // A variant that disables a tool must disable it everywhere at once: an advertised tool the
  // grammar rejects, or a grammar tag the prompt never mentions, both read as model failures.
  it('follows the enabled tools and triggers into both the grammar and the prompt', () => {
    setAgentConfig({ tools: ['write_file', 'read_file'], triggers: ['tag'] })
    const { format } = structuralTagFor({ requireCall: true })
    expect(format.triggers).toEqual(['<tool_call>'])
    expect(format.tags.map((tag) => tag.begin)).toEqual([
      '<tool_call>\n{"name":"write_file","arguments":',
      '<tool_call>\n{"name":"read_file","arguments":',
    ])
    expect(format.at_least_one).toBe(true)
    expect(describeTools()).toBe(
      '- write_file {"path": string, "content": string} — create or replace a project file with its complete new content.\n' +
        '- read_file {"path": string} — read a project file. Long files are truncated.',
    )
  })

  it('arms the bare-object trigger only when it is enabled', () => {
    const bare = '{"name":"list_files","arguments":{}}'
    expect(parseToolCalls(`Sure.\n${bare}\nDone.`)).toEqual([])
    setAgentConfig({ triggers: ['tag', 'fence', 'bare'] })
    expect(parseToolCalls(`Sure.\n${bare}\nDone.`)).toEqual([{ name: 'list_files', arguments: {} }])
    expect(structuralTagFor({ requireCall: false }).format.triggers).toContain('{"name":')
  })
})

describe('applyEdit', () => {
  const css = 'body {\n  margin: 0;\n}\n\nh1 {\n  color: red;\n}\n'

  it('replaces one exact passage and leaves the rest alone', async () => {
    const outcome = await applyEdit(css, 'color: red;', 'color: blue;')
    expect(outcome).toMatchObject({ replacements: 1, tier: 'exact' })
    expect(outcome.content).toBe(css.replace('red', 'blue'))
  })

  // A model reproducing a block from memory gets its formatting wrong far more often than its
  // words. Refusing those edits sends it back to rewriting whole files by hand, which is the
  // failure edit_file exists to prevent.
  it('tolerates an indent or a line break the file does not have', async () => {
    const outcome = await applyEdit(css, 'h1 {\ncolor: red;\n}', 'h1 { color: blue; }')
    expect(outcome).toMatchObject({ tier: 'spacing' })
    expect(outcome.content).toBe('body {\n  margin: 0;\n}\n\nh1 { color: blue; }\n')
  })

  it('tolerates whitespace present on one side and absent on the other', async () => {
    // `margin:0;` against a file that says `margin: 0;` — no amount of collapsing runs of
    // whitespace reaches this one, because one side has none to collapse.
    const packed = await applyEdit(css, 'body{margin:0;}', 'body {\n  margin: 1rem;\n}')
    expect(packed).toMatchObject({ tier: 'packing' })
    expect(packed.content).toBe('body {\n  margin: 1rem;\n}\n\nh1 {\n  color: red;\n}\n')

    const js = 'const total = a + b;\nconsole.log(total);\n'
    expect(await applyEdit(js, 'const total=a+b;', 'const total = a * b;')).toMatchObject({
      tier: 'packing',
      content: 'const total = a * b;\nconsole.log(total);\n',
    })
  })

  // Files are formatted on write, so the file is canonical and the fragment is not. Running the
  // fragment through the same formatter settles quote style, semicolons and `<br>`/`<br />`.
  it('matches a fragment that only differs by formatting', async () => {
    const page = '<main>\n  <img src="a.png" alt="A" />\n</main>\n'
    const outcome = await applyEdit(page, "<img src='a.png' alt='A'>", '<img src="b.png" alt="B" />', {
      path: 'index.html',
    })
    expect(outcome).toMatchObject({ tier: 'formatted' })
    expect(outcome.content).toBe('<main>\n  <img src="b.png" alt="B" />\n</main>\n')

    // A missing semicolon is beyond every whitespace pass; the CSS parser puts it back.
    const dropped = await applyEdit(css, 'body{margin:0}', 'body {\n  margin: 1rem;\n}', { path: 'styles.css' })
    expect(dropped).toMatchObject({ tier: 'formatted' })
    expect(dropped.content).toBe('body {\n  margin: 1rem;\n}\n\nh1 {\n  color: red;\n}\n')
  })

  it('refuses an ambiguous match unless replace_all is set', async () => {
    const source = 'a { color: red; }\nb { color: red; }\n'
    expect((await applyEdit(source, 'color: red;', 'color: blue;', { path: 'styles.css' })).error).toMatch(
      /matches 2 places in styles.css/,
    )
    expect(await applyEdit(source, 'color: red;', 'color: blue;', { replaceAll: true })).toMatchObject({
      replacements: 2,
      content: 'a { color: blue; }\nb { color: blue; }\n',
    })
  })

  // The measured 1.5B miss: the right element, the wrong text for it.
  it('names the closest line when the passage is absent', async () => {
    const outcome = await applyEdit(css, 'h1 {\n  color: green;\n}', 'x', { path: 'styles.css' })
    expect(outcome.content).toBeUndefined()
    expect(outcome.error).toMatch(/styles.css does not contain that text/)
    expect(outcome.error).toMatch(/closest line is “h1 \{”/)

    const page = '<body>\n  <header class="site-header">Ember &amp; Oak</header>\n</body>\n'
    expect((await applyEdit(page, '<header>', '<header class="x">', { path: 'index.html' })).error).toContain(
      'closest line is “<header class="site-header">Ember &amp; Oak</header>”',
    )
  })

  it('rejects an empty or unchanged passage', async () => {
    expect((await applyEdit(css, '', 'x')).error).toMatch(/is the text to replace and must not be empty/)
    expect((await applyEdit(css, 'body', 'body')).error).toMatch(/identical/)
  })
})

describe('runTool', () => {
  it('reports an unknown tool instead of throwing', async () => {
    await expect(runTool({ name: 'deploy', arguments: {} })).resolves.toMatchObject({
      ok: false,
      summary: expect.stringContaining('Unknown tool: deploy'),
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
    await expect(runTool({ name: 'write_file', arguments: { path: 'styles.css', content: 'a {\n}\n' } }, turn)).resolves.toMatchObject({ ok: true })

    // A second turn finds an edited file it has not seen. The refusal carries the file with
    // it, so the model can rewrite in the same round instead of spending one on read_file.
    const later = createTurnContext()
    const refused = await runTool({ name: 'write_file', arguments: { path: './styles.css', content: 'b {\n}\n' } }, later)
    expect(refused.ok).toBe(false)
    expect(refused.summary).toMatch(/have not read it this turn/)
    expect(refused.value).toEqual({ path: 'styles.css', content: 'a {\n}\n' })
    expect(projectFS.read('styles.css')).toBe('a {\n}\n')

    await runTool({ name: 'read_file', arguments: { path: 'styles.css' } }, later)
    await expect(runTool({ name: 'write_file', arguments: { path: './styles.css', content: 'b {\n}\n' } }, later)).resolves.toMatchObject({ ok: true })
    expect(projectFS.read('styles.css')).toBe('b {\n}\n')

    // Rewriting a file written earlier in the same turn is an edit the model can see.
    await expect(runTool({ name: 'write_file', arguments: { path: 'styles.css', content: 'c {\n}\n' } }, later)).resolves.toMatchObject({ ok: true })
    projectFS.reset()
  })

  // The refusal hands the file over, so it counts as the read it was asking for. Without that
  // the retry is refused again and the turn spends every round being handed the same file.
  it('accepts the rewrite that follows a refusal', async () => {
    const { projectFS } = await import('@/sandbox/fs')
    projectFS.reset()
    projectFS.write('styles.css', 'body {\n  margin: 0;\n}\n')
    const turn = createTurnContext()

    const refused = await runTool({ name: 'write_file', arguments: { path: 'styles.css', content: 'a {\n}\n' } }, turn)
    expect(refused.ok).toBe(false)
    expect(refused.value).toMatchObject({ content: 'body {\n  margin: 0;\n}\n' })

    const retry = await runTool({ name: 'write_file', arguments: { path: 'styles.css', content: 'a {\n}\n' } }, turn)
    expect(retry.ok).toBe(true)
    expect(projectFS.read('styles.css')).toBe('a {\n}\n')
    projectFS.reset()
  })

  it('answers a missed edit with the file, once', async () => {
    const { projectFS } = await import('@/sandbox/fs')
    projectFS.reset()
    projectFS.write('index.html', '<header class="site-header">Menu</header>\n')
    const turn = createTurnContext()

    // Exactly the measured 1.5B miss: it edits `<header>` in a page whose header has a class.
    const missed = await runTool(
      { name: 'edit_file', arguments: { path: 'index.html', old_text: '<header>', new_text: '<header class="x">' } },
      turn,
    )
    expect(missed.ok).toBe(false)
    expect(missed.value).toMatchObject({ path: 'index.html', content: '<header class="site-header">Menu</header>\n' })

    // A second miss does not repeat the file: it has already been sent this turn.
    const again = await runTool(
      { name: 'edit_file', arguments: { path: 'index.html', old_text: '<footer>', new_text: '<footer class="x">' } },
      turn,
    )
    expect(again.value).toBeUndefined()
    projectFS.reset()
  })

  // The measured 1.5B failure after a refusal: it copies the file back verbatim, and the turn
  // would otherwise end reporting success over a page nothing happened to.
  it('refuses a write that changes nothing', async () => {
    const { projectFS } = await import('@/sandbox/fs')
    projectFS.reset()
    const page = '<main>Ember &amp; Oak</main>\n'
    projectFS.write('index.html', page)
    const turn = createTurnContext()
    turn.readPaths.add('index.html')

    const echoed = await runTool({ name: 'write_file', arguments: { path: 'index.html', content: page } }, turn)
    expect(echoed.ok).toBe(false)
    expect(echoed.summary).toMatch(/index.html is unchanged/)

    // Formatting is not a change either: the same file, tidied, is still the same file.
    projectFS.write('styles.css', 'body {\n  margin: 0;\n}\n')
    turn.readPaths.add('styles.css')
    const tidied = await runTool({ name: 'write_file', arguments: { path: 'styles.css', content: 'body{margin:0}' } }, turn)
    expect(tidied.ok).toBe(false)
    projectFS.reset()
  })

  it('formats what it writes and reports a syntax error as a failed call', async () => {
    const { projectFS } = await import('@/sandbox/fs')
    projectFS.reset()
    const turn = createTurnContext()

    const written = await runTool(
      { name: 'write_file', arguments: { path: 'styles.css', content: 'body{margin:0;color:#fff}' } },
      turn,
    )
    expect(written.ok).toBe(true)
    expect(projectFS.read('styles.css')).toBe('body {\n  margin: 0;\n  color: #fff;\n}\n')

    const broken = await runTool({ name: 'write_file', arguments: { path: 'app.js', content: 'function f( {' } }, turn)
    expect(broken.ok).toBe(false)
    expect(broken.summary).toMatch(/syntax error at Unexpected token/)
    // Stored anyway: a refused write would leave read_file answering with content the model
    // never sent, and it would then be debugging a file it cannot see.
    expect(projectFS.read('app.js')).toBe('function f( {')
    projectFS.reset()
  })

  it('edits a file in place, and says why when the passage does not match', async () => {
    const { projectFS } = await import('@/sandbox/fs')
    projectFS.reset()
    projectFS.write('styles.css', 'body {\n  margin: 0;\n}\n')
    const turn = createTurnContext()

    const edited = await runTool(
      { name: 'edit_file', arguments: { path: 'styles.css', old_text: 'margin: 0;', new_text: 'margin: 1rem;' } },
      turn,
    )
    expect(edited.ok).toBe(true)
    expect(edited.summary).toMatch(/Edited styles.css: 1 replacement/)
    expect(projectFS.read('styles.css')).toBe('body {\n  margin: 1rem;\n}\n')
    // The edit is proof the model has seen the file, so the write guard steps aside after it.
    expect(turn.readPaths.has('styles.css')).toBe(true)

    const missed = await runTool(
      { name: 'edit_file', arguments: { path: 'styles.css', old_text: 'padding: 0;', new_text: 'padding: 1rem;' } },
      turn,
    )
    expect(missed.ok).toBe(false)
    expect(missed.summary).toMatch(/does not contain that text/)
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
