import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUp, LoaderCircle, Square } from 'lucide-react'
import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { interruptGeneration, prepareEngine } from '@/llm/engine'
import { useAppState, type ChatMessage } from '@/state'

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function Chat() {
  const { state, dispatch } = useAppState()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
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

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault()
    const content = input.trim()
    if (!content || !canSend) return

    const userMessage: ChatMessage = { id: makeId('user'), role: 'user', content }
    const assistantId = makeId('assistant')
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      pending: true,
    }
    const history: ChatCompletionMessageParam[] = [...state.messages, userMessage].map(
      (message) => ({ role: message.role, content: message.content }),
    )

    setInput('')
    dispatch({ type: 'appendMessage', message: userMessage })
    dispatch({ type: 'appendMessage', message: assistantMessage })
    dispatch({ type: 'setGenerating', value: true })

    try {
      const { engine } = await prepareEngine()
      const stream = await engine.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'You are Mote, a concise coding assistant running entirely in the browser. Explain code clearly and keep answers brief.',
          },
          ...history,
        ],
        stream: true,
        temperature: 0.2,
        max_tokens: 1_024,
        extra_body: { enable_thinking: false },
      })

      let reply = ''
      for await (const chunk of stream) {
        reply += chunk.choices[0]?.delta.content ?? ''
        dispatch({ type: 'streamMessage', id: assistantId, content: reply })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dispatch({
        type: 'streamMessage',
        id: assistantId,
        content: `Generation failed: ${message}`,
      })
    } finally {
      dispatch({ type: 'finishMessage', id: assistantId })
      dispatch({ type: 'setGenerating', value: false })
    }
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
              <p>{message.content || (message.pending ? 'Thinking…' : '')}</p>
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
