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
import { getStorageEstimate, parseLoadReport, type StorageEstimate } from '@/llm/engine'
import {
  classifyFit,
  describeFit,
  fetchModelDownload,
  recommendModels,
  sortModels,
  type AvailableModel,
  type DeviceProfile,
  type ModelDownload,
  type ModelFit,
} from '@/llm/models'
import { useAppState } from '@/state'

interface ModelPickerProps {
  onLoad(): void
  onDelete(): void
}

function formatBytes(value?: number): string {
  // Zero is a real answer on a fresh profile — "0 B used of 2.1 GB" is information, while the
  // em dash it used to render claimed the browser had not told us anything.
  if (value === undefined) return '—'
  if (value === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1_024)), units.length - 1)
  return `${(value / 1_024 ** exponent).toFixed(exponent > 2 ? 1 : 0)} ${units[exponent]}`
}

function gigabytes(megabytes: number | undefined): string {
  return megabytes ? `${(megabytes / 1_024).toFixed(1)} GB` : '—'
}

// The load bar used to render WebLLM's own sentence, which spends its second half apologising
// for the wait. What a visitor is owed instead is the machinery: which shard, how many bytes,
// and above all whether they are still arriving from the network or already going onto the
// GPU. That last distinction is the local-inference claim being made visible while it happens.
function describeLoad(
  report: ReturnType<typeof parseLoadReport>,
  total: number | undefined,
  source: 'local' | 'network' | undefined,
): { label: string; bytes?: string; path?: string; channel: 'net' | 'live' | 'idle' } {
  const position = report.shards ? ` ${report.shard}/${report.shards}` : ''
  const bytes =
    report.bytes === undefined
      ? undefined
      : total
        ? `${formatBytes(report.bytes)} / ${formatBytes(total)}`
        : formatBytes(report.bytes)

  // The channel is the colour half of the same sentence: the fetch runs gold because it is the
  // only moment anything crosses the tab boundary, and the bar goes cyan the instant those
  // bytes stop being a download and start being a GPU. On a cached model no gold appears at
  // all, which is the product's whole claim rendered without a word of copy.
  if (report.phase === 'fetch') {
    return {
      label: `Fetching shard${position}`,
      bytes,
      path: `${source === 'local' ? 'local mirror' : 'huggingface.co'} → browser cache`,
      channel: source === 'local' ? 'live' : 'net',
    }
  }
  if (report.phase === 'gpu') {
    return { label: `Uploading shard${position}`, bytes, path: 'browser cache → GPU', channel: 'live' }
  }
  return { label: report.text || 'Checking GPU…', channel: 'idle' }
}

// The whole prebuilt catalog is offered, which is 159 chat models, so the menu's job is no
// longer "pick a label" but "tell me what this machine can actually hold". Every row is filed
// under what the device says about it; the two groups a visitor cannot use are still listed,
// because a menu that silently omits the 8B model is less honest than one that shows it greyed.
const GROUPS: { fit: ModelFit; label: string }[] = [
  { fit: 'proven', label: 'Recommended for this device' },
  { fit: 'fits', label: 'Fits this device' },
  { fit: 'tight', label: 'Tight fit — may run out of memory' },
  { fit: 'over', label: 'Beyond this device' },
  { fit: 'blocked', label: 'This GPU cannot run these' },
]

function ModelOption({
  model,
  cached,
  fit,
}: {
  model: AvailableModel
  cached: boolean
  fit: ModelFit
}) {
  // The source icon carries the channel, so the one question this menu is really asking —
  // which of these costs me a download? — is answered before the label is read. Colouring the
  // `small` line instead would put a hundred green and gold rows in competition.
  const channel = cached ? 'channel-write' : model.source === 'network' ? 'channel-net' : ''
  const detail = [
    model.quantization,
    `${gigabytes(model.vramMB)} VRAM`,
    model.contextNote,
    model.role,
    cached ? 'cached' : model.source === 'local' ? 'on disk' : undefined,
  ].filter(Boolean)

  return (
    <span className={`model-option ${fit === 'over' || fit === 'blocked' ? 'is-unavailable' : channel}`}>
      {model.source === 'local' ? <Database /> : <HardDriveDownload />}
      <span>
        {model.label}
        <small>{detail.join(' · ')}</small>
      </span>
    </span>
  )
}

function DeviceLine({ device }: { device: DeviceProfile }) {
  // Everything WebGPU will admit to about the machine, plus the number Mote inferred from it.
  // The budget is an estimate and is labelled as one; PRODUCT.md's visitor is an engineer who
  // would rather see the guess than be silently steered by it.
  const adapter = [device.vendor, device.architecture].filter(Boolean).join(' · ')
  const facts = [
    adapter || device.description || 'WebGPU adapter',
    device.shaderF16 ? 'shader-f16' : 'no shader-f16',
    `~${gigabytes(device.budgetMB)} budget`,
  ]
  return (
    <p className="device-line">
      <Cpu aria-hidden="true" />
      <span>{facts.join(' · ')}</span>
    </p>
  )
}

