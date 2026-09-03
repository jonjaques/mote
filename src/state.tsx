import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react'

import type { InitProgressReport } from '@mlc-ai/web-llm'

import type { AgentToolActivity } from '@/llm/agent'
import type { AvailableModel } from '@/llm/models'

const CHAT_STORAGE_KEY = 'mote:chat:v1'

export type ModelPhase = 'idle' | 'checking' | 'loading' | 'ready' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  cutOff?: boolean
  tools?: AgentToolActivity[]
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
  | { type: 'toolActivity'; messageId: string; activity: AgentToolActivity }
  | { type: 'finishMessage'; id: string; cutOff?: boolean }
  | { type: 'setGenerating'; value: boolean }
  | { type: 'resetChat' }

function loadMessages(): ChatMessage[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((message): message is ChatMessage => {
      if (!message || typeof message !== 'object') return false
      const candidate = message as Partial<ChatMessage>
      return (
        typeof candidate.id === 'string' &&
        (candidate.role === 'user' || candidate.role === 'assistant') &&
        typeof candidate.content === 'string'
      )
    })
  } catch {
    return []
  }
}

function createInitialState(): AppState {
  return {
    models: [],
    model: {
      phase: 'idle',
      selectedId: '',
      cachedIds: new Set(),
    },
    messages: loadMessages(),
    generating: false,
  }
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
    case 'toolActivity':
      return {
        ...state,
        messages: state.messages.map((message) => {
          if (message.id !== action.messageId) return message
          const tools = message.tools ?? []
          const existing = tools.findIndex((tool) => tool.id === action.activity.id)
          return {
            ...message,
            tools:
              existing === -1
                ? [...tools, action.activity]
                : tools.map((tool) =>
                    tool.id === action.activity.id ? action.activity : tool,
                  ),
          }
        }),
      }
    case 'finishMessage':
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === action.id
            ? { ...message, pending: false, cutOff: action.cutOff }
            : message,
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
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState)
  const value = useMemo(() => ({ state, dispatch }), [state])

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state.messages))
    } catch {
      // Chat remains available for this tab when browser storage is unavailable or full.
    }
  }, [state.messages])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useAppState(): AppContextValue {
  const context = useContext(AppContext)
  if (!context) throw new Error('useAppState must be used inside AppStateProvider')
  return context
}
