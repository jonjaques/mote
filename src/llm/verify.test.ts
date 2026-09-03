import { describe, expect, it } from 'vitest'

import { projectFS } from '@/sandbox/fs'

import { inspectProject } from './verify'

// Taken from the filesystem rather than transcribed: the check turns on byte equality with the
// starter, so a copy in this file would drift and quietly stop testing anything.
function starterFiles(): Record<string, string> {
  projectFS.reset()
  return { ...projectFS.getSnapshot().files }
}

const page = (body: string, head = '') =>
  `<!doctype html>\n<html lang="en">\n<head>${head}</head>\n<body>${body}</body>\n</html>\n`

describe('inspectProject', () => {
  it('says nothing about a page that holds together', () => {
    expect(
      inspectProject({
        'index.html': page('<h1 class="title">Hi</h1>', '<link rel="stylesheet" href="styles.css" />'),
        'styles.css': '.title { font-size: 3rem; }\n',
      }),
    ).toEqual([])
  })

  it('reports a stylesheet the page links but never wrote', () => {
    const [finding, ...rest] = inspectProject({
      'index.html': page('<h1>Coffee</h1>', '<link rel="stylesheet" href="styles.css" />'),
    })
    expect(finding).toMatch(/index.html references styles.css/)
    expect(finding).toMatch(/Write it, or move that content inline/)
    expect(rest).toEqual([])
  })

  it('reports a linked file that is still the starter, but only for an authored page', () => {
    const starter = starterFiles()
    // The untouched starter links the untouched stylesheet and script on purpose.
    expect(inspectProject(starter)).toEqual([])

    const rewritten = { ...starter, 'index.html': page('<h1>Coffee</h1>', '<link rel="stylesheet" href="styles.css" />') }
    expect(inspectProject(rewritten)[0]).toMatch(/still the starter file/)
  })

  // The measured 7B miss on "make the header sticky": a .sticky rule added, never applied.
  it('reports styled classes that no element carries', () => {
    const findings = inspectProject({
      'index.html': page('<header>Menu</header>'),
      'styles.css': '.sticky { position: sticky; top: 0; }\n.chip { border: 0; }\n',
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatch(/\.sticky, \.chip are styled but no elements in index.html carry those classes/)
  })

  // The measured 1.5B answer to "make the header sticky": class added, rule never written.
  it('reports classes the markup uses that no rule styles', () => {
    const findings = inspectProject({
      'index.html': page('<header class="site-header sticky">Menu</header>'),
      'styles.css': '.site-header { display: flex; }\n',
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatch(/index.html uses \.sticky, but no rule styles it/)
  })

  it('leaves alone classes the page or its script applies at runtime', () => {
    expect(
      inspectProject({
        'index.html': page('<header class="bar">Menu</header><style>.open { display: block; }</style>'),
        'styles.css': '.bar { position: sticky; }\n.lit { color: red; }\n',
        'app.js': 'document.querySelector("header").classList.toggle("lit");\nel.className = "open";\n',
      }),
    ).toEqual([])
  })

  it('reads selectors, not declaration values', () => {
    expect(
      inspectProject({
        'index.html': page('<main>x</main>'),
        'styles.css': 'main {\n  padding: 1.5rem 0.5rem;\n  font: 700 clamp(2rem, 7vw, 4rem)/.95 system-ui;\n}\n',
      }),
    ).toEqual([])
  })

  it('caps what it says, because every finding costs a round', () => {
    const findings = inspectProject({
      'index.html': page('<h1>x</h1>', '<link rel="stylesheet" href="theme.css" /><script src="extra.js"></script>'),
      'styles.css': '.a{}\n.b{}\n.c{}\n.d{}\n.e{}\n',
    })
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatch(/theme.css, extra.js/)
    expect(findings[1]).toMatch(/\.a, \.b, \.c and 2 more/)
  })
})
