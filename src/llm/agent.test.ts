import { beforeEach, describe, expect, it, vi } from 'vitest'

import { projectFS } from '@/sandbox/fs'

const create = vi.fn()
const engine = {
  modelId: ['Qwen3-0.6B-q4f16_1-MLC (local)'],
  chat: { completions: { create } },
}

vi.mock('./engine', () => ({
  prepareEngine: async () => ({ engine, appConfig: {}, models: [] }),
}))

// The real bridge needs an iframe; write_file only waits for it, so a bridge that is always
// ready is enough to exercise the loop without a document.
vi.mock('@/sandbox/runtime', () => ({
  sandboxBridge: {
    getDocumentRevision: () => 0,
    waitForReloadAfter: async () => {},
    getConsoleEntries: () => [],
    run: async (code: string) => ({ type: 'mote:response', id: 'x', ok: true, result: JSON.stringify(code.length) }),
    getDom: async () => ({ type: 'mote:response', id: 'x', ok: true, result: '<html></html>' }),
  },
}))

const { runAgent } = await import('./agent')
type Messages = Array<{ role: string; content: string }>

function reply(text: string, finishReason: 'stop' | 'length' = 'stop') {
  const pieces = text.match(/[\s\S]{1,24}/g) ?? ['']
  return (async function* () {
    for (const [index, content] of pieces.entries()) {
      yield {
        choices: [{ delta: { content }, finish_reason: index === pieces.length - 1 ? finishReason : null }],
      }
    }
  })()
}

const toolCall = (name: string, args: Record<string, unknown>) =>
  `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`

function messagesOfCall(index: number): Messages {
  return (create.mock.calls[index][0] as { messages: Messages }).messages
}

