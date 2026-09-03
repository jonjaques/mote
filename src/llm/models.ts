import {
  ModelType,
  functionCallingModelIds,
  prebuiltAppConfig,
  type AppConfig,
  type ChatOptions,
  type ModelRecord,
} from '@mlc-ai/web-llm'

export const FAST_MODEL_ID = 'Qwen3-0.6B-q4f16_1-MLC'
export const SMART_MODEL_ID = 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC'
export const STEP_UP_MODEL_ID = 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC'
export const LOCAL_SUFFIX = ' (local)'

// The three the tool loop has actually been driven through, largest first. HANDOFF.md carries
// the pass rates. Everything else in the catalog is offered on the strength of its size and
// its feature requirements only — which is a fact about this device, not a claim about the
// model — so these are the only ids the picker is allowed to call recommended.
const PROVEN_MODEL_IDS = [STEP_UP_MODEL_ID, SMART_MODEL_ID, FAST_MODEL_ID]

// Raising a context window past what the compiled kernels were built for fails at load, so the
// override stays keyed to the models it was measured on rather than applied by family.
const CONTEXT_OVERRIDES: Record<string, number> = {
  [SMART_MODEL_ID]: 8_192,
  [STEP_UP_MODEL_ID]: 8_192,
}

// The stylesheet guard in the agent exists because the 0.6B rewrites index.html wholesale and
// never links styles.css, while the 1.5B and 7B coders keep the two-file shape. Parameter count
// is what separates them, and it is the only thing a 163-model catalog can read off an id.
const PAGE_BUILDER_MIN_PARAMS_B = 1.2

export function isPageBuilderModel(loadedIds: string[] | undefined): boolean {
  return (
    loadedIds?.some((id) => {
      const params = parseModelId(id.replace(LOCAL_SUFFIX, '')).paramsB
      return params !== undefined && params >= PAGE_BUILDER_MIN_PARAMS_B
    }) ?? false
  )
}

export type ModelSource = 'local' | 'network'
export type ModelRole = 'coder' | 'reasoning' | 'vision' | 'math'

/**
 * How a model stands against the device in front of it.
 *   proven   measured here, and inside the budget
 *   fits     inside the budget
 *   tight    over the budget but within the headroom a wrong estimate could account for
 *   over     too large to attempt
 *   blocked  the adapter cannot run it at all, at any size
 */
export type ModelFit = 'proven' | 'fits' | 'tight' | 'over' | 'blocked'

export interface AvailableModel {
  id: string
  baseId: string
  /** The id with the quantisation and the -MLC suffix removed; the name, verbatim. */
  label: string
  quantization: string
  /** Present only on the reduced-context builds WebLLM publishes as `-1k`. */
  contextNote?: string
  paramsB?: number
  vramMB: number
  role?: ModelRole
  /** Hermes ids WebLLM would accept its own `tools` parameter for; Mote uses structural tags. */
  nativeToolCalling: boolean
  source: ModelSource
  record: ModelRecord
}

// Every prebuilt id is `<name>-<quantisation>-MLC[-<variant>]`, e.g.
// `Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` or `Llama-3-8B-Instruct-q4f32_1-MLC-1k`. The name is
// shown verbatim rather than prettified: it is the id the harness, the URL parameter and the
// cache all use, and a visitor reading a model menu in a debugger is owed the real string.
const MODEL_ID = /^(?<name>.+?)-(?<quant>q\df(?:16|32)(?:_[01])?)-MLC(?<variant>-\w+)?$/
const PARAMS = /(\d+(?:[._]\d+)?)([bm])(?:[-_]|$)/i

// The one family whose ids say "mini" instead of a size. Published counts, so the page-builder
// threshold and the menu's size column do not simply go blank for six of the catalog's models.
const PARAMS_BY_NAME: Record<string, number> = {
  'phi-1_5': 1.3,
  'phi-2': 2.7,
  'Phi-3-mini-4k-instruct': 3.8,
  'Phi-3.5-mini-instruct': 3.8,
  'Phi-3.5-vision-instruct': 4.2,
  'Phi-4-mini-instruct': 3.8,
}

interface ParsedModelId {
  label: string
  quantization: string
  contextNote?: string
  paramsB?: number
  role?: ModelRole
}

