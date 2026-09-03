import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import {
  Code2,
  Download,
  FlaskConical,
  LoaderCircle,
  Monitor,
  RefreshCw,
  RotateCcw,
  Smartphone,
  TerminalSquare,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { exportProject } from '@/sandbox/export'
import { projectFS } from '@/sandbox/fs'
import { Sandbox } from '@/sandbox/Sandbox'
import { sandboxBridge, type SandboxConsoleEntry } from '@/sandbox/runtime'
import { useAppState, type WorkspaceView } from '@/state'
import { ConsoleView } from './ConsoleView'

// CodeMirror plus the HTML/CSS/JS language modes are the largest thing in the app after the
// engine itself, and a visitor who only watches the preview never opens the editor. Split so
// the first paint does not wait on it.
const FilesView = lazy(() => import('./FilesView').then((module) => ({ default: module.FilesView })))

const VIEWS: Array<{ id: WorkspaceView; label: string; icon: typeof Monitor }> = [
  { id: 'preview', label: 'Preview', icon: Monitor },
  { id: 'files', label: 'Files', icon: Code2 },
  { id: 'console', label: 'Console', icon: TerminalSquare },
]

export function MainArea() {
  const { state, dispatch } = useAppState()
  const { view, previewWidth } = state.workspace
  const snapshot = useSyncExternalStore(
    projectFS.subscribe,
    projectFS.getSnapshot,
    projectFS.getSnapshot,
  )
  const [sandboxReady, setSandboxReady] = useState(false)
  const [consoleEntries, setConsoleEntries] = useState<SandboxConsoleEntry[]>([])
  const [exporting, setExporting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => sandboxBridge.subscribeReady(setSandboxReady), [])
  useEffect(() => sandboxBridge.subscribeConsole(setConsoleEntries), [])
  useEffect(() => {
    if (!confirmReset) return
    const timer = setTimeout(() => setConfirmReset(false), 4_000)
    return () => clearTimeout(timer)
  }, [confirmReset])

  const errorCount = consoleEntries.filter((entry) => entry.level === 'error').length
  // Through the snapshot, not projectFS.list(): a render-time read of the singleton has no
  // reactive input, so the React Compiler caches the first count and the badge never moves
  // again however many files the model writes.
  const fileCount = Object.keys(snapshot.files).length

  async function downloadProject() {
    setExporting(true)
    try {
      await exportProject()
    } finally {
      setExporting(false)
    }
  }

  function resetProject() {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    setConfirmReset(false)
    projectFS.reset()
    dispatch({ type: 'openFile', path: 'index.html' })
    dispatch({ type: 'setView', view: 'preview' })
  }

  return (
    <main className="main-area">
      <header className="workspace-bar">
        <nav aria-label="Workspace views">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`workspace-tab ${view === id ? 'is-active' : ''}`}
              type="button"
              aria-current={view === id ? 'page' : undefined}
              onClick={() => dispatch({ type: 'setView', view: id })}
            >
              <Icon /> {label}
              {id === 'console' && errorCount > 0 && (
                <span className="tab-badge tab-badge-error" aria-label={`${errorCount} errors`}>
                  {errorCount}
                </span>
              )}
              {id === 'files' && <span className="tab-badge">{fileCount}</span>}
            </button>
          ))}
        </nav>
        <div className="workspace-actions">
          {view === 'preview' && (
            <div className="segmented" role="group" aria-label="Preview width">
              <button
                type="button"
                className={previewWidth === 'desktop' ? 'is-active' : ''}
                aria-pressed={previewWidth === 'desktop'}
                title="Desktop width"
                onClick={() => dispatch({ type: 'setPreviewWidth', width: 'desktop' })}
              >
                <Monitor />
              </button>
              <button
                type="button"
                className={previewWidth === 'mobile' ? 'is-active' : ''}
                aria-pressed={previewWidth === 'mobile'}
                title="Phone width (390px)"
                onClick={() => dispatch({ type: 'setPreviewWidth', width: 'mobile' })}
              >
                <Smartphone />
              </button>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => projectFS.touch()}
            title="Reload the preview and reset its state"
          >
            <RefreshCw />
            <span className="action-label">Reload</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void downloadProject()}
            disabled={exporting}
            title="Download the project as a zip"
          >
            {exporting ? <LoaderCircle className="animate-spin" /> : <Download />}
            <span className="action-label">Export</span>
          </Button>
          {import.meta.env.DEV && (
            <Button variant="ghost" size="sm" onClick={() => projectFS.seed()}>
              <FlaskConical />
              <span className="action-label">Seed example</span>
            </Button>
          )}
          <Button
            variant={confirmReset ? 'destructive' : 'ghost'}
            size="sm"
            data-confirming={confirmReset || undefined}
            onClick={resetProject}
            onBlur={() => setConfirmReset(false)}
            title="Replace every file with the starter project"
          >
            <RotateCcw />
            <span className="action-label">{confirmReset ? 'Replace all files?' : 'Reset'}</span>
          </Button>
        </div>
      </header>
      <section className="workspace-surface">
        <div
          className={`view-panel preview-panel ${view === 'preview' ? 'is-active' : ''} ${previewWidth === 'mobile' ? 'is-mobile' : ''}`}
        >
          <Sandbox />
        </div>
        {view === 'files' && (
          <div className="view-panel is-active">
            <Suspense fallback={<p className="view-loading">Loading editor…</p>}>
              <FilesView />
            </Suspense>
          </div>
        )}
        {view === 'console' && (
          <div className="view-panel is-active">
            <ConsoleView />
          </div>
        )}
      </section>
      <footer className="workspace-status">
        <span>
          <i className={`status-dot ${sandboxReady ? 'is-ready' : ''}`} />{' '}
          {sandboxReady ? 'Sandbox ready' : 'Sandbox starting'}
        </span>
        <span>
          {consoleEntries.length} console {consoleEntries.length === 1 ? 'line' : 'lines'}
          {errorCount > 0 ? ` · ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}` : ''}
        </span>
        <span>Opaque origin</span>
        <span>Scripts isolated</span>
      </footer>
    </main>
  )
}
