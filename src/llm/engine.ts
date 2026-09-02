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
  await prepared.engine.reload(model.id, getChatOverrides(model))
  return prepared.engine
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
