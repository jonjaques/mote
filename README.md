# Mote

A complete AI development environment inside your browser.

A local WebLLM model running on WebGPU writes HTML, CSS and JavaScript, runs it, and renders
it in a sandboxed iframe — all inside one tab. There is no backend, no API key and no prompt
leaving the page. Weights are fetched from Hugging Face once and kept in the browser's Cache
API afterwards.

Deployed at **https://mote.jonjaques.com**.

## Running it locally

```bash
pnpm install
pnpm dev --port 5180 --strictPort     # http://localhost:5180
```

`pnpm build` runs `tsc -b && vite build`; `pnpm test` runs the vitest suite; `pnpm lint` runs
oxlint. The full working agreement for this repo is in `AGENTS.md`, the specification in
`PLAN.md`, and what is actually true on disk in `HANDOFF.md`.

Development can serve models from a local mirror instead of Hugging Face:

```bash
pnpm models list --filter qwen --max-vram 6000
pnpm models download Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC
```

The mirror lands in `./models/` (gitignored, multi-gigabyte) and is served by dev-only Vite
middleware. **A production build never reads it** — deploys download from Hugging Face only.

## Deploying (Cloudflare Workers)

Static assets only — there is no Worker entry point, and there is not going to be. Workers
Builds runs the build and then wrangler, which reads `wrangler.jsonc`.

| Setting | Value |
|---|---|
| Build command | `pnpm build` |
| Deploy command | `npx wrangler versions upload` (`deploy` on the production branch) |
| Assets directory | `./dist`, from `wrangler.jsonc` |
| Worker name | `mote`, from `wrangler.jsonc` — must match the connected Worker |
| Node / pnpm | pinned by `.node-version` and `packageManager` |
| Environment variable | `GA_MEASUREMENT_ID` — optional, `G-XXXXXXXXXX` |

Nothing else is required. `public/_headers` is copied into `dist/`, where Workers parses it
for the security and caching headers; the service worker is emitted into `dist/sw.js` by the
build. `assets.not_found_handling` is deliberately left at `"none"` so a missing path 404s
instead of being answered with the app shell — `wrangler.jsonc` says why that matters here.

**Analytics are opt-in at build time.** Without `GA_MEASUREMENT_ID` the build injects no tag
and the deploy makes no request to any third party. With it, the tag reports page views and
three events — a model load, a load failure and a preflight failure. Prompts, model output and
file contents are never sent anywhere; see the note at the top of `src/analytics.ts`.

## Brand assets

`assets/` holds the sources: `mark.svg` (the icon), `icon-maskable.svg` and `og.html` (the
1200×630 link preview). `pnpm assets` renders them into `public/` with headless Chrome. The
outputs are committed, so a deploy never needs a browser — regenerate and commit them together
whenever a source changes.

## Requirements

WebGPU, and a GPU with roughly 5 GB free for the model that builds pages well. Mote checks
before offering anything: it reads the adapter, estimates a memory budget, and files every
model in the catalogue under what this particular machine can hold. A browser without WebGPU
gets an explanation instead of a degraded demo.
