import { useEffect, useState } from 'react'
import {
  Box,
  Check,
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getStorageEstimate, type StorageEstimate } from '@/llm/engine'
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

export function ModelPicker({ onLoad, onDelete }: ModelPickerProps) {
  const { state, dispatch } = useAppState()
  const [storage, setStorage] = useState<StorageEstimate>()
  const selected = state.models.find((model) => model.id === state.model.selectedId)
  const isCached = state.model.cachedIds.has(state.model.selectedId)
  const isLoaded = state.model.loadedId === state.model.selectedId
  const isLoading = state.model.phase === 'loading' || state.model.phase === 'checking'

  useEffect(() => {
    void getStorageEstimate().then(setStorage)
  }, [state.model.cachedIds])

  return (
    <section className="model-panel" aria-labelledby="model-heading">
      <div className="section-heading">
        <div>
          <h2 id="model-heading">Runtime</h2>
          <p>WebGPU · local inference</p>
        </div>
        <span className={`status-dot ${isLoaded ? 'is-ready' : ''}`} aria-hidden="true" />
      </div>

      <Select
        value={state.model.selectedId}
        onValueChange={(id) => dispatch({ type: 'selectModel', id })}
        disabled={isLoading}
      >
        <SelectTrigger className="model-select" aria-label="Model">
          <SelectValue placeholder="Finding models…" />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {state.models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              <span className="model-option">
                {model.source === 'local' ? <Database /> : <HardDriveDownload />}
                <span>
                  {model.label}
                  <small>{model.source === 'local' ? 'Local mirror' : 'Hugging Face'}</small>
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="model-meta">
        <span>
          <Box aria-hidden="true" />
          {selected?.record.vram_required_MB
            ? `${(selected.record.vram_required_MB / 1_024).toFixed(1)} GB VRAM`
            : 'VRAM varies'}
        </span>
        <span>
          {isCached ? <Check aria-hidden="true" /> : <Database aria-hidden="true" />}
          {isCached ? 'Cached' : selected?.source === 'local' ? 'Mirror ready' : 'Not cached'}
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

      <div className="model-actions">
        <Button onClick={onLoad} disabled={!selected || isLoading || isLoaded}>
          {isLoading ? <LoaderCircle className="animate-spin" /> : isLoaded ? <Check /> : null}
          {isLoaded ? 'Loaded' : isLoading ? 'Loading' : 'Load model'}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          disabled={!isCached || isLoading}
          aria-label="Delete model cache"
          title="Delete model cache"
        >
          <Trash2 />
        </Button>
      </div>

      <p className="storage-line">
        {formatBytes(storage?.usage)} used of {formatBytes(storage?.quota)}
        {storage?.persisted ? ' · persistent' : ''}
      </p>
    </section>
  )
}
