import type { AgentStats, AgentToolActivity } from '@/llm/agent'
import { interruptGeneration } from '@/llm/engine'
import { projectFS } from '@/sandbox/fs'
import { sandboxBridge, type SandboxConsoleEntry, type SandboxResponse } from '@/sandbox/runtime'
import type { ChatMessage } from '@/state'

// `pnpm cdp:trace` and `pnpm cdp:agent` drive Mote over the DevTools protocol through this
// object. It is the only host-side surface automation may touch: the sandbox iframe has an
// opaque origin, so the harness cannot evaluate inside it directly and goes through the bridge.

export interface AutomationStatus {
  phase: string
  model?: string
  progress?: number
  error?: string
  generating?: boolean
}

export interface AutomationRun {
  content: string
  cutOff: boolean
  stopped: boolean
  rounds: number
  seconds: number
  tools: AgentToolActivity[]
  stats?: AgentStats
  error?: string
}

export interface AutomationHooks {
  send(text: string): Promise<AutomationRun>
  getMessages(): ChatMessage[]
  clearChat(): void
}

export interface AutomationApi extends AutomationStatus {
  send(text: string): Promise<AutomationRun>
  stop(): void
  getMessages(): ChatMessage[]
  clearChat(): void
  getProject(): Record<string, string>
  resetProject(): Promise<void>
  seedProject(): Promise<void>
  runInSandbox(code: string): Promise<SandboxResponse>
  getConsole(): SandboxConsoleEntry[]
}

declare global {
  interface Window {
    __llmcoder: AutomationApi
  }
}

const hooks: Partial<AutomationHooks> = {}

async function replaceProject(apply: () => void): Promise<void> {
  const revision = sandboxBridge.getDocumentRevision()
  apply()
  await sandboxBridge.waitForReloadAfter(revision)
}

const api: AutomationApi = {
  phase: 'initializing',
  send(text) {
    if (!hooks.send) return Promise.reject(new Error('Chat is not mounted.'))
    return hooks.send(text)
  },
  stop() {
    interruptGeneration()
  },
  getMessages() {
    return hooks.getMessages?.() ?? []
  },
  clearChat() {
    hooks.clearChat?.()
  },
  getProject() {
    return Object.fromEntries(projectFS.list().map((file) => [file.path, file.content]))
  },
  resetProject() {
    return replaceProject(() => projectFS.reset())
  },
  seedProject() {
    return replaceProject(() => projectFS.seed())
  },
  runInSandbox(code) {
    return sandboxBridge.run(code)
  },
  getConsole() {
    return sandboxBridge.getConsoleEntries()
  },
}

window.__llmcoder = api

// Status transitions replace every field so a stale `error` or `progress` never outlives the
// state that produced it; the methods above live on the same object and are left alone.
export function setAutomationStatus(status: AutomationStatus): void {
  api.phase = status.phase
  api.model = status.model
  api.progress = status.progress
  api.error = status.error
  api.generating = status.generating ?? api.generating
}

export function setAutomationGenerating(generating: boolean): void {
  api.generating = generating
}

export function registerAutomationHooks(next: AutomationHooks): () => void {
  Object.assign(hooks, next)
  return () => {
    for (const key of Object.keys(next) as Array<keyof AutomationHooks>) {
      if (hooks[key] === next[key]) delete hooks[key]
    }
  }
}
