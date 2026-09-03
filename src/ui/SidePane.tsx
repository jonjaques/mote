import { Chat } from './Chat'
import { ModelPicker } from './ModelPicker'

interface SidePaneProps {
  onLoadModel(): void
  onDeleteModel(): void
}

export function SidePane({ onLoadModel, onDeleteModel }: SidePaneProps) {
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
        <span className="version">v{__APP_VERSION__}</span>
      </header>
      <ModelPicker onLoad={onLoadModel} onDelete={onDeleteModel} />
      <Chat />
    </aside>
  )
}
