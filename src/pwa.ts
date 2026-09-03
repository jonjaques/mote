// Service worker registration and the "a new build is waiting" signal.
//
// Kept out of the React store on purpose: this is a fact about the page, not about the
// session, and the reducer would have to carry an action that nothing else ever dispatches.
// The brand header subscribes to it the way the stream box subscribes to `liveStream`.

type Listener = () => void

const listeners = new Set<Listener>()
let waitingWorker: ServiceWorker | undefined
let updateReady = false
let reloadRequested = false

function markWaiting(worker: ServiceWorker): void {
  waitingWorker = worker
  updateReady = true
  for (const listener of listeners) listener()
}

export const serviceWorkerUpdate = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot(): boolean {
    return updateReady
  },
}

/** Hands the waiting worker the tab; the reload happens when it reports control. */
export function applyServiceWorkerUpdate(): void {
  if (!waitingWorker) {
    window.location.reload()
    return
  }
  reloadRequested = true
  waitingWorker.postMessage({ type: 'skip-waiting' })
}

export function registerServiceWorker(): void {
  // Dev has no sw.js — it is written by the build — and a worker registered against the dev
  // server would outlive the session and start answering with a cached shell.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install claims the page as well; only a reload the visitor asked for is safe,
    // and only once — Chrome fires this again for the worker that replaces it.
    if (!reloadRequested) return
    reloadRequested = false
    window.location.reload()
  })

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        if (registration.waiting) markWaiting(registration.waiting)

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            // `controller` is null on a first install: that is not an update, it is the tab
            // gaining offline support for the build it is already running.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              markWaiting(installing)
            }
          })
        })
      })
      .catch(() => {
        // An unavailable worker costs the visitor offline support, never the app.
      })
  })
}
