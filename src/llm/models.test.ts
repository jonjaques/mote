import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  chooseDefaultModel,
  classifyFit,
  createModelCatalog,
  FAST_MODEL_ID,
  isPageBuilderModel,
  LOCAL_SUFFIX,
  recommendModels,
  SMART_MODEL_ID,
  sortModels,
  STEP_UP_MODEL_ID,
  type AvailableModel,
  type DeviceProfile,
} from './models'

function mockIndex(records: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(records), { status: 200 })),
  )
}

/** A machine that reports the 8 GB `deviceMemory` cap: the budget this repo measured against. */
const device: DeviceProfile = {
  vendor: 'apple',
  architecture: 'metal-3',
  maxBufferMB: 4_096,
  memoryGB: 8,
  shaderF16: true,
  budgetMB: 6_144,
}

describe('createModelCatalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('offers every prebuilt chat model and no embedding model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const { models } = await createModelCatalog()

    expect(models.length).toBeGreaterThan(100)
    expect(models.every((model) => model.source === 'network')).toBe(true)
    expect(models.some((model) => model.baseId.includes('arctic-embed'))).toBe(false)
    expect(models.some((model) => model.baseId === STEP_UP_MODEL_ID)).toBe(true)
  })

  it('splits an id into its name, quantisation, size and variant', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const { models } = await createModelCatalog()

    const coder = models.find((model) => model.baseId === STEP_UP_MODEL_ID)
    expect(coder?.label).toBe('Qwen2.5-Coder-7B-Instruct')
    expect(coder?.quantization).toBe('q4f16_1')
    expect(coder?.paramsB).toBe(7)
    expect(coder?.role).toBe('coder')
    expect(coder?.contextNote).toBeUndefined()

    // The reduced-context builds have to be distinguishable: 1024 tokens is not enough for a
    // turn that reads a file back before rewriting it.
    const short = models.find((model) => model.id.endsWith('-MLC-1k'))
    expect(short?.contextNote).toBe('1k context')

    // Six ids state "mini" instead of a size; those come from the published table.
    const phi = models.find((model) => model.baseId.startsWith('Phi-3.5-mini'))
    expect(phi?.paramsB).toBe(3.8)
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
    expect(local?.label).toBe('Qwen3-0.6B')
    expect(local?.record.model).toBe(`${location.origin}/models/${FAST_MODEL_ID}/resolve/main/`)
    expect(local?.record.model_lib).toBe(`${location.origin}/models/${FAST_MODEL_ID}/lib.wasm`)
    expect(appConfig.model_list.at(-1)?.model_id).toBe(local?.id)
    // The mirror sorts ahead of the network catalog so a dev machine defaults to its own bytes.
    expect(sortModels(models)[0]).toBe(local)
  })

  it('never reads the mirror index in a production build', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubEnv('DEV', false)

    const { models, appConfig } = await createModelCatalog()

    // A deployed miss on /models/index.json is a 404 only while `not_found_handling` stays
    // "none"; under single-page-application it answers 200 with the HTML shell, and HTML parsed
    // as a record list is how the weight cache gets poisoned.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(models.every((model) => model.source === 'network')).toBe(true)
    expect(appConfig.model_list.some((record) => record.model_id.endsWith(LOCAL_SUFFIX))).toBe(false)
  })

  it('applies the coder context override to local and prebuilt records alike', async () => {
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
      models.find((model) => model.baseId === FAST_MODEL_ID)?.record.overrides
        ?.context_window_size,
    ).not.toBe(8192)
  })

  it('ignores malformed mirror entries', async () => {
    mockIndex([
      { model_id: 'broken' },
      { model: '/models/x/', model_id: 'Not-Prebuilt-MLC', model_lib: '/models/x/lib.wasm' },
    ])
    const { models } = await createModelCatalog()
    const local = models.filter((model) => model.source === 'local')

    expect(local).toHaveLength(1)
    expect(local[0]?.baseId).toBe('Not-Prebuilt-MLC')
  })
})

