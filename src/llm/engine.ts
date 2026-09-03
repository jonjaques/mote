import {
  WebWorkerMLCEngine,
  deleteModelAllInfoInCache,
  hasModelInCache,
  type AppConfig,
  type InitProgressReport,
} from '@mlc-ai/web-llm'

import {
  assertModelSupported,
  createModelCatalog,
  getChatOverrides,
  type AvailableModel,
} from './models'

let engine: WebWorkerMLCEngine | undefined
let appConfig: AppConfig | undefined
let availableModels: AvailableModel[] | undefined
let persistenceRequested = false

export interface StorageEstimate {
  persisted: boolean
  usage?: number
  quota?: number
}

async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (persistenceRequested) return navigator.storage.persisted?.() ?? false

  persistenceRequested = true
  return navigator.storage.persist()
}

export async function prepareEngine(): Promise<{
  engine: WebWorkerMLCEngine
  appConfig: AppConfig
  models: AvailableModel[]
}> {
  if (!appConfig || !availableModels) {
    const catalog = await createModelCatalog()
    appConfig = catalog.appConfig
    availableModels = catalog.models
  }

  if (!engine) {
    // Vite needs this literal new URL expression in the Worker constructor to split the worker.
    engine = new WebWorkerMLCEngine(
      new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
      { appConfig },
    )
  } else {
    engine.setAppConfig(appConfig)
  }

  void requestPersistentStorage()

  return { engine, appConfig, models: availableModels }
}

export async function loadModel(
  model: AvailableModel,
  onProgress: (report: InitProgressReport) => void,
): Promise<WebWorkerMLCEngine> {
  const prepared = await prepareEngine()
  await assertModelSupported(model)
  prepared.engine.setInitProgressCallback(onProgress)

  try {
    await prepared.engine.reload(model.id, getChatOverrides(model))
  } catch (error) {
    if (!isPoisonedCacheError(error)) throw error
    // A previous miss cached Vite's HTML shell under webllm/config. Drop it and retry once.
    await deleteModelAllInfoInCache(model.id, prepared.appConfig)
    await prepared.engine.reload(model.id, getChatOverrides(model))
  }

  return prepared.engine
}

function isPoisonedCacheError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("Unexpected token '<'") || message.includes('is not valid JSON')
}

export async function getCachedModelIds(models: AvailableModel[]): Promise<Set<string>> {
  const prepared = await prepareEngine()
  const statuses = await Promise.all(
    models.map(async (model) => ({
      id: model.id,
      cached: await hasModelInCache(model.id, prepared.appConfig),
    })),
  )
  return new Set(statuses.filter((status) => status.cached).map((status) => status.id))
}

export async function deleteCachedModel(modelId: string): Promise<void> {
  const prepared = await prepareEngine()
  if (prepared.engine.modelId?.includes(modelId)) {
    await prepared.engine.unload()
  }
  await deleteModelAllInfoInCache(modelId, prepared.appConfig)
}

export async function getStorageEstimate(): Promise<StorageEstimate> {
  const [persisted, estimate] = await Promise.all([
    navigator.storage?.persisted?.() ?? Promise.resolve(false),
    navigator.storage?.estimate?.() ?? Promise.resolve({}),
  ])

  return {
    persisted,
    usage: estimate.usage,
    quota: estimate.quota,
  }
}

export function interruptGeneration(): void {
  engine?.interruptGenerate()
}

export interface LoadReport {
  /** `fetch` = shards crossing the network, `gpu` = cached shards going onto the device. */
  phase: 'fetch' | 'gpu' | 'other'
  shard?: number
  shards?: number
  bytes?: number
  text: string
}

// WebLLM reports load progress as one prose string:
//   "Fetching param cache[12/88]: 2100MB fetched. 47% completed, 12 secs elapsed. It can take
//    a while when we first visit this page to populate the cache. Later refreshes will…"
// Rendering it verbatim buried the two facts that matter — which shard, and whether the bytes
// are still arriving or already going onto the GPU — under an apology for the wait. Those
// fields exist nowhere on the report object, so parsing the sentence is the only route to
// them; an unrecognised string falls through to `other` and is shown as written.
const PROGRESS_TEXT = /^(Fetching param cache|Loading model from cache)\[(\d+)\/(\d+)]:\s*(\d+)MB/

export function parseLoadReport(text: string | undefined): LoadReport {
  const trimmed = text?.trim() ?? ''
  const match = PROGRESS_TEXT.exec(trimmed)
  if (!match) return { phase: 'other', text: trimmed }

  return {
    phase: match[1] === 'Fetching param cache' ? 'fetch' : 'gpu',
    shard: Number(match[2]),
    shards: Number(match[3]),
    bytes: Number(match[4]) * 1_048_576,
    text: trimmed,
  }
}
