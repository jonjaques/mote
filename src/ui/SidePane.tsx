import { useSyncExternalStore } from 'react'

import { applyServiceWorkerUpdate, serviceWorkerUpdate } from '@/pwa'
import { Chat } from './Chat'
import { ModelPicker } from './ModelPicker'

interface SidePaneProps {
  onLoadModel(): void
  onDeleteModel(): void
}

export function SidePane({ onLoadModel, onDeleteModel }: SidePaneProps) {
  const updateReady = useSyncExternalStore(
    serviceWorkerUpdate.subscribe,
    serviceWorkerUpdate.getSnapshot,
    serviceWorkerUpdate.getSnapshot,
  )

  return (
    <aside className="side-pane">
      <header className="brand">
        <div className="brand-symbol" aria-hidden="true">
          <span />
        </div>
        <div>
          <h1>Mote</h1>
          <p>Local browser runtime</p>
        </div>
        {/* A deploy landed while the tab was open. The new worker is installed and waiting;
            it deliberately does not take over on its own, because swapping the shell under a
            running session can 404 a lazy chunk mid-turn. */}
        {updateReady ? (
          <button type="button" className="version version-update" onClick={applyServiceWorkerUpdate}>
            Update ready
          </button>
        ) : (
          <span className="version">v{__APP_VERSION__}</span>
        )}
      </header>
      <ModelPicker onLoad={onLoadModel} onDelete={onDeleteModel} />
      <Chat />
    </aside>
  )
}
