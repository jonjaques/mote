import { useCallback, useEffect, useRef } from 'react'

import { setAutomationGenerating, setAutomationStatus } from '@/automation'
import {
  deleteCachedModel,
  getCachedModelIds,
  loadModel,
  prepareEngine,
} from '@/llm/engine'
import { FAST_MODEL_ID } from '@/llm/models'
import { AppStateProvider, useAppState } from '@/state'
import { MainArea } from '@/ui/MainArea'
import { SidePane } from '@/ui/SidePane'

function MoteApp() {
  const { state, dispatch } = useAppState()
  const initialized = useRef(false)
  const autoloaded = useRef(false)

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

    void prepareEngine()
      .then(async ({ models }) => {
        const params = new URLSearchParams(window.location.search)
        const requestedId = params.get('model') ?? FAST_MODEL_ID
        const requestedModel =
          models.find((model) => model.baseId === requestedId && model.source === 'local') ??
          models.find((model) => model.id === requestedId) ??
          models.find((model) => model.baseId === requestedId) ??
          models[0]

        if (!requestedModel) throw new Error('No compatible WebLLM models were found.')

        dispatch({
          type: 'catalogReady',
          models,
          selectedId: requestedModel.id,
        })
        dispatch({ type: 'cacheStatus', ids: await getCachedModelIds(models) })
        setAutomationStatus({ phase: 'idle', model: requestedModel.id })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        dispatch({ type: 'modelError', message })
        setAutomationStatus({ phase: 'error', error: message })
      })
  }, [dispatch])

  useEffect(() => {
    if (
      autoloaded.current ||
      !state.models.length ||
      new URLSearchParams(window.location.search).get('autoload') !== '1'
    ) {
      return
    }
    autoloaded.current = true
    void loadSelectedModel()
  }, [loadSelectedModel, state.models.length])

  useEffect(() => {
    setAutomationGenerating(state.generating)
  }, [state.generating])

  async function deleteSelectedModel() {
    const selected = state.models.find((model) => model.id === state.model.selectedId)
    if (!selected) return
    if (!window.confirm(`Delete cached files for ${selected.label}?`)) return

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
