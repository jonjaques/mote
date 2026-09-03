import { useState, useSyncExternalStore } from 'react'
import { Braces, FileCode2, FileText } from 'lucide-react'

import { listProjectFiles, projectFS } from '@/sandbox/fs'

function fileIcon(path: string) {
  if (path.endsWith('.js')) return <Braces />
  if (path.endsWith('.html')) return <FileCode2 />
  return <FileText />
}

export function FilesView() {
  // Derive the tree from the store snapshot so the React Compiler re-runs this on every
  // revision; a bare projectFS.list() in render has no reactive input and is memoised once.
  const snapshot = useSyncExternalStore(
    projectFS.subscribe,
    projectFS.getSnapshot,
    projectFS.getSnapshot,
  )
  const files = listProjectFiles(snapshot.files)
  const [selectedPath, setSelectedPath] = useState('index.html')
  const selected = files.find((file) => file.path === selectedPath) ?? files[0]

  return (
    <div className="files-view" data-revision={snapshot.revision}>
      <aside className="file-tree" aria-label="Project files">
        <div className="file-tree-heading">
          <span>Project</span>
          <strong>{files.length}</strong>
        </div>
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            className={file.path === selected?.path ? 'is-selected' : ''}
            onClick={() => setSelectedPath(file.path)}
          >
            {fileIcon(file.path)}
            <span>{file.path}</span>
            <small>{file.bytes} B</small>
          </button>
        ))}
      </aside>
      <section className="file-content" aria-label={selected?.path ?? 'File content'}>
        <header>
          <span>{selected?.path}</span>
          <small>read only</small>
        </header>
        <pre><code>{selected?.content}</code></pre>
      </section>
    </div>
  )
}
