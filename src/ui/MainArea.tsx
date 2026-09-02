import { Code2, Monitor, RotateCcw, TerminalSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'

export function MainArea() {
  return (
    <main className="main-area">
      <header className="workspace-bar">
        <nav aria-label="Workspace views">
          <button className="workspace-tab is-active" type="button">
            <Monitor /> Preview
          </button>
          <button className="workspace-tab" type="button" disabled>
            <Code2 /> Files
          </button>
          <button className="workspace-tab" type="button" disabled>
            <TerminalSquare /> Console
          </button>
        </nav>
        <Button variant="ghost" size="sm" disabled>
          <RotateCcw />
          Reset
        </Button>
      </header>
      <section className="workspace-placeholder">
        <div className="coordinate-grid" aria-hidden="true" />
        <div className="placeholder-core">
          <span className="core-particle" aria-hidden="true" />
          <h2>Sandbox offline</h2>
          <p>The project runtime arrives in the next stage.</p>
        </div>
        <span className="coordinate-label coordinate-label-top">VIEWPORT / 01</span>
        <span className="coordinate-label coordinate-label-bottom">OPAQUE ORIGIN</span>
      </section>
      <footer className="workspace-status">
        <span><i className="status-dot" /> Model idle</span>
        <span>WebGPU</span>
        <span>Browser-only</span>
      </footer>
    </main>
  )
}