function parseModelId(modelId: string): ParsedModelId {
  const match = MODEL_ID.exec(modelId)
  const label = match?.groups?.name ?? modelId
  const params = PARAMS.exec(label)
  const magnitude = params?.[2].toLowerCase() === 'm' ? 0.001 : 1

  return {
    label,
    quantization: match?.groups?.quant ?? '—',
    // `-1k` is a separate build with a 1024-token window, which for an agent that reads files
    // back is the difference between a working turn and a truncated one. It has to be visible.
    contextNote: match?.groups?.variant === '-1k' ? '1k context' : undefined,
    paramsB: params
      ? Number(params[1].replace('_', '.')) * magnitude
      : PARAMS_BY_NAME[label],
    role: /coder/i.test(label)
      ? 'coder'
      : /math/i.test(label)
        ? 'math'
        : /r1-distill|reasoning|thinking/i.test(label)
          ? 'reasoning'
          : undefined,
  }
}

// ---- Device ---------------------------------------------------------------------------------

export type PreflightFailure = 'no-webgpu' | 'no-adapter'

export interface DeviceProfile {
  vendor?: string
  architecture?: string
  description?: string
  maxBufferMB?: number
  /** `navigator.deviceMemory`, in GB. Chrome only, and the spec caps what it will report at 8. */
  memoryGB?: number
  /** Half-precision shaders. Without them every `q*f16` build in the catalog is unrunnable. */
  shaderF16: boolean
  /** What Mote is willing to spend on weights here, in MB. See `estimateBudgetMB`. */
  budgetMB: number
}

export type PreflightVerdict =
  | { ok: true; device: DeviceProfile }
  | { ok: false; reason: PreflightFailure; detected: string }

const REPORTED_MEMORY_CAP_GB = 8
const ASSUMED_MEMORY_GB = 4
const BUDGET_SHARE = 0.75
/** How far past the estimate a model may still be offered, given the estimate is an estimate. */
const TIGHT_HEADROOM = 1.5

// WebGPU exposes no VRAM figure — deliberately, it is a fingerprinting surface — so the budget
// is inferred, and the inference is stated to the visitor rather than hidden behind a verdict.
//
// `navigator.deviceMemory` is system RAM, capped at 8 GB by the spec and absent outside Chrome.
// It is the right base anyway: every device Mote runs on well has unified or shared memory, so
// weights come out of that pool. Three quarters of it leaves room for the browser, the page and
// the compositor, and lands on 6 GB for a machine reporting the 8 GB cap — the same figure that
// was hand-set and measured against the 7B (5.1 GB resident, loads and generates) on this one.
function estimateBudgetMB(memoryGB: number | undefined): number {
  const memory = Math.min(memoryGB ?? ASSUMED_MEMORY_GB, REPORTED_MEMORY_CAP_GB)
  return Math.round(memory * 1_024 * BUDGET_SHARE)
}

function readDeviceMemoryGB(): number | undefined {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return typeof memory === 'number' && memory > 0 ? memory : undefined
}

/** Absent `navigator.gpu` is knowable before the first paint; nothing else is. */
export function preflightSync(): PreflightVerdict | undefined {
  if (navigator.gpu) return undefined
  return { ok: false, reason: 'no-webgpu', detected: 'navigator.gpu — absent' }
}

let deviceProfile: DeviceProfile | undefined

// The same probe `assertModelSupported` runs, hoisted ahead of the picker. Mote has no degraded
// mode, so a machine without an adapter should be told that before it is offered a model list,
// a Load button and a several-gigabyte download it can never use.
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
  const memoryGB = readDeviceMemoryGB()
  deviceProfile = {
    // Every field is optional in the spec and Chrome returns "" for the ones it masks.
    vendor: adapter.info?.vendor || undefined,
    architecture: adapter.info?.architecture || undefined,
    description: adapter.info?.description || undefined,
    maxBufferMB: maxBufferSize ? Math.round(maxBufferSize / 1_048_576) : undefined,
    memoryGB,
    shaderF16: adapter.features.has('shader-f16'),
    budgetMB: estimateBudgetMB(memoryGB),
  }

  return { ok: true, device: deviceProfile }
}

// ---- Fit ------------------------------------------------------------------------------------

