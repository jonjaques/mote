// Analytics — the thin side of a Google Analytics tag.
//
// The tag itself is injected into index.html at build time by `analytics()` in vite.config.ts,
// and only when GA_MEASUREMENT_ID is set in the build environment (Cloudflare Workers Builds).
// A dev build, a preview build and any deploy without that variable ship no tag at all, which
// is why every call here goes through an optional `window.gtag` and does nothing when absent.
//
// What may be sent: which model was loaded, whether its weights came from the cache, how long
// a load or a turn took, and how a turn ended. What must never be sent: prompt text, model
// output, file contents, file names the model chose, or anything else the visitor typed or
// generated. That is not a policy about analytics — it is the product's one claim, and an
// event parameter is exactly the sort of place it would quietly stop being true.

type EventParams = Record<string, string | number | boolean>

declare global {
  interface Window {
    gtag?: (command: string, ...args: unknown[]) => void
  }
}

export function track(event: string, params?: EventParams): void {
  window.gtag?.('event', event, params)
}
