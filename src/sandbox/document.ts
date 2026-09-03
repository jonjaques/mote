import { projectFS } from './fs'
import { SANDBOX_RUNTIME } from './runtime'

// 'unsafe-eval' is required because the runtime answers run_js with `new Function(code)`;
// without it every run_js call fails with an EvalError. It grants nothing the page cannot
// already do through inline scripts. connect-src 'none' is the load-bearing restriction.
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https:; connect-src 'none'; frame-src 'none'; form-action 'none'"

function escapeClosingTag(content: string, tag: string): string {
  return content.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}

// srcdoc cannot resolve virtual relative files, so the host inlines styles.css and app.js in
// place of the tags index.html uses to reference them. Only linked files are inlined: a page
// the model wrote as a single self-contained document must not inherit the starter stylesheet.
export function assembleDocument(
  files: Readonly<Record<string, string>> = projectFS.getSnapshot().files,
): string {
  const read = (path: string): string => {
    const content = files[path]
    if (content === undefined) throw new Error(`File not found: ${path}`)
    return content
  }
  let html = read('index.html')
  const styles = escapeClosingTag(read('styles.css'), 'style')
  const app = escapeClosingTag(read('app.js'), 'script')
  const headInjection = [
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<script data-mote-runtime>${escapeClosingTag(SANDBOX_RUNTIME, 'script')}</script>`,
  ].join('\n')
  const styleTag = `<style data-mote-file="styles.css">${styles}</style>`
  const appScript = `<script data-mote-file="app.js">${app}</script>`

  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    html = html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n${headInjection}`)
  } else {
    html = `<head>${headInjection}</head>\n${html}`
  }

  html = html.replace(
    /<link\b[^>]*href=["'](?:\.\/)?styles\.css["'][^>]*>/i,
    styleTag,
  )
  return html.replace(
    /<script\b[^>]*src=["'](?:\.\/)?app\.js["'][^>]*>\s*<\/script>/i,
    appScript,
  )
}
