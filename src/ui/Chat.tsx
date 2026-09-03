import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowRight, ArrowUp, LoaderCircle, Square } from 'lucide-react'
import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'

import { registerAutomationHooks, type AutomationRun } from '@/automation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { runAgent, type AgentToolActivity } from '@/llm/agent'
import { interruptGeneration } from '@/llm/engine'
import { useAppState, type ChatMessage } from '@/state'
import { ToolCallCard } from './ToolCallCard'

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function Chat() {
  const { state, dispatch } = useAppState()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  const canSend =
    input.trim().length > 0 &&
    state.model.phase === 'ready' &&
    !state.generating

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: state.generating ? 'smooth' : 'auto',
    })
  }, [state.messages, state.generating])

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

    try {
      const result = await runAgent(content, history, {
        onText: (reply) => {
          dispatch({ type: 'streamMessage', id: assistantId, content: reply })
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
          content: 'The requested tool work completed.',
        })
      }
      dispatch({ type: 'finishMessage', id: assistantId, cutOff: result.cutOff })
      return {
        ...result,
        seconds: (performance.now() - startedAt) / 1_000,
        tools: [...tools.values()],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dispatch({
        type: 'streamMessage',
        id: assistantId,
        content: `Generation failed: ${message}`,
      })
      dispatch({ type: 'finishMessage', id: assistantId })
      return {
        content: '',
        cutOff: false,
        rounds: 0,
        seconds: (performance.now() - startedAt) / 1_000,
        tools: [...tools.values()],
        error: message,
      }
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
  }

  function stopGeneration() {
    interruptGeneration()
  }

  return (
    <section className="chat-panel" aria-labelledby="chat-heading">
      <div className="section-heading chat-heading">
        <div>
          <h2 id="chat-heading">Session</h2>
          <p>{state.messages.length ? `${state.messages.length} messages` : 'No context yet'}</p>
        </div>
        {state.generating && <LoaderCircle className="spin-icon" aria-label="Generating" />}
      </div>

      <div ref={scrollRef} className="message-list" aria-live="polite">
        {state.messages.length === 0 ? (
          <div className="chat-empty">
            <span className="mote-mark" aria-hidden="true" />
            <p>A private model, waiting inside this tab.</p>
            <small>Load a runtime to begin.</small>
          </div>
        ) : (
          state.messages.map((message) => (
            <article key={message.id} className={`message message-${message.role}`}>
              <span>{message.role === 'user' ? 'You' : 'Mote'}</span>
              {message.tools?.map((activity) => (
                <ToolCallCard key={activity.id} activity={activity} />
              ))}
              <p>{message.content || (message.pending ? 'Thinking…' : '')}</p>
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

      <form className="composer" onSubmit={sendMessage}>
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            state.model.phase === 'ready'
              ? 'Ask Mote to build or change something…'
              : 'Load a model to start…'
          }
          disabled={state.model.phase !== 'ready' || state.generating}
          rows={3}
          aria-label="Message"
        />
        {state.generating ? (
          <Button type="button" size="icon" variant="outline" onClick={stopGeneration} aria-label="Stop">
            <Square />
          </Button>
        ) : (
          <Button type="submit" size="icon" disabled={!canSend} aria-label="Send message">
            <ArrowUp />
          </Button>
        )}
      </form>
    </section>
  )
}
