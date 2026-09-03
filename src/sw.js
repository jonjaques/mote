/* eslint-env serviceworker */
// sw.js — Mote's offline shell.
//
// Not bundled and not served in dev: `serviceWorker()` in vite.config.ts reads this file,
// substitutes the build id and the emitted asset names, and writes it to dist/sw.js. That is
// why the two placeholders below look like values — they are, until the build replaces them.
//
// The rules here exist because a service worker sits in front of *every* fetch a controlled
// page makes, including the ones the WebLLM worker makes for multi-gigabyte weight shards:
//
//   - Cross-origin is never handled. huggingface.co, raw.githubusercontent.com and the
//     analytics tag go straight to the network. WebLLM keeps weights in its own Cache API
//     buckets (webllm/model|config|wasm); duplicating a 4 GB download into a second cache
//     would blow the origin's storage quota and evict the copy that matters.
//   - /models/ is never handled. That is the dev-only local mirror, and a cached HTML
//     fallback under a model URL is the failure mode AGENTS.md warns about: a 200 index.html
//     stored as mlc-chat-config.json makes every later load throw "Unexpected token '<'".
//   - Range requests are never handled. Answering one from a full cached body breaks the
//     206 contract the requester asked for.
//
// Not handling a request means not calling event.respondWith, which leaves the browser's own
// networking untouched. That is the default for everything not listed above.

const BUILD = "__BUILD_ID__";
const PRECACHE = ["__PRECACHE__"];

const SHELL_CACHE = `mote-shell-${BUILD}`;
const RUNTIME_CACHE = `mote-runtime-${BUILD}`;
const SHELL_DOCUMENT = "/index.html";

/** Hashed by the bundler: the name changes when the bytes do, so it can be cached forever. */
const IMMUTABLE = /^\/assets\//;
/** Stable names whose bytes can change between deploys, so they revalidate in the background. */
const REVALIDATE = /\.(?:svg|png|ico|webmanifest|woff2?|txt)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)),
    // Deliberately no skipWaiting: the running tab holds lazy chunks from the build it loaded,
    // and swapping the shell underneath it can 404 a chunk mid-session. The page asks for the
    // swap when the visitor accepts it (see the "skip-waiting" message below).
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("mote-") && name !== SHELL_CACHE && name !== RUNTIME_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") void self.skipWaiting();
});

// Network first, because a deploy should be visible on the next load rather than after two.
// The cached shell is the offline answer — and offline is a real state for Mote, whose weights
// already live in the browser once they have been fetched.
async function shellFirstFromNetwork(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(SHELL_DOCUMENT, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(SHELL_DOCUMENT, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(RUNTIME_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    })
    // A failed revalidation is only interesting when there is nothing cached to serve.
    .catch((error) => {
      if (cached) return cached;
      throw error;
    });

  return cached ?? network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/models/")) return;

  if (request.mode === "navigate") {
    event.respondWith(shellFirstFromNetwork(request));
    return;
  }

  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (REVALIDATE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
