export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface SandboxConsoleEntry {
  id: string
  level: ConsoleLevel
  args: string[]
  timestamp: number
}

interface SandboxResponse {
  type: 'mote:response'
  id: string
  ok: boolean
  result?: unknown
  error?: string
  console?: SandboxConsoleEntry[]
}

interface PendingRequest {
  resolve(value: SandboxResponse): void
  timer: ReturnType<typeof setTimeout>
}

function sandboxBootstrap() {
  const channel = 'mote:sandbox'
  const history: Array<{
    id: string
    level: ConsoleLevel
    args: string[]
    timestamp: number
  }> = []
  let consoleCursor = 0
  let sequence = 0

  function serialize(value: unknown): string {
    if (typeof value === 'string') return value
    if (value instanceof Error) return `${value.name}: ${value.message}`
    try {
      const json = JSON.stringify(value)
      return json === undefined ? String(value) : json
    } catch {
      return String(value)
    }
  }

  function emit(level: ConsoleLevel, values: unknown[]) {
    const entry = {
      id: `sandbox-${Date.now()}-${sequence++}`,
      level,
      args: values.map(serialize),
      timestamp: Date.now(),
    }
    history.push(entry)
    window.parent.postMessage({ type: 'mote:console', channel, entry }, '*')
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    console[level] = (...values: unknown[]) => {
      original(...values)
      emit(level, values)
    }
  }

  window.addEventListener('error', (event) => {
    emit('error', [event.error ?? `${event.message} at ${event.filename}:${event.lineno}`])
  })

  window.addEventListener('unhandledrejection', (event) => {
    emit('error', [`Unhandled promise rejection: ${serialize(event.reason)}`])
  })

  window.addEventListener('message', async (event) => {
    const request = event.data as
      | { type: 'mote:run'; channel: string; id: string; code: string }
      | { type: 'mote:dom'; channel: string; id: string; maxChars?: number }
    if (event.source !== window.parent || request?.channel !== channel) return

    if (request.type === 'mote:run') {
      try {
        const result = await Promise.resolve(new Function(request.code)())
        const newConsole = history.slice(consoleCursor)
        consoleCursor = history.length
        window.parent.postMessage(
          {
            type: 'mote:response',
            channel,
            id: request.id,
            ok: true,
            result: serialize(result),
            console: newConsole,
          },
          '*',
        )
      } catch (error) {
        const newConsole = history.slice(consoleCursor)
        consoleCursor = history.length
        window.parent.postMessage(
          {
            type: 'mote:response',
            channel,
            id: request.id,
            ok: false,
            error: serialize(error),
            console: newConsole,
          },
          '*',
        )
      }
    }

    if (request.type === 'mote:dom') {
      const maxChars = Math.max(500, Math.min(request.maxChars ?? 12_000, 40_000))
      const html = document.documentElement.outerHTML
      window.parent.postMessage(
        {
          type: 'mote:response',
          channel,
          id: request.id,
          ok: true,
          result: html.length > maxChars ? `${html.slice(0, maxChars)}\n<!-- truncated -->` : html,
        },
        '*',
      )
    }
  })

  window.parent.postMessage({ type: 'mote:ready', channel }, '*')
}

export const SANDBOX_RUNTIME = `(${sandboxBootstrap.toString()})();`

export class SandboxBridge {
  private frameWindow: Window | null = null
  private pending = new Map<string, PendingRequest>()
  private consoleEntries: SandboxConsoleEntry[] = []
  private consoleListeners = new Set<(entries: SandboxConsoleEntry[]) => void>()
  private readyListeners = new Set<(ready: boolean) => void>()
  private ready = false
  private requestSequence = 0

  constructor() {
    window.addEventListener('message', this.onMessage)
  }

  attach(frameWindow: Window | null): void {
    this.frameWindow = frameWindow
    this.ready = false
    this.consoleEntries = []
    this.emitConsole()
    this.emitReady()
  }

  subscribeConsole(listener: (entries: SandboxConsoleEntry[]) => void): () => void {
    this.consoleListeners.add(listener)
    listener(this.consoleEntries)
    return () => this.consoleListeners.delete(listener)
  }

  subscribeReady(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener)
    listener(this.ready)
    return () => this.readyListeners.delete(listener)
  }

  getConsoleEntries(): SandboxConsoleEntry[] {
    return this.consoleEntries
  }

  clearConsole(): void {
    this.consoleEntries = []
    this.emitConsole()
  }

  async run(code: string): Promise<SandboxResponse> {
    return this.request({ type: 'mote:run', code })
  }

  async getDom(maxChars?: number): Promise<SandboxResponse> {
    return this.request({ type: 'mote:dom', maxChars })
  }

  private request(payload: { type: 'mote:run'; code: string } | { type: 'mote:dom'; maxChars?: number }): Promise<SandboxResponse> {
    if (!this.frameWindow || !this.ready) {
      return Promise.reject(new Error('Sandbox is not ready.'))
    }

    const id = `host-${Date.now()}-${this.requestSequence++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Sandbox request timed out.'))
      }, 5_000)
      this.pending.set(id, { resolve, timer })
      this.frameWindow?.postMessage({ ...payload, channel: 'mote:sandbox', id }, '*')
    })
  }

  private onMessage = (event: MessageEvent) => {
    if (event.source !== this.frameWindow || event.data?.channel !== 'mote:sandbox') return

    if (event.data.type === 'mote:ready') {
      this.ready = true
      this.emitReady()
      return
    }

    if (event.data.type === 'mote:console') {
      this.consoleEntries = [...this.consoleEntries, event.data.entry as SandboxConsoleEntry]
      this.emitConsole()
      return
    }

    if (event.data.type === 'mote:response') {
      const response = event.data as SandboxResponse
      const pending = this.pending.get(response.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(response.id)
      pending.resolve(response)
    }
  }

  private emitConsole(): void {
    for (const listener of this.consoleListeners) listener(this.consoleEntries)
  }

  private emitReady(): void {
    for (const listener of this.readyListeners) listener(this.ready)
  }
}

export const sandboxBridge = new SandboxBridge()
