import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createModelCatalog,
  FAST_MODEL_ID,
  isPageBuilderModel,
  LOCAL_SUFFIX,
  SMART_MODEL_ID,
  STEP_UP_MODEL_ID,
} from './models'

function mockIndex(records: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(records), { status: 200 })),
  )
}

describe('createModelCatalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the curated prebuilt records when no mirror is served', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const { models, appConfig } = await createModelCatalog()
    expect(models.every((model) => model.source === 'network')).toBe(true)
    expect(models[0]?.baseId).toBe(FAST_MODEL_ID)
    expect(models[1]?.baseId).toBe(SMART_MODEL_ID)
    expect(appConfig.model_list.some((record) => record.model_id.endsWith(LOCAL_SUFFIX))).toBe(false)
  })

  it('suffixes local records, makes their URLs absolute and adds resolve/main/', async () => {
    mockIndex([
      {
        model: `/models/${FAST_MODEL_ID}/`,
        model_id: FAST_MODEL_ID,
        model_lib: `/models/${FAST_MODEL_ID}/lib.wasm`,
        vram_required_MB: 1403,
      },
    ])
    const { models, appConfig } = await createModelCatalog()
    const local = models.find((model) => model.source === 'local')
    expect(local?.id).toBe(`${FAST_MODEL_ID}${LOCAL_SUFFIX}`)
    expect(local?.baseId).toBe(FAST_MODEL_ID)
    expect(local?.record.model).toBe(`${location.origin}/models/${FAST_MODEL_ID}/resolve/main/`)
    expect(local?.record.model_lib).toBe(`${location.origin}/models/${FAST_MODEL_ID}/lib.wasm`)
    // The local row sorts ahead of its network twin so the mirror is the default.
    expect(models[0]).toBe(local)
    expect(models[1]?.baseId).toBe(FAST_MODEL_ID)
    expect(models[1]?.source).toBe('network')
    expect(appConfig.model_list.at(-1)?.model_id).toBe(local?.id)
  })

  it('applies the smart-model context override to local and prebuilt records', async () => {
    mockIndex([
      {
        model: `/models/${SMART_MODEL_ID}/`,
        model_id: SMART_MODEL_ID,
        model_lib: `/models/${SMART_MODEL_ID}/lib.wasm`,
        overrides: { context_window_size: 4096 },
      },
    ])
    const { models } = await createModelCatalog()
    for (const model of models.filter((candidate) => candidate.baseId === SMART_MODEL_ID)) {
      expect(model.record.overrides?.context_window_size).toBe(8192)
    }
    expect(
      models.find((model) => model.baseId === FAST_MODEL_ID)?.record.overrides?.context_window_size,
    ).not.toBe(8192)
  })

  it('ignores malformed mirror entries and models outside the curated list', async () => {
    mockIndex([
      { model_id: 'broken' },
      { model: '/models/x/', model_id: 'Not-Curated-MLC', model_lib: '/models/x/lib.wasm' },
    ])
    const { models, appConfig } = await createModelCatalog()
    expect(models.some((model) => model.source === 'local')).toBe(false)
    expect(appConfig.model_list.some((record) => record.model_id === 'Not-Curated-MLC (local)')).toBe(true)
  })
})

describe('isPageBuilderModel', () => {
  it('recognises the coder models, local or remote, and not the fast one', () => {
    expect(isPageBuilderModel([`${SMART_MODEL_ID}${LOCAL_SUFFIX}`])).toBe(true)
    expect(isPageBuilderModel([STEP_UP_MODEL_ID])).toBe(true)
    expect(isPageBuilderModel([`${FAST_MODEL_ID}${LOCAL_SUFFIX}`])).toBe(false)
    expect(isPageBuilderModel(undefined)).toBe(false)
  })
})
