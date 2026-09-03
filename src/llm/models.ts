import {
  prebuiltAppConfig,
  type AppConfig,
  type ChatOptions,
  type ModelRecord,
} from '@mlc-ai/web-llm'

export const FAST_MODEL_ID = 'Qwen3-0.6B-q4f16_1-MLC'
export const SMART_MODEL_ID = 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC'
export const STEP_UP_MODEL_ID = 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC'
export const LOCAL_SUFFIX = ' (local)'

// Models expected to build whole pages; the agent applies its two-file stylesheet guard to
// these only, because the fast model rewrites index.html wholesale and never links styles.css.
export const PAGE_BUILDER_MODEL_IDS = [SMART_MODEL_ID, STEP_UP_MODEL_ID]

export function isPageBuilderModel(loadedIds: string[] | undefined): boolean {
  return loadedIds?.some((id) => PAGE_BUILDER_MODEL_IDS.some((base) => id.startsWith(base))) ?? false
}

const VRAM_BUDGET_MB = 6_144

export type ModelSource = 'local' | 'network'

export interface AvailableModel {
  id: string
  baseId: string
  label: string
  source: ModelSource
  record: ModelRecord
}

const curatedModels: Record<string, { label: string; contextWindow?: number }> = {
  [FAST_MODEL_ID]: { label: 'Qwen3 0.6B · Fast' },
  [SMART_MODEL_ID]: { label: 'Qwen2.5 Coder 1.5B · Smart', contextWindow: 8_192 },
  'Llama-3.2-1B-Instruct-q4f16_1-MLC': { label: 'Llama 3.2 1B · Alternate' },
  'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC': { label: 'Qwen2.5 Coder 3B · Step up' },
  [STEP_UP_MODEL_ID]: { label: 'Qwen2.5 Coder 7B · Page builder', contextWindow: 8_192 },
  'Qwen3-8B-q4f16_1-MLC': { label: 'Qwen3 8B · Reasoning' },
  'Qwen3.5-9B-q4f16_1-MLC': { label: 'Qwen3.5 9B · Largest' },
}

// `baseId` is the curated key; local records carry the ` (local)` suffix in `model_id` and
// would otherwise never match, leaving the mirror at the prebuilt 4096 context.
function withOverrides(record: ModelRecord, baseId = record.model_id): ModelRecord {
  const contextWindow = curatedModels[baseId]?.contextWindow
  if (!contextWindow) return record

  return {
    ...record,
    overrides: {
      ...record.overrides,
      context_window_size: contextWindow,
    },
  }
}

function asAvailable(record: ModelRecord, source: ModelSource, baseId = record.model_id): AvailableModel {
  return {
    id: record.model_id,
    baseId,
    label: curatedModels[baseId]?.label ?? baseId,
    source,
    record,
  }
}

function toAbsoluteModelUrl(url: string): string {
  const absolute = new URL(url, window.location.origin)
  if (!/\/resolve\/[^/]+\//.test(absolute.pathname)) {
    const root = absolute.pathname.endsWith('/') ? absolute.pathname : `${absolute.pathname}/`
    absolute.pathname = `${root}resolve/main/`
  }
  return absolute.href
}

function isModelRecord(value: unknown): value is ModelRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ModelRecord>
  return (
    typeof record.model === 'string' &&
    typeof record.model_id === 'string' &&
    typeof record.model_lib === 'string'
  )
}

async function loadLocalRecords(): Promise<ModelRecord[]> {
  try {
    const response = await fetch('/models/index.json', { cache: 'no-store' })
    if (!response.ok) return []

    const records: unknown = await response.json()
    if (!Array.isArray(records)) return []

    return records.filter(isModelRecord).map((record) => {
      const baseId = record.model_id
      return withOverrides(
        {
          ...record,
          // WebLLM's cleanModelUrl appends resolve/main/ to any URL that lacks it.
          // Put that segment in the record so cache keys and on-disk paths stay aligned.
          model: toAbsoluteModelUrl(record.model),
          model_id: `${baseId}${LOCAL_SUFFIX}`,
          model_lib: new URL(record.model_lib, window.location.origin).href,
        },
        baseId,
      )
    })
  } catch {
    // Production intentionally has no model mirror unless one is mounted separately.
    return []
  }
}

export async function createModelCatalog(): Promise<{
  appConfig: AppConfig
  models: AvailableModel[]
}> {
  const remoteRecords = prebuiltAppConfig.model_list
    .filter((record) => record.model_id in curatedModels)
    .map((record) => withOverrides(record))
  const localRecords = await loadLocalRecords()
  const localBaseIds = new Set(localRecords.map((record) => record.model_id.slice(0, -LOCAL_SUFFIX.length)))

  const models = [
    ...localRecords
      .filter((record) => record.model_id.slice(0, -LOCAL_SUFFIX.length) in curatedModels)
      .map((record) =>
        asAvailable(record, 'local', record.model_id.slice(0, -LOCAL_SUFFIX.length)),
      ),
    ...remoteRecords.map((record) => asAvailable(record, 'network')),
  ].sort((a, b) => {
    const aRank = a.baseId === FAST_MODEL_ID ? 0 : a.baseId === SMART_MODEL_ID ? 1 : 2
    const bRank = b.baseId === FAST_MODEL_ID ? 0 : b.baseId === SMART_MODEL_ID ? 1 : 2
    if (aRank !== bRank) return aRank - bRank
    if (a.baseId !== b.baseId) return a.label.localeCompare(b.label)
    return a.source === 'local' ? -1 : 1
  })

  // Keep every upstream record available to WebLLM even though the picker stays deliberately small.
  return {
    appConfig: {
      ...prebuiltAppConfig,
      model_list: [...prebuiltAppConfig.model_list, ...localRecords],
    },
    models: models.filter(
      (model) => model.source === 'network' || localBaseIds.has(model.baseId),
    ),
  }
}

