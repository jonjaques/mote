// The raw text of the round currently streaming from the model, outside React state.
// Every token would otherwise go through the reducer and re-render the whole chat; the
// live box subscribes here directly and is the only thing that repaints per token.

type Listener = () => void

let current = ''
let scheduled = false
const listeners = new Set<Listener>()

function notify() {
  scheduled = false
  for (const listener of listeners) listener()
}

export const liveStream = {
  set(text: string): void {
    current = text
    // One repaint per frame at most; a 150 tok/s decode does not need more.
    if (scheduled) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(notify)
    else queueMicrotask(notify)
  },
  clear(): void {
    if (current === '') return
    current = ''
    notify()
  },
  getSnapshot: (): string => current,
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