describe('runAgent', () => {
  const callbacks = { onText: vi.fn(), onTool: vi.fn() }

  beforeEach(() => {
    create.mockReset()
    callbacks.onText.mockReset()
    callbacks.onTool.mockReset()
    engine.modelId = ['Qwen3-0.6B-q4f16_1-MLC (local)']
    projectFS.reset()
  })

  it('sends the page-builder prompt with structural tags and the agreed sampling options', async () => {
    create.mockImplementationOnce(async () => reply('Hello there.'))
    const result = await runAgent('hi', [{ role: 'user', content: 'earlier' }], callbacks)

    expect(result).toEqual({ content: 'Hello there.', cutOff: false, rounds: 1 })
    const request = create.mock.calls[0][0]
    expect(request.messages[0]).toMatchObject({ role: 'system' })
    expect(request.messages[0].content).toContain('You are Mote')
    expect(request.messages.slice(1)).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'user', content: 'hi' },
    ])
    expect(request).toMatchObject({
      stream: true,
      max_tokens: 4096,
      temperature: 0.2,
      extra_body: { enable_thinking: false },
      response_format: {
        type: 'structural_tag',
        structural_tag: { format: { triggers: ['<tool_call>', '```'], at_least_one: true } },
      },
    })
    expect(callbacks.onTool).not.toHaveBeenCalled()
    expect(callbacks.onText).toHaveBeenLastCalledWith('Hello there.')
  })

  it('runs a tool, feeds the result back as a user tool_response and returns the follow-up text', async () => {
    create
      .mockImplementationOnce(async () => reply(`Checking.\n${toolCall('list_files', {})}`))
      .mockImplementationOnce(async () => reply('There are three files.'))
    const result = await runAgent('what files exist?', [], callbacks)

    expect(result).toEqual({ content: 'There are three files.', cutOff: false, rounds: 2 })
    expect(callbacks.onTool).toHaveBeenCalledTimes(2)
    // Only the opening round is forced to call a tool; the answer round may be prose.
    expect(create.mock.calls[0][0].response_format.structural_tag.format.at_least_one).toBe(true)
    expect(create.mock.calls[1][0].response_format.structural_tag.format.at_least_one).toBe(false)
    expect(callbacks.onTool.mock.calls[0][0]).toMatchObject({ status: 'running', call: { name: 'list_files' } })
    expect(callbacks.onTool.mock.calls[1][0]).toMatchObject({ status: 'complete', result: { ok: true } })

    const second = messagesOfCall(1)
    expect(second.at(-2)).toMatchObject({ role: 'assistant' })
    expect(second.at(-2)?.content).toContain('<tool_call>')
    expect(second.at(-1)?.role).toBe('user')
    expect(second.at(-1)?.content).toMatch(/^<tool_response>.*<\/tool_response>$/)
    expect(JSON.parse(second.at(-1)!.content.slice('<tool_response>'.length, -'</tool_response>'.length))).toMatchObject({
      name: 'list_files',
      ok: true,
      result: [{ path: 'app.js' }, { path: 'index.html' }, { path: 'styles.css' }],
    })
    expect(second.some((message) => message.role === 'tool')).toBe(false)
  })

  it('stops after a successful write_file round and summarises', async () => {
    create.mockImplementationOnce(async () =>
      reply(toolCall('write_file', { path: 'index.html', content: '<p>blue</p>' })),
    )
    const result = await runAgent('make it blue', [], callbacks)

    expect(create).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ content: 'Updated index.html and reloaded the preview.', cutOff: false, rounds: 1 })
    expect(projectFS.read('index.html')).toBe('<p>blue</p>')
    expect(callbacks.onText).toHaveBeenLastCalledWith('Updated index.html and reloaded the preview.')
  })

  it('keeps going when the smart model links styles.css without writing it', async () => {
    engine.modelId = ['Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC (local)']
    create
      .mockImplementationOnce(async () =>
        reply(toolCall('write_file', { path: 'index.html', content: '<link rel="stylesheet" href="styles.css">' })),
      )
      .mockImplementationOnce(async () => reply(toolCall('write_file', { path: 'styles.css', content: 'body{margin:0}' })))
    const result = await runAgent('build a page', [], callbacks)

    expect(create).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ content: 'Updated styles.css and reloaded the preview.', cutOff: false, rounds: 2 })
    expect(projectFS.read('styles.css')).toBe('body{margin:0}')
  })

  it('surfaces a truncated response instead of looping', async () => {
    create.mockImplementationOnce(async () => reply('Half a page', 'length'))
    const result = await runAgent('build', [], callbacks)
    expect(result).toEqual({ content: 'Half a page', cutOff: true, rounds: 1 })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('nudges once on a repeated identical call, then stops', async () => {
    const same = toolCall('run_js', { code: "document.body.classList.add('sticky')" })
    create
      .mockImplementationOnce(async () => reply(same))
      .mockImplementationOnce(async () => reply(same))
      .mockImplementationOnce(async () => reply(same))
    const result = await runAgent('make the header sticky', [], callbacks)

    expect(create).toHaveBeenCalledTimes(3)
    expect(callbacks.onTool).toHaveBeenCalledTimes(2)
    // The loop mutates one messages array, so inspect it for the nudge rather than its tail.
    const nudges = messagesOfCall(2).filter((message) => message.content.includes('already made this call'))
    expect(nudges).toHaveLength(1)
    expect(nudges[0]?.role).toBe('user')
    expect(result.rounds).toBe(3)
    expect(result.content).toMatch(/repeating tool calls/)
  })

  it('treats a read_file cycle as repetition but allows re-reading after a write', async () => {
    const read = (path: string) => toolCall('read_file', { path })
    create
      .mockImplementationOnce(async () => reply(read('index.html')))
      .mockImplementationOnce(async () => reply(read('styles.css')))
      .mockImplementationOnce(async () => reply(read('index.html'))) // repeat → nudge
      .mockImplementationOnce(async () => reply(toolCall('write_file', { path: 'index.html', content: '<p>x</p>' })))
    const result = await runAgent('build', [], callbacks)

    expect(create).toHaveBeenCalledTimes(4)
    expect(callbacks.onTool.mock.calls.filter(([a]) => a.status === 'complete').map(([a]) => a.call.name)).toEqual([
      'read_file',
      'read_file',
      'write_file',
    ])
    expect(result).toEqual({ content: 'Updated index.html and reloaded the preview.', cutOff: false, rounds: 4 })
  })

  it('asks for a corrected call when the tool payload is malformed', async () => {
    create
      .mockImplementationOnce(async () => reply('<tool_call>{"arguments":{}}</tool_call>'))
      .mockImplementationOnce(async () => reply('Sorry, done.'))
    const result = await runAgent('hi', [], callbacks)

    expect(result.content).toBe('Sorry, done.')
    expect(messagesOfCall(1).at(-1)?.content).toContain('could not be parsed')
  })

  it('gives up after eight rounds of tool calls', async () => {
    // Distinct arguments every round so the repeat guard does not end the loop early.
    let n = 0
    create.mockImplementation(async () => reply(toolCall('run_js', { code: `return ${n++}` })))
    const result = await runAgent('loop', [], callbacks)
    expect(create).toHaveBeenCalledTimes(8)
    expect(result.rounds).toBe(8)
    expect(result.content).toMatch(/eight-round/)
  })
})
