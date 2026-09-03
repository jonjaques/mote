import { useCallback, useEffect, useRef } from 'react'

import { track } from '@/analytics'
import { setAutomationGenerating, setAutomationStatus } from '@/automation'
import {
  deleteCachedModel,
  getCachedModelIds,
  loadModel,
  prepareEngine,
} from '@/llm/engine'
import { chooseDefaultModel, runPreflight } from '@/llm/models'
import { AppStateProvider, useAppState } from '@/state'
import { MainArea } from '@/ui/MainArea'
import { SidePane } from '@/ui/SidePane'
import { Unsupported } from '@/ui/Unsupported'

// The model loaded last time is loaded again on the next visit when its weights are already
// cached; from the Cache API that is seconds, and it removes the pick-and-click every reload.
const LAST_MODEL_KEY = 'mote:model:v1'

function MoteApp() {
  const { state, dispatch } = useAppState()
  const initialized = useRef(false)
  const autoloaded = useRef(false)
  const autoloadRequested = useRef(false)

  const loadSelectedModel = useCallback(async () => {
    const selected = state.models.find((model) => model.id === state.model.selectedId)
    if (!selected) return

    dispatch({ type: 'modelChecking' })
    const startedAt = performance.now()
    const wasCached = state.model.cachedIds.has(selected.id)
    try {
      await loadModel(selected, (report) => {
        dispatch({ type: 'modelProgress', report })
        setAutomationStatus({ phase: 'loading', model: selected.id, progress: report.progress })
      })
      dispatch({ type: 'modelReady', id: selected.id })
      setAutomationStatus({ phase: 'ready', model: selected.id, progress: 1 })
      track('model_loaded', {
        model: selected.id,
        source: selected.source,
        cached: wasCached,
        seconds: Math.round((performance.now() - startedAt) / 1_000),
      })
      try {
        localStorage.setItem(LAST_MODEL_KEY, selected.id)
      } catch {
        // Remembering the model is a convenience; a full store must not fail the load.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dispatch({ type: 'modelError', message })
      setAutomationStatus({ phase: 'error', model: selected.id, error: message })
      track('model_load_failed', { model: selected.id, source: selected.source })
    }
  }, [dispatch, state.model.cachedIds, state.model.selectedId, state.models])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    setAutomationStatus({ phase: 'initializing' })

    void (async () => {
      const verdict = await runPreflight()
      dispatch({ type: 'preflight', verdict })
      if (!verdict.ok) {
        // No worker, no catalog, no cache probe. There is nothing on this machine for any of
        // it to run on, and the harness needs a phase it can fail on rather than a timeout.
        setAutomationStatus({ phase: 'unsupported', error: verdict.detected })
        track('preflight_failed', { reason: verdict.reason })
        return
      }

      try {
        const { models } = await prepareEngine()
        const params = new URLSearchParams(window.location.search)
        let remembered: string | null = null
        try {
          remembered = localStorage.getItem(LAST_MODEL_KEY)
        } catch {
          remembered = null
        }

        // The cache probe comes first because it is an input to the choice: a visitor who has
        // already paid for a model's weights should land on that model, not on the one this
        // device could theoretically hold.
        const cachedIds = await getCachedModelIds(models)
        const requestedId = params.get('model') ?? remembered
        const requestedModel = chooseDefaultModel(models, verdict.device, cachedIds, requestedId)

        if (!requestedModel) throw new Error('No compatible WebLLM models were found.')

        autoloadRequested.current =
          params.get('autoload') === '1' ||
          (!params.has('model') && remembered === requestedModel.id && cachedIds.has(requestedModel.id))

        dispatch({
          type: 'catalogReady',
          models,
          selectedId: requestedModel.id,
        })
        dispatch({ type: 'cacheStatus', ids: cachedIds })
        setAutomationStatus({ phase: 'idle', model: requestedModel.id })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        dispatch({ type: 'modelError', message })
        setAutomationStatus({ phase: 'error', error: message })
      }
    })()
  }, [dispatch])

  useEffect(() => {
    if (autoloaded.current || !state.models.length || !autoloadRequested.current) return
    autoloaded.current = true
    void loadSelectedModel()
  }, [loadSelectedModel, state.models.length])

  useEffect(() => {
    setAutomationGenerating(state.generating)
  }, [state.generating])

  // ModelPicker already asked, inline, before calling this. A window.confirm here made the
  // user answer twice and blocked the tab — which the CDP harness cannot dismiss.
  async function deleteSelectedModel() {
    const selected = state.models.find((model) => model.id === state.model.selectedId)
    if (!selected) return

    try {
      await deleteCachedModel(selected.id)
      dispatch({ type: 'modelDeleted', id: selected.id })
      setAutomationStatus({ phase: 'idle', model: selected.id })
    } catch (error) {
      dispatch({
        type: 'modelError',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (state.preflight.status === 'ready' && !state.preflight.verdict.ok) {
    return <Unsupported verdict={state.preflight.verdict} />
  }

  return (
    <div className="mote-shell">
      <SidePane
        onLoadModel={() => void loadSelectedModel()}
        onDeleteModel={() => void deleteSelectedModel()}
      />
      <MainArea />
    </div>
  )
}

export default function App() {
  return (
    <AppStateProvider>
      <MoteApp />
    </AppStateProvider>
  )
}
