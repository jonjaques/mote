import { useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { Braces, FileCode2, FileText, RotateCcw, Save } from 'lucide-react'
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'

import { Button } from '@/components/ui/button'
import { listProjectFiles, projectFS } from '@/sandbox/fs'
import { useAppState } from '@/state'

function fileIcon(path: string) {
  if (path.endsWith('.js')) return <Braces />
  if (path.endsWith('.html')) return <FileCode2 />
  return <FileText />
}

function languageFor(path: string): Extension[] {
  if (path.endsWith('.html') || path.endsWith('.htm')) return [html()]
  if (path.endsWith('.css')) return [css()]
  if (path.endsWith('.js') || path.endsWith('.mjs')) return [javascript()]
  return []
}

// CodeMirror reconfigures itself whenever the extensions array identity changes, so the array
// for a given file type is built once here rather than memoised inside the component.
const extensionCache = new Map<string, Extension[]>()
function extensionsFor(path: string): Extension[] {
  const key = path.slice(path.lastIndexOf('.'))
  let extensions = extensionCache.get(key)
  if (!extensions) {
    extensions = [...languageFor(path), editorTheme, EditorView.lineWrapping]
    extensionCache.set(key, extensions)
  }
  return extensions
}

// The editor inherits the app palette rather than shipping a second dark theme.
const editorTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'oklch(0.86 0.03 220)', fontSize: '0.75rem' },
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '1rem 0' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--muted-foreground)',
      border: 'none',
      paddingLeft: '0.5rem',
    },
    '.cm-activeLine': { backgroundColor: 'oklch(0.2 0.012 255 / 55%)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'oklch(0.35 0.06 190 / 60%)',
    },
    '.cm-cursor': { borderLeftColor: 'var(--primary)' },
    '.cm-matchingBracket': { backgroundColor: 'oklch(0.3 0.05 190 / 70%)', outline: 'none' },
  },
  { dark: true },
)

export function FilesView() {
  // Derive the tree from the store snapshot so the React Compiler re-runs this on every
  // revision; a bare projectFS.list() in render has no reactive input and is memoised once.
  const snapshot = useSyncExternalStore(
    projectFS.subscribe,
    projectFS.getSnapshot,
    projectFS.getSnapshot,
  )
  const files = listProjectFiles(snapshot.files)
  const { state, dispatch } = useAppState()
  const selected = files.find((file) => file.path === state.workspace.selectedPath) ?? files[0]
  const selectedPath = selected?.path ?? ''
  const savedContent = selected?.content ?? ''
  // The draft is keyed to the file content it started from. When a tool write or a reset
  // replaces the file underneath the editor, or another file is selected, the draft follows;
  // adjusting during render avoids a second render from an effect.
  const [editing, setEditing] = useState({ path: selectedPath, base: savedContent, draft: savedContent })
  if (editing.path !== selectedPath || editing.base !== savedContent) {
    setEditing({ path: selectedPath, base: savedContent, draft: savedContent })
  }
  const draft = editing.path === selectedPath && editing.base === savedContent ? editing.draft : savedContent
  const setDraft = (value: string) => setEditing({ path: selectedPath, base: savedContent, draft: value })
  const dirty = draft !== savedContent
  const extensions = extensionsFor(selectedPath)

  function save() {
    if (!selected || !dirty) return
    projectFS.write(selected.path, draft)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault()
      save()
    }
  }

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
            onClick={() => dispatch({ type: 'openFile', path: file.path })}
          >
            {fileIcon(file.path)}
            <span>{file.path}</span>
            <small>{file.bytes} B</small>
          </button>
        ))}
      </aside>
      <section className="file-content" aria-label={selected?.path ?? 'File content'} onKeyDown={onKeyDown}>
        <header>
          <span>
            {selected?.path}
            {dirty && <em className="file-dirty" aria-label="Unsaved changes" />}
          </span>
          <div className="file-actions">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setDraft(savedContent)}
              disabled={!dirty}
              title="Discard the unsaved edits"
            >
              <RotateCcw />
              Discard
            </Button>
            <Button size="xs" onClick={save} disabled={!dirty} title="Save and reload the preview (⌘S)">
              <Save />
              Save
            </Button>
          </div>
        </header>
        {selected && (
          <CodeMirror
            className="file-editor"
            value={draft}
            height="100%"
            theme="dark"
            extensions={extensions}
            basicSetup={{ foldGutter: false, autocompletion: false, highlightActiveLine: true }}
            onChange={setDraft}
          />
        )}
      </section>
    </div>
  )
}
