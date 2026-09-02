import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import { projectFS } from './fs'
import { SANDBOX_RUNTIME, sandboxBridge } from './runtime'

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https:; connect-src 'none'; frame-src 'none'"

function escapeClosingTag(content: string, tag: string): string {
  return content.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}

function assembleDocument(): string {
  let html = projectFS.read('index.html')
  const styles = escapeClosingTag(projectFS.read('styles.css'), 'style')
  const app = escapeClosingTag(projectFS.read('app.js'), 'script')
  const headInjection = [
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<style data-mote-file="styles.css">${styles}</style>`,
    `<script data-mote-runtime>${escapeClosingTag(SANDBOX_RUNTIME, 'script')}</script>`,
  ].join('\n')
  const appScript = `<script data-mote-file="app.js">${app}</script>`

  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    html = html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n${headInjection}`)
  } else {
    html = `<head>${headInjection}</head>\n${html}`
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${appScript}\n</body>`)
  }
  return `${html}\n${appScript}`
}

export function Sandbox() {
  const revision = useSyncExternalStore(
    projectFS.subscribe,
    projectFS.getRevision,
    projectFS.getRevision,
  )
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const srcDoc = useMemo(assembleDocument, [revision])

  useEffect(() => {
    sandboxBridge.attach(iframeRef.current?.contentWindow ?? null)
  }, [revision])

  return (
    <iframe
      ref={iframeRef}
      className="sandbox-frame"
      title="Mote project preview"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
    />
  )
}
