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

import type { AgentProgress, AgentStats, AgentToolActivity } from '@/llm/agent'
import { preflightSync, type AvailableModel, type PreflightVerdict } from '@/llm/models'

const CHAT_STORAGE_KEY = 'mote:chat:v1'

export type ModelPhase = 'idle' | 'checking' | 'loading' | 'ready' | 'error'
export type WorkspaceView = 'preview' | 'files' | 'console'
export type PreviewWidth = 'desktop' | 'mobile'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  cutOff?: boolean
  stopped?: boolean
  tools?: AgentToolActivity[]
  stats?: AgentStats
}

export interface ModelState {
  phase: ModelPhase
  selectedId: string
  loadedId?: string
  progress?: InitProgressReport
  error?: string
  cachedIds: Set<string>
}

/** `checking` only ever means the async adapter probe; absent WebGPU resolves synchronously. */
export type PreflightState = { status: 'checking' } | { status: 'ready'; verdict: PreflightVerdict }

export interface WorkspaceState {
  view: WorkspaceView
  selectedPath: string
  previewWidth: PreviewWidth
}

export interface AppState {
  preflight: PreflightState
  models: AvailableModel[]
  model: ModelState
  messages: ChatMessage[]
  generating: boolean
  // Live position inside the current generation; undefined between turns.
  progress?: AgentProgress
  workspace: WorkspaceState
}

type Action =
  | { type: 'preflight'; verdict: PreflightVerdict }
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
  | { type: 'generationProgress'; progress?: AgentProgress }
  | { type: 'finishMessage'; id: string; cutOff?: boolean; stopped?: boolean; stats?: AgentStats }
  | { type: 'setGenerating'; value: boolean }
  | { type: 'resetChat' }
  | { type: 'setView'; view: WorkspaceView }
  | { type: 'openFile'; path: string }
  | { type: 'setPreviewWidth'; width: PreviewWidth }

function loadMessages(): ChatMessage[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((message): message is ChatMessage => {
        if (!message || typeof message !== 'object') return false
        const candidate = message as Partial<ChatMessage>
        return (
          typeof candidate.id === 'string' &&
          (candidate.role === 'user' || candidate.role === 'assistant') &&
          typeof candidate.content === 'string'
        )
      })
      // A turn that was mid-generation when the tab closed can never finish.
      .map((message) => (message.pending ? { ...message, pending: false, stopped: true } : message))
  } catch {
    return []
  }
}

function createInitialState(): AppState {
  // Resolved before the first paint where it can be: a machine with no `navigator.gpu` should
  // never see the shell it cannot use flash past on its way to the refusal.
  const known = preflightSync()
  return {
    preflight: known ? { status: 'ready', verdict: known } : { status: 'checking' },
    models: [],
    model: {
      phase: 'idle',
      selectedId: '',
      cachedIds: new Set(),
    },
    messages: loadMessages(),
    generating: false,
    workspace: { view: 'preview', selectedPath: 'index.html', previewWidth: 'desktop' },
  }
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'preflight':
      return { ...state, preflight: { status: 'ready', verdict: action.verdict } }
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
    case 'generationProgress':
      return { ...state, progress: action.progress }
    case 'finishMessage':
      return {
        ...state,
        progress: undefined,
        messages: state.messages.map((message) =>
          message.id === action.id
            ? {
                ...message,
                pending: false,
                cutOff: action.cutOff,
                stopped: action.stopped,
                stats: action.stats,
              }
            : message,
        ),
      }
    case 'setGenerating':
      return { ...state, generating: action.value }
    case 'resetChat':
      return { ...state, messages: [], generating: false, progress: undefined }
    case 'setView':
      return { ...state, workspace: { ...state.workspace, view: action.view } }
    case 'openFile':
      return {
        ...state,
        workspace: { ...state.workspace, view: 'files', selectedPath: action.path },
      }
    case 'setPreviewWidth':
      return {
        ...state,
        workspace: { ...state.workspace, view: 'preview', previewWidth: action.width },
      }
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