describe('classifyFit', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function catalog(): Promise<AvailableModel[]> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    return (await createModelCatalog()).models
  }

  it('files each model under what this device can hold', async () => {
    const models = await catalog()
    const find = (id: string) => models.find((model) => model.baseId === id)!

    expect(classifyFit(find(STEP_UP_MODEL_ID), device)).toBe('proven')
    expect(classifyFit(find(FAST_MODEL_ID), device)).toBe('proven')
    expect(classifyFit(find('Llama-3.2-3B-Instruct-q4f16_1-MLC'), device)).toBe('fits')
    expect(classifyFit(find('Llama-3.1-70B-Instruct-q3f16_1-MLC'), device)).toBe('over')

    const tight = models.find(
      (model) => model.vramMB > device.budgetMB && model.vramMB < device.budgetMB * 1.5,
    )
    expect(tight && classifyFit(tight, device)).toBe('tight')
  })

  it('blocks half-precision builds on an adapter without shader-f16', async () => {
    const models = await catalog()
    const noF16: DeviceProfile = { ...device, shaderF16: false }
    const half = models.find((model) => model.baseId === 'Qwen2.5-3B-Instruct-q4f16_1-MLC')!
    const full = models.find((model) => model.baseId === 'Qwen2.5-3B-Instruct-q4f32_1-MLC')!

    expect(classifyFit(half, noF16)).toBe('blocked')
    expect(classifyFit(full, noF16)).toBe('fits')
  })

  it('claims nothing before the device has been probed', async () => {
    const models = await catalog()
    expect(classifyFit(models[0]!, undefined)).toBe('fits')
  })
})

describe('recommendModels and chooseDefaultModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function catalog(): Promise<AvailableModel[]> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    return (await createModelCatalog()).models
  }

  it('names the largest measured model that fits, and a smaller one to start on', async () => {
    const models = await catalog()
    const { best, starter } = recommendModels(models, device)

    expect(best?.baseId).toBe(STEP_UP_MODEL_ID)
    // 830 MB rather than 4.4 GB: the starter still builds whole pages, and a first visit is a
    // download the visitor is waiting through.
    expect(starter?.baseId).toBe(SMART_MODEL_ID)
  })

  it('recommends only what the budget allows', async () => {
    const models = await catalog()
    const small: DeviceProfile = { ...device, memoryGB: 2, budgetMB: 1_536 }
    const { best } = recommendModels(models, small)

    expect(best?.baseId).toBe(FAST_MODEL_ID)
  })

  it('prefers an explicit request, then cached weights, then the recommendation', async () => {
    const models = await catalog()
    const cached = new Set([STEP_UP_MODEL_ID])

    expect(chooseDefaultModel(models, device, new Set(), FAST_MODEL_ID)?.baseId).toBe(FAST_MODEL_ID)
    expect(chooseDefaultModel(models, device, cached)?.baseId).toBe(STEP_UP_MODEL_ID)
    expect(chooseDefaultModel(models, device, new Set())?.baseId).toBe(SMART_MODEL_ID)
    // An id that is not in the catalog must not strand the picker on nothing.
    expect(chooseDefaultModel(models, device, new Set(), 'no-such-model')).toBeDefined()
  })
})

describe('isPageBuilderModel', () => {
  it('recognises models large enough to keep a two-file project, local or remote', () => {
    expect(isPageBuilderModel([`${SMART_MODEL_ID}${LOCAL_SUFFIX}`])).toBe(true)
    expect(isPageBuilderModel([STEP_UP_MODEL_ID])).toBe(true)
    expect(isPageBuilderModel(['Llama-3.2-3B-Instruct-q4f16_1-MLC'])).toBe(true)
    expect(isPageBuilderModel([`${FAST_MODEL_ID}${LOCAL_SUFFIX}`])).toBe(false)
    expect(isPageBuilderModel(['SmolLM2-360M-Instruct-q4f16_1-MLC'])).toBe(false)
    expect(isPageBuilderModel(undefined)).toBe(false)
  })
})
