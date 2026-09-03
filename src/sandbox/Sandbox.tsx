import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import { assembleDocument } from './document'
import { projectFS } from './fs'
import { sandboxBridge } from './runtime'

export function Sandbox() {
  // The snapshot, not the singleton, is the input: the React Compiler memoises render-time
  // work by its reactive inputs, and a callback that reads projectFS directly has none, so
  // the srcdoc would be computed once and never again.
  const snapshot = useSyncExternalStore(
    projectFS.subscribe,
    projectFS.getSnapshot,
    projectFS.getSnapshot,
  )
  const revision = snapshot.revision
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const srcDoc = useMemo(() => assembleDocument(snapshot.files), [snapshot.files])

  // Attach before the browser can run the new document: the runtime posts `ready` as its first
  // statement, and a message from a window the bridge is not yet watching is dropped.
  useLayoutEffect(() => {
    sandboxBridge.attach(iframeRef.current?.contentWindow ?? null)
  }, [revision])

  // Keyed on the revision so every write is a real navigation. Resetting an already-reset
  // project, or a model rewriting a file with identical content, yields the same srcdoc string;
  // React would leave the attribute alone, the iframe would never reload, and the bridge would
  // wait forever for a `ready` signal.
  return (
    <iframe
      key={revision}
      ref={iframeRef}
      className="sandbox-frame"
      title="Mote project preview"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
    />
  )
}
