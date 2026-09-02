import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react'

import type { InitProgressReport } from '@mlc-ai/web-llm'

import type { AvailableModel } from '@/llm/models'

export type ModelPhase = 'idle' | 'checking' | 'loading' | 'ready' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

export interface ModelState {
  phase: ModelPhase
  selectedId: string
  loadedId?: string
  progress?: InitProgressReport
  error?: string
  cachedIds: Set<string>
}

export interface AppState {
  models: AvailableModel[]
  model: ModelState
  messages: ChatMessage[]
  generating: boolean
}

type Action =
  | { type: 'catalogReady'; models: AvailableModel[]; selectedId: string }
  | { type: 'selectModel'; id: string }
  | { type: 'cacheStatus'; ids: Set<string> }
  | { type: 'modelChecking' }
  | { type: 'modelProgress'; report: InitProgressReport }
  | { type: 'modelReady'; id: string }
  | { type: 'modelError'; message: string }
  | { type: 'modelDeleted'; id: string }
  | { type: 'appendMessage'; message: ChatMessage }
  | { type: 'streamMessage'; id: string; content: string }
  | { type: 'finishMessage'; id: string }
  | { type: 'setGenerating'; value: boolean }
  | { type: 'resetChat' }

const initialState: AppState = {
  models: [],
  model: {
    phase: 'idle',
    selectedId: '',
    cachedIds: new Set(),
  },
  messages: [],
  generating: false,
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'catalogReady':
      return {
        ...state,
        models: action.models,
        model: { ...state.model, selectedId: action.selectedId },
      }
    case 'selectModel':
      return {
        ...state,
        model: {
          ...state.model,
          selectedId: action.id,
          error: undefined,
          phase: state.model.loadedId === action.id ? 'ready' : 'idle',
        },
      }
    case 'cacheStatus':
      return { ...state, model: { ...state.model, cachedIds: action.ids } }
    case 'modelChecking':
      return {
        ...state,
        model: { ...state.model, phase: 'checking', error: undefined, progress: undefined },
      }
    case 'modelProgress':
      return {
        ...state,
        model: { ...state.model, phase: 'loading', progress: action.report },
      }
    case 'modelReady':
      return {
        ...state,
        model: {
          ...state.model,
          phase: 'ready',
          loadedId: action.id,
          progress: undefined,
          error: undefined,
          cachedIds: new Set([...state.model.cachedIds, action.id]),
        },
      }
    case 'modelError':
      return {
        ...state,
        model: { ...state.model, phase: 'error', error: action.message, progress: undefined },
      }
    case 'modelDeleted': {
      const cachedIds = new Set(state.model.cachedIds)
      cachedIds.delete(action.id)
      return {
        ...state,
        model: {
          ...state.model,
          cachedIds,
          loadedId: state.model.loadedId === action.id ? undefined : state.model.loadedId,
          phase: state.model.loadedId === action.id ? 'idle' : state.model.phase,
        },
      }
    }
    case 'appendMessage':
      return { ...state, messages: [...state.messages, action.message] }
    case 'streamMessage':
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === action.id
            ? { ...message, content: action.content, pending: true }
            : message,
        ),
      }
    case 'finishMessage':
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === action.id ? { ...message, pending: false } : message,
        ),
      }
    case 'setGenerating':
      return { ...state, generating: action.value }
    case 'resetChat':
      return { ...state, messages: [], generating: false }
  }
}

interface AppContextValue {
  state: AppState
  dispatch: Dispatch<Action>
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const value = useMemo(() => ({ state, dispatch }), [state])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useAppState(): AppContextValue {
  const context = useContext(AppContext)
  if (!context) throw new Error('useAppState must be used inside AppStateProvider')
  return context
}
