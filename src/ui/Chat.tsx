import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowRight, ArrowUp, ChevronRight, Eraser, LoaderCircle, Square, Sparkle } from 'lucide-react'
import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'

import { registerAutomationHooks, type AutomationRun } from '@/automation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { runAgent, type AgentProgress, type AgentStats, type AgentToolActivity } from '@/llm/agent'
import { interruptGeneration } from '@/llm/engine'
import { starterScenarios } from '@/llm/prompts'
import { liveStream } from '@/llm/stream'
import { projectFS } from '@/sandbox/fs'
import { useAppState, type ChatMessage } from '@/state'
import { ToolCallCard } from './ToolCallCard'

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function useElapsedSeconds(startedAt: number | undefined): number {
  // Ticks once a second; the first paint shows 0s rather than reading the clock in render.
  const [now, setNow] = useState(() => startedAt ?? 0)
  useEffect(() => {
    if (startedAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1_000))
}

const STREAM_TAIL = 1_600

// The model's raw output as it streams: its prose and the tool-call payload it is writing.
// Only this box repaints per token; it subscribes to the buffer directly, not to the store.
function StreamBox() {
  const text = useSyncExternalStore(liveStream.subscribe, liveStream.getSnapshot, liveStream.getSnapshot)
  const boxRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const box = boxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [text])
  if (!text) return null
  const tail = text.length > STREAM_TAIL ? `…${text.slice(-STREAM_TAIL)}` : text
  return (
    // Hidden from assistive tech on purpose: this repaints per token, and inside any live
    // region it becomes an unstoppable announcement of half-written JSON. The throttled
    // status line above it is what gets announced; this box is for watching, not reading.
    <pre ref={boxRef} className="stream-box" aria-hidden="true">
      {tail}
    </pre>
  )
}

const TOOL_VERBS: Record<string, string> = {
  write_file: 'Writing',
  read_file: 'Reading',
  list_files: 'Listing files',
  run_js: 'Running JavaScript',
  get_dom: 'Inspecting the DOM',
}

function describeProgress(progress: AgentProgress): string {
  if (progress.phase === 'prefill') return progress.round === 0 ? 'Reading the request' : 'Reading tool results'
  if (progress.phase === 'text') return 'Writing a reply'
  const verb = progress.tool ? (TOOL_VERBS[progress.tool] ?? progress.tool) : 'Preparing a tool call'
  const target = progress.path ? ` ${progress.path}` : ''
  const size = progress.chars >= 1_024 ? ` · ${(progress.chars / 1_024).toFixed(1)} KB` : ''
  return `${verb}${target}${size}`
}

function GenerationStatus({ progress }: { progress?: AgentProgress }) {
  const seconds = useElapsedSeconds(progress?.startedAt)
  return (
    <p className="generation-status" role="status">
      <LoaderCircle className="animate-spin" aria-hidden="true" />
      <span>{progress ? describeProgress(progress) : 'Starting'}</span>
      <span className="generation-meta">
        {progress && progress.round > 0 ? `round ${progress.round + 1} · ` : ''}
        {seconds}s
      </span>
    </p>
  )
}

function StatsLine({ stats, stopped, cutOff }: { stats: AgentStats; stopped?: boolean; cutOff?: boolean }) {
  const parts = [
    `${stats.seconds < 10 ? stats.seconds.toFixed(1) : Math.round(stats.seconds)}s`,
    stats.completionTokens ? `${stats.completionTokens.toLocaleString()} tokens` : null,
    stats.tokensPerSecond ? `${Math.round(stats.tokensPerSecond)} tok/s` : null,
    stats.rounds > 1 ? `${stats.rounds} rounds` : null,
    stopped ? 'stopped' : null,
    cutOff ? 'cut off' : null,
  ].filter(Boolean)
  return <p className="message-stats">{parts.join(' · ')}</p>
}

// One sentence a screen reader hears when a turn ends, in place of the streaming transcript.
function describeResult(result: AutomationRun): string {
  const tools = result.tools.length
  const parts = [
    result.error
      ? 'Generation failed'
      : result.stopped
        ? 'Stopped'
        : result.cutOff
          ? 'Reply cut off'
          : 'Reply finished',
    tools ? `${tools} ${tools === 1 ? 'tool call' : 'tool calls'}` : null,
    `${result.seconds.toFixed(1)} seconds`,
    result.cutOff ? 'Continue available' : null,
  ].filter(Boolean)
  return parts.join(' · ')
}

