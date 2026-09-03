import { beforeEach, describe, expect, it } from 'vitest'

import { assembleDocument } from './document'
import { projectFS } from './fs'
import { SANDBOX_RUNTIME } from './runtime'

describe('assembleDocument', () => {
  beforeEach(() => {
    projectFS.reset()
  })

  it('injects the CSP and runtime first in head and inlines the linked files', () => {
    const html = assembleDocument()
    const head = html.indexOf('<head>')
    const csp = html.indexOf('http-equiv="Content-Security-Policy"')
    const runtime = html.indexOf('<script data-mote-runtime>')
    const style = html.indexOf('<style data-mote-file="styles.css">')
    const app = html.indexOf('<script data-mote-file="app.js">')
    expect(head).toBeGreaterThanOrEqual(0)
    expect(csp).toBeGreaterThan(head)
    expect(runtime).toBeGreaterThan(csp)
    expect(style).toBeGreaterThan(runtime)
    expect(app).toBeGreaterThan(style)
    expect(html).not.toContain('<link rel="stylesheet" href="styles.css"')
    expect(html).not.toContain('<script src="app.js">')
    expect(html).toContain(projectFS.read('app.js').split('\n')[0])
  })

  it('keeps the sandbox locked down: no network, no frames, but inline script and eval', () => {
    const csp = assembleDocument().match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toMatch(/script-src [^;]*'unsafe-inline'/)
    expect(csp).toMatch(/script-src [^;]*'unsafe-eval'/)
  })

  it('leaves a self-contained page alone apart from the head injection', () => {
    projectFS.write('index.html', '<!doctype html><html><head><title>t</title></head><body><style>b{color:red}</style></body></html>')
    const html = assembleDocument()
    expect(html).not.toContain('data-mote-file="styles.css"')
    expect(html).not.toContain('data-mote-file="app.js"')
    expect(html).toContain('<style>b{color:red}</style>')
    expect(html).toContain('data-mote-runtime')
  })

  it('accepts single quotes and ./ prefixes on the link and script tags', () => {
    projectFS.write(
      'index.html',
      "<html><head><link rel='stylesheet' href='./styles.css'></head><body><script src='./app.js'></script></body></html>",
    )
    const html = assembleDocument()
    expect(html).toContain('data-mote-file="styles.css"')
    expect(html).toContain('data-mote-file="app.js"')
  })

  it('prepends a head when the document has none', () => {
    projectFS.write('index.html', '<p>bare</p>')
    const html = assembleDocument()
    expect(html.startsWith('<head>')).toBe(true)
    expect(html).toContain('data-mote-runtime')
    expect(html).toContain('<p>bare</p>')
  })

  it('escapes closing tags inside inlined content so the document cannot end early', () => {
    projectFS.write('app.js', 'const s = "</script><b>x</b>"')
    projectFS.write('styles.css', 'p::after { content: "</style>" }')
    const html = assembleDocument()
    expect(html).toContain('<\\/script><b>x</b>')
    expect(html).toContain('content: "<\\/style>"')
    expect(html.match(/<\/script>/g)?.length).toBe(2)
  })

  it('inlines the runtime as a self-invoking bootstrap', () => {
    expect(SANDBOX_RUNTIME.startsWith('(function sandboxBootstrap()')).toBe(true)
    expect(SANDBOX_RUNTIME.endsWith(')();')).toBe(true)
    expect(SANDBOX_RUNTIME).toContain('mote:ready')
  })
})
