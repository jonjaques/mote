import { describe, expect, it } from 'vitest'

import { formatProjectFile, parserFor } from './format'

describe('formatProjectFile', () => {
  it('formats the three project languages', async () => {
    await expect(formatProjectFile('styles.css', 'body{margin:0;color:#fff}')).resolves.toMatchObject({
      content: 'body {\n  margin: 0;\n  color: #fff;\n}\n',
      changed: true,
      formatted: true,
    })
    await expect(formatProjectFile('app.js', "const a=1;console.log('hi',a)")).resolves.toMatchObject({
      content: 'const a = 1;\nconsole.log("hi", a);\n',
    })
    const html = await formatProjectFile('index.html', '<main><p class="a">Hi</p></main>')
    expect(html.content).toBe('<main><p class="a">Hi</p></main>\n')
  })

  // The HTML parser repairs rather than refuses, which is the behaviour worth having: a page
  // with a stray tag renders, and the model does not spend a round on markup nesting.
  it('repairs mis-nested markup instead of reporting it', async () => {
    const result = await formatProjectFile('index.html', '<div><p>hello<div>world</div>')
    expect(result.error).toBeUndefined()
    expect(result.content).toBe('<div>\n  <p>hello</p>\n  <div>world</div>\n</div>\n')
  })

  it('reports a stylesheet that cannot be parsed and keeps what the model sent', async () => {
    const source = 'body { color: ; .x {'
    const result = await formatProjectFile('styles.css', source)
    expect(result).toMatchObject({ content: source, changed: false, formatted: false })
    expect(result.error).toMatch(/Unclosed block \(1:17\)/)
  })

  it('reports a script that cannot be parsed', async () => {
    const result = await formatProjectFile('app.js', 'function f( { return 1 }')
    expect(result.error).toMatch(/Unexpected token/)
  })

  // Prettier leaves an unparseable inline <script> alone rather than raising, so a page whose
  // JavaScript is broken formats cleanly and renders dead. That is the failure worth catching.
  it('finds a syntax error inside an inline script, in whole-file line numbers', async () => {
    const source = '<!doctype html>\n<html>\n  <body>\n    <h1>Hi</h1>\n    <script>\n      const x = (;\n    </script>\n  </body>\n</html>\n'
    const result = await formatProjectFile('index.html', source)
    expect(result.formatted).toBe(true)
    expect(result.error).toMatch(/^inline <script>: /)
    // The offending line is 6 of the file, not 2 of the script.
    expect(result.error).toMatch(/\(6:\d+\)/)
  })

  it('ignores a script element that is not inline JavaScript', async () => {
    const result = await formatProjectFile(
      'index.html',
      '<body>\n  <script src="app.js"></script>\n  <script type="text/template">{{ not js }}</script>\n</body>\n',
    )
    expect(result.error).toBeUndefined()
  })

  it('leaves a file type it has no parser for exactly as it is', async () => {
    expect(parserFor('notes.md')).toBeUndefined()
    await expect(formatProjectFile('notes.md', '#   Heading')).resolves.toEqual({
      content: '#   Heading',
      changed: false,
      formatted: false,
    })
  })
})