export function Chat() {
  const { state, dispatch } = useAppState()
  const [input, setInput] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  const ready = state.model.phase === 'ready'
  const canSend = input.trim().length > 0 && ready && !state.generating

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: state.generating ? 'smooth' : 'auto',
    })
  }, [state.messages, state.progress, state.generating])

  // The composer is the next thing to use once the runtime is ready; save the click.
  useEffect(() => {
    if (ready && !state.generating) textareaRef.current?.focus()
  }, [ready, state.generating])

  // Esc has to work from anywhere in the document while a turn runs. It used to hang off the
  // composer's own onKeyDown, and the composer was `disabled` for exactly that period — a
  // disabled control receives no key events, so the shortcut the empty state advertises has
  // never actually fired. The composer is read-only now, which also keeps focus where it was.
  useEffect(() => {
    if (!state.generating) return
    const controller = new AbortController()
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        interruptGeneration()
      },
      { signal: controller.signal },
    )
    return () => controller.abort()
  }, [state.generating])

  async function runInput(content: string): Promise<AutomationRun> {
    if (!content) throw new Error('Nothing to send.')
    if (state.model.phase !== 'ready') throw new Error('No model is loaded.')
    if (state.generating) throw new Error('A response is already generating.')

    const userMessage: ChatMessage = { id: makeId('user'), role: 'user', content }
    const assistantId = makeId('assistant')
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      pending: true,
    }
    const history: ChatCompletionMessageParam[] = state.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))
    const tools = new Map<string, AgentToolActivity>()
    const startedAt = performance.now()

    setInput('')
    dispatch({ type: 'appendMessage', message: userMessage })
    dispatch({ type: 'appendMessage', message: assistantMessage })
    dispatch({ type: 'setGenerating', value: true })
    dispatch({ type: 'generationProgress', progress: { phase: 'prefill', chars: 0, round: 0, startedAt: Date.now() } })

    try {
      const result = await runAgent(content, history, {
        onText: (reply) => {
          dispatch({ type: 'streamMessage', id: assistantId, content: reply })
        },
        onProgress: (progress) => {
          dispatch({ type: 'generationProgress', progress })
        },
        onTool: (activity) => {
          tools.set(activity.id, activity)
          const content = activity.call.arguments.content
          dispatch({
            type: 'toolActivity',
            messageId: assistantId,
            activity: {
              ...activity,
              call: {
                ...activity.call,
                arguments: {
                  ...activity.call.arguments,
                  ...(typeof content === 'string'
                    ? { content: `[${content.length} characters]` }
                    : {}),
                },
              },
            },
          })
        },
      })
      if (!result.content) {
        dispatch({
          type: 'streamMessage',
          id: assistantId,
          content: tools.size ? 'Done.' : 'The model returned nothing usable. Try rephrasing, or switch to a larger model.',
        })
      }
      dispatch({
        type: 'finishMessage',
        id: assistantId,
        cutOff: result.cutOff,
        stopped: result.stopped,
        stats: result.stats,
      })
      const run: AutomationRun = {
        ...result,
        seconds: (performance.now() - startedAt) / 1_000,
        tools: [...tools.values()],
      }
      setAnnouncement(describeResult(run))
      return run
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dispatch({
        type: 'streamMessage',
        id: assistantId,
        content: `Generation failed: ${message}`,
      })
      dispatch({ type: 'finishMessage', id: assistantId })
      const run: AutomationRun = {
        content: '',
        cutOff: false,
        stopped: false,
        rounds: 0,
        seconds: (performance.now() - startedAt) / 1_000,
        tools: [...tools.values()],
        error: message,
      }
      setAnnouncement(describeResult(run))
      return run
    } finally {
      dispatch({ type: 'setGenerating', value: false })
    }
  }

  // runInput closes over the latest state, so automation reaches it through a ref that the
  // effect below refreshes after every render instead of re-registering hooks each time.
  const runInputRef = useRef(runInput)
  useEffect(() => {
    runInputRef.current = runInput
  })
  useEffect(
    () =>
      registerAutomationHooks({
        send: (text) => runInputRef.current(text.trim()),
        getMessages: () => stateRef.current.messages,
        clearChat: () => dispatch({ type: 'resetChat' }),
      }),
    [dispatch],
  )

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault()
    const content = input.trim()
    if (!content || !canSend) return
    await runInput(content)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
    // Escape is handled on window while generating, so it works wherever focus is.
  }

  // Fills the composer instead of sending it. The visitor should see the exact text they are
  // about to run before a model starts spending their GPU on it.
  function fillComposer(prompt: string) {
    setInput(prompt)
    textareaRef.current?.focus()
  }

  function clearContext() {
    dispatch({ type: 'resetChat' })
    textareaRef.current?.focus()
  }

  // A new session is the chat and the project together; the loaded model stays.
  function newSession() {
    dispatch({ type: 'resetChat' })
    projectFS.reset()
    dispatch({ type: 'openFile', path: 'index.html' })
    dispatch({ type: 'setView', view: 'preview' })
    textareaRef.current?.focus()
  }

  const hasMessages = state.messages.length > 0

  return (
    <section className="chat-panel" aria-labelledby="chat-heading">
      <div className="section-heading chat-heading">
        <div>
          <h2 id="chat-heading">Session</h2>
          <p>
            {hasMessages
              ? `${state.messages.length} ${state.messages.length === 1 ? 'message' : 'messages'}`
              : 'No context yet'}
          </p>
        </div>
        <div className="session-actions">
          <Button
            variant="ghost"
            size="xs"
            onClick={clearContext}
            disabled={!hasMessages || state.generating}
            title="Forget the conversation; keep the project"
          >
            <Eraser />
            Clear context
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={newSession}
            disabled={state.generating}
            title="Forget the conversation and reset the project to the starter files"
          >
            <Sparkle />
            New session
          </Button>
        </div>
      </div>

      {/* Not a live region. Marking the whole transcript `aria-live` meant every streamed
          chunk re-announced the growing conversation; the throttled status line inside the
          pending message and the one-shot summary below are the announcements. */}
      <div ref={scrollRef} className="message-list">
        {state.messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-lead">
              <span className="mote-mark" aria-hidden="true" />
              <p>{ready ? 'Describe a page or a change to the project.' : 'A private model, waiting inside this tab.'}</p>
              <small>{ready ? 'Enter sends · Shift+Enter for a new line · Esc stops' : 'Load a runtime to begin.'}</small>
            </div>
            <nav className="starters" aria-labelledby="starters-heading">
              <h3 id="starters-heading">Start from</h3>
              {starterScenarios.map((scenario) => (
                <button
                  key={scenario.prompt}
                  type="button"
                  disabled={!ready || state.generating}
                  onClick={() => fillComposer(scenario.prompt)}
                >
                  <ChevronRight aria-hidden="true" />
                  <span>{scenario.prompt}</span>
                  <small>{scenario.kind}</small>
                </button>
              ))}
            </nav>
          </div>
        ) : (
          state.messages.map((message) => (
            <article key={message.id} className={`message message-${message.role}`}>
              <span>{message.role === 'user' ? 'You' : 'Mote'}</span>
              {message.tools?.map((activity) => (
                <ToolCallCard key={activity.id} activity={activity} />
              ))}
              {message.content && <p>{message.content}</p>}
              {message.pending && (
                <>
                  <GenerationStatus progress={state.progress} />
                  <StreamBox />
                </>
              )}
              {!message.pending && message.stats && (
                <StatsLine stats={message.stats} stopped={message.stopped} cutOff={message.cutOff} />
              )}
              {!message.pending && message.stopped && !message.stats && (
                <p className="message-stats">stopped</p>
              )}
              {message.cutOff && !state.generating && (
                <Button
                  variant="outline"
                  size="sm"
                  className="continue-button"
                  onClick={() =>
                    void runInput('Continue from the cut-off response and finish the requested work.')
                  }
                >
                  Continue
                  <ArrowRight />
                </Button>
              )}
            </article>
          ))
        )}
      </div>

      <p className="sr-only" role="status">
        {announcement}
      </p>

      <form className="composer" onSubmit={sendMessage}>
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            ready
              ? state.generating
                ? 'Generating… press Esc to stop'
                : 'Ask Mote to build or change something…'
              : 'Load a model to start…'
          }
          // Read-only rather than disabled while generating: a disabled field drops focus to
          // <body> mid-turn and answers no keys, which is what made Esc unreachable.
          disabled={!ready}
          readOnly={state.generating}
          rows={3}
          aria-label="Message"
        />
        {state.generating ? (
          <Button type="button" size="icon" variant="outline" onClick={() => interruptGeneration()} aria-label="Stop" title="Stop (Esc)">
            <Square />
          </Button>
        ) : (
          <Button type="submit" size="icon" disabled={!canSend} aria-label="Send message" title="Send (Enter)">
            <ArrowUp />
          </Button>
        )}
      </form>
    </section>
  )
}