export function classifyFit(model: AvailableModel, device: DeviceProfile | undefined): ModelFit {
  if (!device) return 'fits'

  // The quantisation, not the metadata, is what decides this. Half-precision kernels need
  // shader-f16, but only 29 of the 85 `f16` records in 0.2.84 declare `required_features` —
  // trusting the field would offer 56 models to a GPU that cannot run one of them, and the
  // failure surfaces as a shader compile error deep inside the load.
  const needsHalfPrecision =
    model.quantization.includes('f16') || (model.record.required_features?.includes('shader-f16') ?? false)
  const requiredBufferMB = (model.record.buffer_size_required_bytes ?? 0) / 1_048_576
  if (
    (needsHalfPrecision && !device.shaderF16) ||
    (device.maxBufferMB && requiredBufferMB > device.maxBufferMB)
  ) {
    return 'blocked'
  }

  if (model.vramMB > device.budgetMB * TIGHT_HEADROOM) return 'over'
  if (model.vramMB > device.budgetMB) return 'tight'
  return PROVEN_MODEL_IDS.includes(model.baseId) ? 'proven' : 'fits'
}

export function describeFit(fit: ModelFit, device: DeviceProfile | undefined): string | undefined {
  const budget = device ? `${(device.budgetMB / 1_024).toFixed(1)} GB` : 'this device'
  switch (fit) {
    case 'tight':
      return `Larger than the ${budget} this device is estimated to spare. It may load, or it may run out of memory partway.`
    case 'over':
      return `Too large for the ${budget} this device is estimated to spare.`
    case 'blocked':
      return device?.shaderF16 === false
        ? 'This GPU has no shader-f16, so half-precision builds cannot run on it. The q4f32 builds can.'
        : 'This GPU adapter’s buffer limit is below what this build needs.'
    default:
      return undefined
  }
}

/** The most capable proven model this device can hold, and the quickest one worth starting on. */
export function recommendModels(
  models: AvailableModel[],
  device: DeviceProfile | undefined,
): { best?: AvailableModel; starter?: AvailableModel } {
  const proven = PROVEN_MODEL_IDS.map((id) =>
    models.find((model) => model.baseId === id && classifyFit(model, device) === 'proven'),
  ).filter((model): model is AvailableModel => model !== undefined)

  return {
    best: proven[0],
    // A first visit is a download, and PRODUCT.md's visitor has 60 seconds. The starter is the
    // smallest proven model that still builds whole pages — not the smallest overall, which
    // would open on the 0.6B and demo a model that rewrites index.html wholesale.
    starter:
      [...proven]
        .reverse()
        .find((model) => model.paramsB !== undefined && model.paramsB >= PAGE_BUILDER_MIN_PARAMS_B) ??
      proven.at(-1),
  }
}

/**
 * What the picker opens on. A remembered or requested id wins; then anything already paid for
 * in cache; then the recommendation. Nothing here starts a download on its own — Load does.
 */
export function chooseDefaultModel(
  models: AvailableModel[],
  device: DeviceProfile | undefined,
  cachedIds: Set<string>,
  requestedId?: string | null,
): AvailableModel | undefined {
  if (requestedId) {
    const requested =
      models.find((model) => model.baseId === requestedId && model.source === 'local') ??
      models.find((model) => model.id === requestedId) ??
      models.find((model) => model.baseId === requestedId)
    if (requested) return requested
  }

  const cached = models
    .filter((model) => cachedIds.has(model.id) && classifyFit(model, device) !== 'over')
    .sort((a, b) => b.vramMB - a.vramMB)
  if (cached.length) return cached[0]

  const { starter, best } = recommendModels(models, device)
  return starter ?? best ?? models.find((model) => classifyFit(model, device) === 'fits') ?? models[0]
}

// ---- Catalog --------------------------------------------------------------------------------

// `baseId` is the prebuilt id; local records carry the ` (local)` suffix in `model_id` and would
// otherwise never match, leaving the mirror at the prebuilt 4096 context.
function withOverrides(record: ModelRecord, baseId = record.model_id): ModelRecord {
  const contextWindow = CONTEXT_OVERRIDES[baseId]
  if (!contextWindow) return record

  return {
    ...record,
    overrides: { ...record.overrides, context_window_size: contextWindow },
  }
}

