// Prettier, in the tab, on every file a tool writes.
//
// It earns its place twice. The obvious half is that a 1.5B model emits a page as one long
// line or with three different indent widths in the same file, and the visitor reads that file
// in the editor. The half that matters more is that `format` is the only cheap parser in the
// project: CSS and JavaScript that cannot be parsed *throw*, with a line and a column, so a
// broken write stops being an invisible failure the model asserts it completed and becomes a
// failed tool call it gets one precise sentence about and can fix on the next round.
//
// The HTML parser is deliberately lenient — it repairs `<div><p>a<div>b</div>` rather than
// refusing it — so a malformed page is quietly corrected instead of reported. It also leaves
// an unparseable inline <script> untouched instead of raising, which is exactly the failure
// worth catching, so embedded scripts are parsed separately below.
//
// The bundles (~930 KB across five files) load on the first write, never at boot: the agent is
// the only caller, and a visitor who never sends a prompt should not pay for a formatter.

export interface FormatResult {
  /** What to store: formatted when that worked, otherwise exactly what the model sent. */
  content: string
  changed: boolean
  /** True when the formatter ran and produced the content above. */
  formatted: boolean
  /** One line, with the position translated into file coordinates. Absent when it parsed. */
  error?: string
}

type Parser = 'html' | 'css' | 'babel' | 'json'

interface Prettier {
  format(source: string, options: Record<string, unknown>): Promise<string>
  plugins: unknown[]
}

const PARSERS: Record<string, Parser> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'babel',
  mjs: 'babel',
  json: 'json',
}

// Options, not a config file: the project is three files in a virtual filesystem and there is
// nowhere for a .prettierrc to live. 100 columns matches this repo's own sources.
const OPTIONS = { printWidth: 100, tabWidth: 2, htmlWhitespaceSensitivity: 'css' as const }

let loading: Promise<Prettier | undefined> | undefined

async function loadPrettier(): Promise<Prettier | undefined> {
  loading ??= (async () => {
    try {
      const [standalone, html, postcss, babel, estree] = await Promise.all([
        import('prettier/standalone'),
        import('prettier/plugins/html'),
        import('prettier/plugins/postcss'),
        import('prettier/plugins/babel'),
        import('prettier/plugins/estree'),
      ])
      return {
        format: standalone.format,
        plugins: [html.default, postcss.default, babel.default, estree.default],
      }
    } catch {
      // Offline with the chunk uncached, or a build that dropped it. A write must still land:
      // unformatted output is a cosmetic loss, a refused write is a broken agent.
      return undefined
    }
  })()
  return loading
}

export function parserFor(path: string): Parser | undefined {
  return PARSERS[path.toLowerCase().split('.').pop() ?? '']
}

// Prettier reports `Unexpected token (12:5)` on the first line and then a code frame. The frame
// is worth more context than it costs a 8k window, so only the sentence survives — with the
// line moved into whole-file coordinates when the source was an embedded <script>.
function describeSyntaxError(error: unknown, lineOffset = 0): string {
  const raw = error instanceof Error ? error.message : String(error)
  const first = raw.split('\n')[0].trim()
  if (!lineOffset) return first
  return first.replace(/\((\d+):(\d+)\)/, (_, line: string, column: string) => `(${Number(line) + lineOffset}:${column})`)
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

// Inline JavaScript only: a `src` attribute points at another project file that is formatted
// on its own write, and a `type` this list does not know (importmap, text/template, x-tmpl) is
// not JavaScript and must not be parsed as any.
function isInlineJavaScript(attributes: string): boolean {
  if (/\bsrc\s*=/i.test(attributes)) return false
  const type = attributes.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase()
  return !type || type === 'module' || type === 'text/javascript' || type === 'application/javascript'
}

async function firstInlineScriptError(prettier: Prettier, html: string): Promise<string | undefined> {
  for (const match of html.matchAll(SCRIPT)) {
    const [whole, attributes, body] = match
    if (!isInlineJavaScript(attributes) || !body.trim()) continue
    try {
      await prettier.format(body, { ...OPTIONS, parser: 'babel', plugins: prettier.plugins })
    } catch (error) {
      const before = html.slice(0, (match.index ?? 0) + whole.indexOf(body))
      return `inline <script>: ${describeSyntaxError(error, before.split('\n').length - 1)}`
    }
  }
  return undefined
}

/**
 * Format one project file. Never throws: a file type with no parser, or a formatter that would
 * not load, comes back unchanged and `formatted: false`.
 */
export async function formatProjectFile(path: string, source: string): Promise<FormatResult> {
  const parser = parserFor(path)
  if (!parser) return { content: source, changed: false, formatted: false }

  const prettier = await loadPrettier()
  if (!prettier) return { content: source, changed: false, formatted: false }

  let content: string
  try {
    content = await prettier.format(source, { ...OPTIONS, parser, plugins: prettier.plugins })
  } catch (error) {
    return { content: source, changed: false, formatted: false, error: describeSyntaxError(error) }
  }

  const error = parser === 'html' ? await firstInlineScriptError(prettier, content) : undefined
  return { content, changed: content !== source, formatted: true, error }
}
