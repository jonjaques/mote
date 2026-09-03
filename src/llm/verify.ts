// What the project says about itself after a writing round.
//
// Both checks here come out of `pnpm cdp:agent` failures, not from a list of things a linter
// could look for. A round that writes files and stops is the loop's success path, so a page
// that is wrong in one of these two specific ways is otherwise reported to the user as done:
//
//   1. index.html links styles.css and styles.css was never written (measured on the 1.5B, and
//      previously papered over by a `smartPageNeedsStyles` special case in the agent).
//   2. styles.css grows a rule whose class no element ever carries — the exact 7B miss on
//      "make the header sticky": a `.sticky` block added, the class never applied.
//
// Findings are phrased as facts about the project and capped at two, because each one costs a
// round and an 8k window. Anything a reasonable page might do on purpose must not appear here.

import { isPristineContent } from '@/sandbox/fs'

const CLASS_ATTRIBUTE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
const LOCAL_REFERENCE = /<(?:link[^>]*\bhref|script[^>]*\bsrc)\s*=\s*["']([^"']+)["']/gi
const COMMENT = /\/\*[\s\S]*?\*\//g

function isLocalPath(reference: string): boolean {
  return !/^(?:[a-z]+:|\/\/|#|data:)/i.test(reference)
}

// Selector text only: everything before each `{`, so a declaration value can never be read as
// a class. `.5rem` and `1.5rem` do not match — a class has to start with a letter, `_` or `-`.
function classesDefinedIn(css: string): Set<string> {
  const names = new Set<string>()
  for (const chunk of css.replace(COMMENT, ' ').split('}')) {
    const selector = chunk.split('{')[0]
    if (chunk.indexOf('{') === -1) continue
    for (const match of selector.matchAll(/\.([A-Za-z_-][\w-]*)/g)) names.add(match[1])
  }
  return names
}

function classesUsedIn(html: string): Set<string> {
  const names = new Set<string>()
  for (const match of html.matchAll(CLASS_ATTRIBUTE)) {
    for (const name of (match[1] ?? match[2] ?? match[3] ?? '').split(/\s+/)) {
      if (name) names.add(name)
    }
  }
  return names
}

/**
 * Up to two sentences about the project as it now stands, or an empty array when it holds
 * together. `files` is the whole snapshot: the checks are cross-file by nature and a round can
 * write index.html and styles.css in either order.
 */
export function inspectProject(files: Readonly<Record<string, string>>): string[] {
  const html = files['index.html']
  if (typeof html !== 'string') return []
  const findings: string[] = []

  // A reference is broken when the file is absent, and — for a page the model actually wrote —
  // when the file is still the untouched starter. That second case is the measured 1.5B
  // failure: a whole coffee-shop page linking the starter stylesheet, rendering as the "Your
  // tiny world is ready." card in the wrong font. It used to be a model-family special case in
  // the agent (`smartPageNeedsStyles`); it is the same fact about the project either way.
  // The starter index.html is exempt because it links the starter stylesheet and script on
  // purpose: those three belong together, and flagging them would fire on every quiet turn.
  const authored = !isPristineContent('index.html', html)
  const stale = [
    ...new Set(
      [...html.matchAll(LOCAL_REFERENCE)]
        .map((match) => match[1].replace(/^\.\//, '').split(/[?#]/)[0])
        .filter(
          (reference) =>
            isLocalPath(reference) &&
            (files[reference] === undefined || (authored && isPristineContent(reference, files[reference]))),
        ),
    ),
  ]
  if (stale.length) {
    const one = stale.length === 1
    findings.push(
      `index.html references ${stale.join(', ')}, which ${one ? 'is not part of this page' : 'are not part of this page'} — ${one ? 'it is' : 'they are'} missing or still the starter file. Write ${one ? 'it' : 'them'}, or move that content inline into index.html.`,
    )
  }

  // Inline <style> counts: a single self-contained document is a shape the prompt allows.
  const css = [files['styles.css'] ?? '', ...[...html.matchAll(STYLE_BLOCK)].map((match) => match[1])].join('\n')
  const script = files['app.js'] ?? ''
  const used = classesUsedIn(html)
  const defined = classesDefinedIn(css)
  const unused = [...defined].filter(
    // A class the script attaches at runtime is applied, just not in the markup. Any mention
    // in app.js is enough to clear it: this is a nudge, and a wrong nudge costs a round.
    (name) => !used.has(name) && !script.includes(name) && !html.includes(`'${name}'`) && !html.includes(`"${name}"`),
  )
  if (unused.length) {
    const one = unused.length === 1
    const shown = unused.slice(0, 3).map((name) => `.${name}`).join(', ')
    findings.push(
      `${shown}${unused.length > 3 ? ` and ${unused.length - 3} more` : ''} ${one ? 'is styled but no element in index.html carries that class' : 'are styled but no elements in index.html carry those classes'}. Apply ${one ? 'it' : 'them'} in the markup, or drop the ${one ? 'rule' : 'rules'}.`,
    )
  }

  // The mirror of the check above, and the measured 1.5B answer to "make the header sticky":
  // it adds class="site-header sticky" to the markup and writes no rule for it, so the page
  // changes, the loop calls the round a success, and nothing is sticky. Only for an authored
  // page, and only for classes the script never touches — a class attribute with no rule is
  // ordinary in a hand-written page and would be a nuisance nudge on every turn.
  const unstyled = authored
    ? [...used].filter((name) => !defined.has(name) && !script.includes(name))
    : []
  if (unstyled.length) {
    const one = unstyled.length === 1
    const shown = unstyled.slice(0, 3).map((name) => `.${name}`).join(', ')
    findings.push(
      `index.html uses ${shown}${unstyled.length > 3 ? ` and ${unstyled.length - 3} more` : ''}, but no rule styles ${one ? 'it' : 'them'}. Write the ${one ? 'rule' : 'rules'}, or drop the ${one ? 'class' : 'classes'}.`,
    )
  }

  return findings.slice(0, 2)
}