function asAvailable(record: ModelRecord, source: ModelSource, baseId = record.model_id): AvailableModel {
  const parsed = parseModelId(baseId)
  return {
    id: record.model_id,
    baseId,
    ...parsed,
    vramMB: record.vram_required_MB ?? 0,
    nativeToolCalling: functionCallingModelIds.includes(baseId),
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

// The mirror is a development convenience: three ids that happen to be on one machine's disk,
// served by Vite middleware that only exists in dev. A production build must not fetch
// /models/index.json at all — on Cloudflare Pages that path answers with the SPA shell, and a
// 200 HTML body parsed as a record list is how the model cache gets poisoned.
async function loadLocalRecords(): Promise<ModelRecord[]> {
  if (!import.meta.env.DEV) return []

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
          // WebLLM's cleanModelUrl appends resolve/main/ to any URL that lacks it. Put that
          // segment in the record so cache keys and on-disk paths stay aligned.
          model: toAbsoluteModelUrl(record.model),
          model_id: `${baseId}${LOCAL_SUFFIX}`,
          model_lib: new URL(record.model_lib, window.location.origin).href,
        },
        baseId,
      )
    })
  } catch {
    return []
  }
}

export async function createModelCatalog(): Promise<{
  appConfig: AppConfig
  models: AvailableModel[]
}> {
  // Every prebuilt record except the embedding models: those have no chat completion at all and
  // throw on `reload`. Vision builds stay — they answer text prompts like any other model.
  const remoteRecords = prebuiltAppConfig.model_list
    .filter((record) => record.model_type !== ModelType.embedding)
    .map((record) => withOverrides(record))
  const localRecords = await loadLocalRecords()

  const models = [
    ...localRecords.map((record) =>
      asAvailable(record, 'local', record.model_id.slice(0, -LOCAL_SUFFIX.length)),
    ),
    ...remoteRecords.map((record) => asAvailable(record, 'network')),
  ]

  const vision = new Set(
    prebuiltAppConfig.model_list
      .filter((record) => record.model_type === ModelType.VLM)
      .map((record) => record.model_id),
  )
  for (const model of models) {
    if (vision.has(model.baseId)) model.role = 'vision'
  }

  return {
    // Keep every upstream record available to WebLLM, embeddings included: the picker decides
    // what to offer, `appConfig` decides what `reload` can resolve.
    appConfig: {
      ...prebuiltAppConfig,
      model_list: [...prebuiltAppConfig.model_list, ...localRecords],
    },
    models,
  }
}

/** Menu order: the mirror, then by name, then smallest build of a name first. */
export function sortModels(models: AvailableModel[]): AvailableModel[] {
  return [...models].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'local' ? -1 : 1
    if (a.label !== b.label) return a.label.localeCompare(b.label)
    return a.vramMB - b.vramMB
  })
}

export function getChatOverrides(model: AvailableModel): ChatOptions | undefined {
  return model.record.overrides
}

// ---- Download size --------------------------------------------------------------------------

export interface ModelDownload {
  bytes: number
  shards: number
}

const downloads = new Map<string, Promise<ModelDownload | undefined>>()

// `ModelRecord` carries VRAM but no download size, and the question in front of a visitor about
// to press Load is how many gigabytes are about to cross the network. The same
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

// ---- Load gate ------------------------------------------------------------------------------

export async function assertModelSupported(model: AvailableModel): Promise<void> {
  const gpu = navigator.gpu
  if (!gpu) {
    throw new Error('WebGPU is unavailable. Open Mote in a recent Chrome or Edge browser.')
  }

  const adapter = await gpu.requestAdapter()
  if (!adapter) {
    throw new Error('No WebGPU adapter is available on this device.')
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

  // The size gate is a backstop, not the interface: the picker already disables what does not
  // fit. It stays because a load that outruns the GPU takes the tab with it, and a `?model=`
  // in the URL reaches this path without ever passing through the menu.
  const device = deviceProfile
  if (device && model.vramMB > device.budgetMB * TIGHT_HEADROOM) {
    throw new Error(
      `${model.label} needs about ${(model.vramMB / 1_024).toFixed(1)} GB; this device is estimated to spare ${(device.budgetMB / 1_024).toFixed(1)} GB.`,
    )
  }
}
