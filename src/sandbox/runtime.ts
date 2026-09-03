export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface SandboxConsoleEntry {
  id: string
  level: ConsoleLevel
  args: string[]
  timestamp: number
}

export interface SandboxResponse {
  type: 'mote:response'
  id: string
  ok: boolean
  result?: unknown
  error?: string
  console?: SandboxConsoleEntry[]
  consoleDropped?: number
}

// The host keeps this many console lines. A model-written loop can emit tens of thousands;
// past a couple of thousand the list stops being readable and only costs render time.
const MAX_CONSOLE_ENTRIES = 2_000

interface PendingRequest {
  resolve(value: SandboxResponse): void
  timer: ReturnType<typeof setTimeout>
}

function sandboxBootstrap() {
  const channel = 'mote:sandbox'
  // What a single run_js may report back. This buffer used to be an ever-growing `history`
  // that existed only to compute a delta, so a loop with a console.log in it grew the
  // sandbox heap forever and then pushed every line into the model's 8k context as a tool
  // result. Draining on each request bounds both.
  const MAX_PENDING_CONSOLE = 200
  let pending: Array<{
    id: string
    level: ConsoleLevel
    args: string[]
    timestamp: number
  }> = []
  let pendingDropped = 0
  let sequence = 0

  function drainPending() {
    const entries = pending
    const dropped = pendingDropped
    pending = []
    pendingDropped = 0
    return { entries, dropped }
  }

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
    if (pending.length < MAX_PENDING_CONSOLE) pending.push(entry)
    else pendingDropped += 1
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

  // The frame has no allow-modals, so alert/confirm/prompt would silently do nothing and a
  // page that "alerts hi" looks broken. Show the text in-page and log it instead; keeping
  // dialogs out also keeps the host tab and any automation from blocking on one.
  function toast(text: string) {
    let stack = document.getElementById('mote-toasts')
    if (!stack) {
      stack = document.createElement('div')
      stack.id = 'mote-toasts'
      stack.setAttribute('role', 'status')
      stack.style.cssText =
        'position:fixed;left:50%;bottom:1rem;z-index:2147483647;display:grid;gap:.4rem;max-width:min(32rem,90vw);transform:translateX(-50%);font:13px/1.4 system-ui,sans-serif;pointer-events:none'
      ;(document.body ?? document.documentElement).appendChild(stack)
    }
    const item = document.createElement('div')
    item.textContent = text
    item.style.cssText =
      'padding:.55rem .8rem;color:#e6f1f2;background:rgba(17,23,25,.94);border:1px solid rgba(99,230,209,.5);box-shadow:0 .5rem 1.5rem rgba(0,0,0,.35);white-space:pre-wrap;word-break:break-word'
    stack.appendChild(item)
    setTimeout(() => item.remove(), 4_000)
  }

  window.alert = (message?: unknown) => {
    const text = message === undefined ? '' : String(message)
    emit('info', [`alert: ${text}`])
    toast(text || '(empty alert)')
  }
  window.confirm = (message?: string) => {
    emit('info', [`confirm: ${message ?? ''} → true`])
    toast(`confirm: ${message ?? ''} (answered yes)`)
    return true
  }
  window.prompt = (message?: string) => {
    emit('info', [`prompt: ${message ?? ''} → null`])
    toast(`prompt: ${message ?? ''} (no answer in the sandbox)`)
    return null
  }

  // Without allow-forms a submit is blocked with a browser-level warning the page never sees.
  // Let the page's own handlers run first; only an unhandled submit is turned into feedback.
  document.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return
    event.preventDefault()
    const form = event.target as HTMLFormElement | null
    const fields: string[] = []
    if (form) {
      for (const [key, value] of new FormData(form)) {
        fields.push(`${key}=${typeof value === 'string' ? value : value.name}`)
      }
    }
    emit('info', [`form submitted (sandbox has no server): ${fields.join('&') || 'no fields'}`])
    toast('Form submitted. The sandbox has no server, so nothing was sent.')
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
        const drained = drainPending()
        window.parent.postMessage(
          {
            type: 'mote:response',
            channel,
            id: request.id,
            ok: true,
            result: serialize(result),
            console: drained.entries,
            consoleDropped: drained.dropped,
          },
          '*',
        )
      } catch (error) {
        const drained = drainPending()
        window.parent.postMessage(
          {
            type: 'mote:response',
            channel,
            id: request.id,
            ok: false,
            error: serialize(error),
            console: drained.entries,
            consoleDropped: drained.dropped,
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
  // Mutable ring; subscribers get `consoleSnapshot`, rebuilt once per frame. Copying the
  // array on every incoming line meant one React render per console.log.
  private consoleEntries: SandboxConsoleEntry[] = []
  private consoleSnapshot: SandboxConsoleEntry[] = []
  private consoleDropped = 0
  private consoleFlush: number | null = null
  private consoleListeners = new Set<(entries: SandboxConsoleEntry[]) => void>()
  private readyListeners = new Set<(ready: boolean) => void>()
  private ready = false
  private requestSequence = 0
  private documentRevision = 0

  constructor() {
    window.addEventListener('message', this.onMessage)
  }

  attach(frameWindow: Window | null): void {
    this.frameWindow = frameWindow
    this.documentRevision += 1
    this.ready = false
    this.resetConsole()
    this.emitConsole()
    this.emitReady()
  }

  subscribeConsole(listener: (entries: SandboxConsoleEntry[]) => void): () => void {
    this.consoleListeners.add(listener)
    listener(this.consoleSnapshot)
    return () => this.consoleListeners.delete(listener)
  }

  subscribeReady(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener)
    listener(this.ready)
    return () => this.readyListeners.delete(listener)
  }

  getConsoleEntries(): SandboxConsoleEntry[] {
    return this.consoleSnapshot
  }

  clearConsole(): void {
    this.resetConsole()
    this.emitConsole()
  }

  private resetConsole(): void {
    if (this.consoleFlush !== null) {
      cancelAnimationFrame(this.consoleFlush)
      this.consoleFlush = null
    }
    this.consoleEntries = []
    this.consoleSnapshot = []
    this.consoleDropped = 0
  }

  // One flush per frame, however many lines arrive in between. rAF also parks the work while
  // the tab is hidden, which is the right answer for output nobody is looking at.
  private scheduleConsoleFlush(): void {
    if (this.consoleFlush !== null) return
    this.consoleFlush = requestAnimationFrame(() => {
      this.consoleFlush = null
      this.emitConsole()
    })
  }

  async run(code: string): Promise<SandboxResponse> {
    return this.request({ type: 'mote:run', code })
  }

  async getDom(maxChars?: number): Promise<SandboxResponse> {
    return this.request({ type: 'mote:dom', maxChars })
  }

  getDocumentRevision(): number {
    return this.documentRevision
  }

  waitForReloadAfter(revision: number, timeoutMs = 2_000): Promise<void> {
    if (this.documentRevision > revision && this.ready) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error('Sandbox did not become ready after the file update.'))
      }, timeoutMs)
      const unsubscribe = this.subscribeReady((ready) => {
        if (!ready || this.documentRevision <= revision) return
        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
    })
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
      this.consoleEntries.push(event.data.entry as SandboxConsoleEntry)
      const overflow = this.consoleEntries.length - MAX_CONSOLE_ENTRIES
      if (overflow > 0) {
        this.consoleEntries.splice(0, overflow)
        this.consoleDropped += overflow
      }
      this.scheduleConsoleFlush()
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
    // The dropped notice rides in the list itself rather than in a separate channel, so it
    // shows up where someone is already looking and reaches the tool results unchanged.
    this.consoleSnapshot =
      this.consoleDropped === 0
        ? [...this.consoleEntries]
        : [
            {
              id: 'mote:console-dropped',
              level: 'warn',
              args: [
                `${this.consoleDropped.toLocaleString()} earlier lines dropped — the console keeps the last ${MAX_CONSOLE_ENTRIES.toLocaleString()}.`,
              ],
              timestamp: this.consoleEntries[0]?.timestamp ?? Date.now(),
            },
            ...this.consoleEntries,
          ]
    for (const listener of this.consoleListeners) listener(this.consoleSnapshot)
  }

  private emitReady(): void {
    for (const listener of this.readyListeners) listener(this.ready)
  }
}

export const sandboxBridge = new SandboxBridge()
