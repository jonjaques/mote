import { useEffect, useState } from 'react'
import {
  Check,
  Cpu,
  Database,
  HardDriveDownload,
  LoaderCircle,
  Trash2,
  TriangleAlert,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getStorageEstimate, type StorageEstimate } from '@/llm/engine'
import type { AvailableModel } from '@/llm/models'
import { useAppState } from '@/state'

interface ModelPickerProps {
  onLoad(): void
  onDelete(): void
}

function formatBytes(value?: number): string {
  if (!value) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1_024)), units.length - 1)
  return `${(value / 1_024 ** exponent).toFixed(exponent > 2 ? 1 : 0)} ${units[exponent]}`
}

function vramLabel(model: AvailableModel): string {
  const megabytes = model.record.vram_required_MB
  return megabytes ? `${(megabytes / 1_024).toFixed(1)} GB` : '—'
}

function ModelOption({ model, cached }: { model: AvailableModel; cached: boolean }) {
  return (
    <span className="model-option">
      {model.source === 'local' ? <Database /> : <HardDriveDownload />}
      <span>
        {model.label}
        <small>
          {vramLabel(model)} VRAM
          {cached ? ' · cached' : model.source === 'local' ? ' · on disk' : ' · download'}
        </small>
      </span>
    </span>
  )
}

export function ModelPicker({ onLoad, onDelete }: ModelPickerProps) {
  const { state, dispatch } = useAppState()
  const [storage, setStorage] = useState<StorageEstimate>()
  // Remember which model the confirmation was for; switching models cancels it by itself.
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<string | null>(null)
  const confirmingDelete = confirmDeleteFor === state.model.selectedId
  const setConfirmingDelete = (value: boolean) => setConfirmDeleteFor(value ? state.model.selectedId : null)
  const selected = state.models.find((model) => model.id === state.model.selectedId)
  const loaded = state.models.find((model) => model.id === state.model.loadedId)
  const isCached = state.model.cachedIds.has(state.model.selectedId)
  const isLoaded = state.model.loadedId === state.model.selectedId
  const isLoading = state.model.phase === 'loading' || state.model.phase === 'checking'
  const localModels = state.models.filter((model) => model.source === 'local')
  const networkModels = state.models.filter((model) => model.source === 'network')

  useEffect(() => {
    void getStorageEstimate().then(setStorage)
  }, [state.model.cachedIds])

  return (
    <section className="model-panel" aria-labelledby="model-heading">
      <div className="section-heading">
        <div>
          <h2 id="model-heading">Runtime</h2>
          <p>{loaded ? `${loaded.label} · ready` : 'WebGPU · local inference'}</p>
        </div>
        <span className={`status-dot ${loaded ? 'is-ready' : ''}`} aria-hidden="true" />
      </div>

      <Select
        value={state.model.selectedId}
        onValueChange={(id) => dispatch({ type: 'selectModel', id })}
        disabled={isLoading || state.generating}
      >
        <SelectTrigger className="model-select" aria-label="Model">
          <SelectValue placeholder="Finding models…" />
        </SelectTrigger>
        <SelectContent position="popper" align="start" className="model-menu">
          {localModels.length > 0 && (
            <SelectGroup>
              <SelectLabel>On this machine</SelectLabel>
              {localModels.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  <ModelOption model={model} cached={state.model.cachedIds.has(model.id)} />
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {networkModels.length > 0 && (
            <SelectGroup>
              <SelectLabel>Hugging Face</SelectLabel>
              {networkModels.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  <ModelOption model={model} cached={state.model.cachedIds.has(model.id)} />
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>

      <div className="model-meta">
        <span>
          <Cpu aria-hidden="true" />
          {selected ? `${vramLabel(selected)} VRAM` : 'VRAM varies'}
        </span>
        <span>
          {isCached ? <Check aria-hidden="true" /> : <Database aria-hidden="true" />}
          {isCached ? 'Cached in browser' : selected?.source === 'local' ? 'Local mirror' : 'Downloads on load'}
        </span>
      </div>

      {isLoading && (
        <div className="load-progress" role="status">
          <div className="progress-track">
            <span style={{ width: `${Math.max(2, (state.model.progress?.progress ?? 0) * 100)}%` }} />
          </div>
          <div className="progress-copy">
            <span>{state.model.progress?.text ?? 'Checking GPU…'}</span>
            <strong>{Math.round((state.model.progress?.progress ?? 0) * 100)}%</strong>
          </div>
        </div>
      )}

      {state.model.error && (
        <div className="inline-error" role="alert">
          <TriangleAlert />
          <span>{state.model.error}</span>
        </div>
      )}

      {confirmingDelete ? (
        <div className="model-actions model-confirm" role="group" aria-label="Confirm cache deletion">
          <span>Delete the cached weights for {selected?.label}?</span>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              setConfirmingDelete(false)
              onDelete()
            }}
          >
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <div className="model-actions">
          <Button onClick={onLoad} disabled={!selected || isLoading || isLoaded || state.generating}>
            {isLoading ? <LoaderCircle className="animate-spin" /> : isLoaded ? <Check /> : null}
            {isLoaded ? 'Loaded' : isLoading ? 'Loading' : loaded ? 'Switch model' : 'Load model'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfirmingDelete(true)}
            disabled={!isCached || isLoading || state.generating}
            aria-label="Delete cached weights"
            title="Delete cached weights"
          >
            <Trash2 />
          </Button>
        </div>
      )}

      <p className="storage-line">
        {formatBytes(storage?.usage)} used of {formatBytes(storage?.quota)}
        {storage?.persisted ? ' · persistent' : ''}
      </p>
    </section>
  )
}
