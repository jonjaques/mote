import { useEffect, useState } from 'react'
import { Code2, FlaskConical, Monitor, RotateCcw, TerminalSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { projectFS } from '@/sandbox/fs'
import { Sandbox } from '@/sandbox/Sandbox'
import { sandboxBridge } from '@/sandbox/runtime'
import { ConsoleView } from './ConsoleView'
import { FilesView } from './FilesView'

export function MainArea() {
  const [activeView, setActiveView] = useState<'preview' | 'files' | 'console'>('preview')
  const [sandboxReady, setSandboxReady] = useState(false)

  useEffect(() => sandboxBridge.subscribeReady(setSandboxReady), [])

  return (
    <main className="main-area">
      <header className="workspace-bar">
        <nav aria-label="Workspace views">
          <button
            className={`workspace-tab ${activeView === 'preview' ? 'is-active' : ''}`}
            type="button"
            onClick={() => setActiveView('preview')}
          >
            <Monitor /> Preview
          </button>
          <button
            className={`workspace-tab ${activeView === 'files' ? 'is-active' : ''}`}
            type="button"
            onClick={() => setActiveView('files')}
          >
            <Code2 /> Files
          </button>
          <button
            className={`workspace-tab ${activeView === 'console' ? 'is-active' : ''}`}
            type="button"
            onClick={() => setActiveView('console')}
          >
            <TerminalSquare /> Console
          </button>
        </nav>
        <div className="workspace-actions">
          {import.meta.env.DEV && (
            <Button variant="ghost" size="sm" onClick={() => projectFS.seed()}>
              <FlaskConical />
              Seed example
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => projectFS.reset()}>
            <RotateCcw />
            Reset
          </Button>
        </div>
      </header>
      <section className="workspace-surface">
        <div className={activeView === 'preview' ? 'view-panel is-active' : 'view-panel'}>
          <Sandbox />
        </div>
        {activeView === 'files' && (
          <div className="view-panel is-active">
            <FilesView />
          </div>
        )}
        {activeView === 'console' && (
          <div className="view-panel is-active">
            <ConsoleView />
          </div>
        )}
      </section>
      <footer className="workspace-status">
        <span><i className={`status-dot ${sandboxReady ? 'is-ready' : ''}`} /> {sandboxReady ? 'Sandbox ready' : 'Sandbox starting'}</span>
        <span>Opaque origin</span>
        <span>Scripts isolated</span>
      </footer>
    </main>
  )
}