export function getChatOverrides(model: AvailableModel): ChatOptions | undefined {
  return model.record.overrides
}

export type PreflightFailure = 'no-webgpu' | 'no-adapter'

export interface AdapterFacts {
  vendor?: string
  architecture?: string
  description?: string
  maxBufferMB?: number
}

export type PreflightVerdict =
  | { ok: true; adapter: AdapterFacts }
  | { ok: false; reason: PreflightFailure; detected: string }

/** Absent `navigator.gpu` is knowable before the first paint; nothing else is. */
export function preflightSync(): PreflightVerdict | undefined {
  if (navigator.gpu) return undefined
  return { ok: false, reason: 'no-webgpu', detected: 'navigator.gpu — absent' }
}

// The same probe `assertModelSupported` runs, hoisted ahead of the picker. Mote has no
// degraded mode, so a machine without an adapter should be told that before it is offered a
// model list, a Load button and a several-gigabyte download it can never use.
export async function runPreflight(): Promise<PreflightVerdict> {
  const known = preflightSync()
  if (known) return known

  let adapter: GPUAdapter | null = null
  try {
    adapter = await navigator.gpu.requestAdapter()
  } catch {
    // requestAdapter rejects rather than resolving null on some blocklisted drivers.
    adapter = null
  }
  if (!adapter) {
    return {
      ok: false,
      reason: 'no-adapter',
      detected: 'navigator.gpu — present · requestAdapter() — null',
    }
  }

  const maxBufferSize = adapter.limits.maxBufferSize
  return {
    ok: true,
    adapter: {
      // Every field is optional in the spec and Chrome returns "" for the ones it masks.
      vendor: adapter.info?.vendor || undefined,
      architecture: adapter.info?.architecture || undefined,
      description: adapter.info?.description || undefined,
      maxBufferMB: maxBufferSize ? Math.round(maxBufferSize / 1_048_576) : undefined,
    },
  }
}

export interface ModelDownload {
  bytes: number
  shards: number
}

const downloads = new Map<string, Promise<ModelDownload | undefined>>()

// `ModelRecord` carries VRAM but no download size, and the question in front of a visitor
// about to press Load is how many gigabytes are about to cross the network. The same
// `ndarray-cache.json` WebLLM reads to plan the fetch answers it exactly: `metadata.ParamBytes`
// and one entry per shard. It is ~140 KB, so it is fetched for the selected model only and
// memoised for the session — including for a cached model, whose byte total the load readout
// still needs while the shards go onto the GPU.
export function fetchModelDownload(model: AvailableModel): Promise<ModelDownload | undefined> {
  const pending = downloads.get(model.id)
  if (pending) return pending

  const request = (async (): Promise<ModelDownload | undefined> => {
    try {
      const base = toAbsoluteModelUrl(model.record.model)
      const response = await fetch(new URL('ndarray-cache.json', base).href)
      if (!response.ok) return undefined

      const manifest: unknown = await response.json()
      if (!manifest || typeof manifest !== 'object') return undefined
      const { metadata, records } = manifest as {
        metadata?: { ParamBytes?: unknown }
        records?: unknown
      }
      if (typeof metadata?.ParamBytes !== 'number') return undefined

      return { bytes: metadata.ParamBytes, shards: Array.isArray(records) ? records.length : 0 }
    } catch {
      // A missing or unreachable manifest costs the readout a number, never the load.
      return undefined
    }
  })()

  downloads.set(model.id, request)
  return request
}

export async function assertModelSupported(model: AvailableModel): Promise<void> {
  const gpu = navigator.gpu
  if (!gpu) {
    throw new Error('WebGPU is unavailable. Open Mote in a recent Chrome or Edge browser.')
  }

  const adapter = await gpu.requestAdapter()
  if (!adapter) {
    throw new Error('No WebGPU adapter is available on this device.')
  }

  const requiredVram = model.record.vram_required_MB ?? 0
  if (requiredVram > VRAM_BUDGET_MB) {
    throw new Error(
      `${model.label} needs about ${(requiredVram / 1_024).toFixed(1)} GB of memory; Mote’s safety budget is ${VRAM_BUDGET_MB / 1_024} GB.`,
    )
  }

  const missingFeature = model.record.required_features?.find(
    (feature) => !adapter.features.has(feature),
  )
  if (missingFeature) {
    throw new Error(`${model.label} requires the WebGPU feature “${missingFeature}”.`)
  }

  const requiredBuffer = model.record.buffer_size_required_bytes ?? 0
  const availableBuffer =
    adapter.limits.maxBufferSize ?? adapter.limits.maxStorageBufferBindingSize ?? 0
  if (requiredBuffer > availableBuffer) {
    throw new Error(`${model.label} exceeds this GPU adapter’s maximum buffer size.`)
  }
}
