import { useCallback, useEffect, useRef } from 'react'

import { setAutomationGenerating, setAutomationStatus } from '@/automation'
import {
  deleteCachedModel,
  getCachedModelIds,
  loadModel,
  prepareEngine,
} from '@/llm/engine'
import { FAST_MODEL_ID, runPreflight } from '@/llm/models'
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
    try {
      await loadModel(selected, (report) => {
        dispatch({ type: 'modelProgress', report })
        setAutomationStatus({ phase: 'loading', model: selected.id, progress: report.progress })
      })
      dispatch({ type: 'modelReady', id: selected.id })
      setAutomationStatus({ phase: 'ready', model: selected.id, progress: 1 })
      try {
        localStorage.setItem(LAST_MODEL_KEY, selected.id)
      } catch {
        // Remembering the model is a convenience; a full store must not fail the load.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dispatch({ type: 'modelError', message })
      setAutomationStatus({ phase: 'error', model: selected.id, error: message })
    }
  }, [dispatch, state.model.selectedId, state.models])

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
        const requestedId = params.get('model') ?? remembered ?? FAST_MODEL_ID
        const requestedModel =
          models.find((model) => model.baseId === requestedId && model.source === 'local') ??
          models.find((model) => model.id === requestedId) ??
          models.find((model) => model.baseId === requestedId) ??
          models[0]

        if (!requestedModel) throw new Error('No compatible WebLLM models were found.')

        const cachedIds = await getCachedModelIds(models)
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