export function ModelPicker({ onLoad, onDelete }: ModelPickerProps) {
  const { state, dispatch } = useAppState()
  const [storage, setStorage] = useState<StorageEstimate>()
  // Keyed by model id rather than cleared on selection, so the effect never calls setState in
  // its own body — oxlint flags that and the React Compiler bails out of the component.
  const [download, setDownload] = useState<{ id: string; size?: ModelDownload }>()
  // Remember which model the confirmation was for; switching models cancels it by itself.
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<string | null>(null)
  const confirmingDelete = confirmDeleteFor === state.model.selectedId
  const setConfirmingDelete = (value: boolean) => setConfirmDeleteFor(value ? state.model.selectedId : null)
  const selected = state.models.find((model) => model.id === state.model.selectedId)
  const loaded = state.models.find((model) => model.id === state.model.loadedId)
  const isCached = state.model.cachedIds.has(state.model.selectedId)
  const isLoaded = state.model.loadedId === state.model.selectedId
  const isLoading = state.model.phase === 'loading' || state.model.phase === 'checking'

  const device =
    state.preflight.status === 'ready' && state.preflight.verdict.ok
      ? state.preflight.verdict.device
      : undefined
  const selectedFit = selected ? classifyFit(selected, device) : undefined
  const fitWarning = selectedFit ? describeFit(selectedFit, device) : undefined
  const recommended = recommendModels(state.models, device).best

  const localModels = sortModels(state.models.filter((model) => model.source === 'local'))
  const networkModels = sortModels(state.models.filter((model) => model.source === 'network'))

  useEffect(() => {
    void getStorageEstimate().then(setStorage)
  }, [state.model.cachedIds])

  useEffect(() => {
    if (!selected) return
    const { id } = selected
    void fetchModelDownload(selected).then((size) => setDownload({ id, size }))
  }, [selected])

  // `undefined` while the manifest is still in flight; `{ size: undefined }` once it failed.
  const measured = download?.id === state.model.selectedId ? download : undefined
  const load = describeLoad(
    parseLoadReport(state.model.progress?.text),
    measured?.size?.bytes,
    selected?.source,
  )

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
                  <ModelOption
                    model={model}
                    cached={state.model.cachedIds.has(model.id)}
                    fit={classifyFit(model, device)}
                  />
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {GROUPS.map(({ fit, label }) => {
            const models = networkModels.filter((model) => classifyFit(model, device) === fit)
            if (!models.length) return null
            return (
              <SelectGroup key={fit}>
                <SelectLabel>
                  {label} <span className="group-count">{models.length}</span>
                </SelectLabel>
                {models.map((model) => (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    // Selecting one would only lead to a refused Load; the group heading has
                    // already said why, and `assertModelSupported` still guards the URL path.
                    disabled={fit === 'over' || fit === 'blocked'}
                  >
                    <ModelOption
                      model={model}
                      cached={state.model.cachedIds.has(model.id)}
                      fit={fit}
                    />
                  </SelectItem>
                ))}
              </SelectGroup>
            )
          })}
        </SelectContent>
      </Select>

      {device && <DeviceLine device={device} />}

      <div className="model-meta">
        <span>
          <Cpu aria-hidden="true" />
          {selected ? `${gigabytes(selected.vramMB)} VRAM` : 'VRAM varies'}
        </span>
        {/* Resident or still over the wire: the same two channels the load bar will use, so
            the cost of a choice is legible before it is made. */}
        <span className={isCached ? 'channel-write' : selected?.source === 'local' ? '' : 'channel-net'}>
          {isCached ? <Check aria-hidden="true" /> : <Database aria-hidden="true" />}
          {isCached ? 'Cached in browser' : selected?.source === 'local' ? 'Local mirror' : 'Downloads on load'}
        </span>
      </div>

      {!isCached && !isLoading && (
        <dl className="readout">
          <dt>Download</dt>
          <dd className={selected?.source === 'local' ? undefined : 'channel-net'}>
            {measured === undefined
              ? 'reading manifest…'
              : measured.size
                ? `${formatBytes(measured.size.bytes)} · ${measured.size.shards} shards`
                : 'size unavailable'}
          </dd>
          <dt>Source</dt>
          <dd>
            {selected?.source === 'local' ? 'This machine’s mirror' : 'huggingface.co'} · once,
            then cached here
          </dd>
          {recommended && recommended.id !== selected?.id && (
            <>
              <dt>Best fit</dt>
              <dd>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => dispatch({ type: 'selectModel', id: recommended.id })}
                >
                  {recommended.label}
                </button>
              </dd>
            </>
          )}
        </dl>
      )}

      {fitWarning && !isLoading && (
        <p className="fit-warning" role="note">
          <TriangleAlert aria-hidden="true" />
          <span>{fitWarning}</span>
        </p>
      )}

      {isLoading && (
        <div className={`load-progress channel-${load.channel}`} role="status">
          <div className="progress-track">
            <span style={{ width: `${Math.max(2, (state.model.progress?.progress ?? 0) * 100)}%` }} />
          </div>
          <div className="progress-copy">
            <span>{load.label}</span>
            <strong>{Math.round((state.model.progress?.progress ?? 0) * 100)}%</strong>
          </div>
          {load.bytes && (
            <div className="progress-detail">
              <span>{load.bytes}</span>
              <span>{load.path}</span>
            </div>
          )}
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
          {/* `data-resident` swaps the cyan fill for a green wash once the weights are here.
              Cyan means live, and a control that cannot be pressed for the rest of the session
              is not the live thing in this pane — the sandbox is. */}
          <Button
            className="model-load"
            data-resident={isLoaded || undefined}
            onClick={onLoad}
            disabled={
              !selected ||
              isLoading ||
              isLoaded ||
              state.generating ||
              selectedFit === 'over' ||
              selectedFit === 'blocked'
            }
          >
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
