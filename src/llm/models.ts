import {
  prebuiltAppConfig,
  type AppConfig,
  type ChatOptions,
  type ModelRecord,
} from '@mlc-ai/web-llm'

export const FAST_MODEL_ID = 'Qwen3-0.6B-q4f16_1-MLC'
export const SMART_MODEL_ID = 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC'
export const LOCAL_SUFFIX = ' (local)'

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
  'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC': { label: 'Qwen2.5 Coder 7B · Page builder' },
  'Qwen3-8B-q4f16_1-MLC': { label: 'Qwen3 8B · Reasoning' },
  'Qwen3.5-9B-q4f16_1-MLC': { label: 'Qwen3.5 9B · Largest' },
}

function withOverrides(record: ModelRecord): ModelRecord {
  const contextWindow = curatedModels[record.model_id]?.contextWindow
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
      return withOverrides({
        ...record,
        // WebLLM's cleanModelUrl appends resolve/main/ to any URL that lacks it.
        // Put that segment in the record so cache keys and on-disk paths stay aligned.
        model: toAbsoluteModelUrl(record.model),
        model_id: `${baseId}${LOCAL_SUFFIX}`,
        model_lib: new URL(record.model_lib, window.location.origin).href,
      })
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
    .map(withOverrides)
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
