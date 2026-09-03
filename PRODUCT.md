# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary visitor is **someone being shown Mote** — in a talk, a post, or a hiring
conversation — who has 60 seconds and a skeptical prior that "AI coding agent in a
browser tab" means a wrapper around somebody's API. They arrive on a public URL with
no account and no context, on hardware Mote cannot inspect ahead of time.

The secondary user is the person doing the showing (Jon), who needs the interface to
make the interesting part legible without narration.

Confirmed: this is a **portfolio / demo artifact**, not a research harness for its own
sake and not a tool for non-specialists building pages. Where the two conflict, being
convincing to a watching engineer wins over onboarding a stranger unattended.

## Product Purpose

Mote is a complete coding agent that runs entirely inside one browser tab: a local
WebLLM model on WebGPU edits an HTML/CSS/JS project that renders live in a sandboxed
iframe. No server, no API keys, weights cached in the browser after the first load.

Success is a visitor understanding, from watching it work, that the inference is
genuinely happening on their own machine — and believing it.

## Positioning

**Mote — a complete AI development environment inside your browser.**

The claim a neighboring product cannot truthfully copy is the *absence*: no backend, no
key, no request leaving the tab. Everything a hosted agent product does over the network
— model, filesystem, runtime, rendered app — is inside the page. A mote is something
tiny, discrete and self-contained; the name is the argument.

The emotional core: **a surprisingly powerful machine, reduced to a mote.**

## Operating Context

- Reached at **https://mote.jonjaques.com**, a static Cloudflare Pages deploy built from
  `main` on GitHub. First visit means downloading **hundreds of megabytes to gigabytes of
  weights from Hugging Face** onto an unknown GPU. That cold start is not a loading screen to be
  hidden — for this audience it is a substantial share of the total time on the page, and
  the most fragile part of the demo.
- Later visits load from the browser's Cache API. Cache state, storage estimate and
  eviction are facts the visitor may need to see.
- Development runs against a local mirror in `./models/` served by dev-only Vite
  middleware. The deployed path and the development path fetch from different origins;
  only the local one has ever been measured.
- The working session is: type a prompt → watch tool calls run against a virtual
  filesystem → see the page change in the iframe → follow up with an edit request.
  Files, Console and the raw model stream are all inspectable while it runs.

## Capabilities and Constraints

Implemented and measured (see `HANDOFF.md`): worker-hosted WebLLM engine, model picker
over the local mirror ∪ Hugging Face records with VRAM and feature guards, opaque-origin
sandbox with host bridge, `write_file` / `read_file` / `list_files` / `run_js` tool loop
over structural tags, persistence in `localStorage`, zip export, and a CDP harness that
drives the app through `window.__llmcoder`.

Durable technical constraints:

- **Tool calling uses XGrammar structural tags**, never WebLLM's `tools` parameter, which
  is hard-gated to five Hermes model ids in 0.2.84.
- **Tool results return as `user` messages** wrapped in `<tool_response>`; Qwen chat
  templates declare no `tool` role and throw.
- The sandbox iframe runs **without `allow-same-origin`** under a strict CSP. Model-written
  code cannot reach the host document, storage, or the weight cache. Features that would
  break this (open-preview-in-a-new-tab via blob URL) have already been ruled out.
- The 7B coder is the model that reliably builds and edits pages, at ~5.1 GB of VRAM and
  50–140 s per page on an M5.
- `AGENTS.md` holds the full file-ownership map and the constraints that are easy to
  violate while editing. It is binding on implementation work.

**Unsupported hardware — confirmed decision.** A visitor with no WebGPU, an integrated
GPU, or a phone gets an honest explanation of what Mote needs and why. No degraded mode,
no replayed session, no canned demo. Being upfront about the hardware requirement is part
of the technical credibility; faking the demo would contradict the one thing the product
is trying to prove.

Settled since:

- **Deploy target: Cloudflare Pages at `mote.jonjaques.com`, built from `main`.** The local
  mirror does not ship — `loadLocalRecords()` is gated on `import.meta.env.DEV`, so a
  deployed visitor is always served from Hugging Face.
- **A visitor is offered the whole prebuilt catalogue, filed by what their device can hold.**
  The picker opens on the smallest model measured to build whole pages (the 1.5B coder,
  830 MB) rather than the most capable one, and names the best fit alongside it. Only ids
  with pass rates in `HANDOFF.md` may be labelled "recommended".
- **The page carries an optional Google Analytics tag**, injected at build time only when
  `GA_MEASUREMENT_ID` is set. It reports page views and three events — a model load, a load
  failure, a preflight failure. Prompts, model output and file contents are never sent. The
  product's claim is about the *model* — no inference, no prompt and no generated code leaves
  the tab — and the public copy is worded to say exactly that and not more.

Open decisions, not to be invented:

- **The Hugging Face-served path has never been measured.** Every recorded number came
  from the local mirror. Cold-start time, failure modes and rate-limit behavior on the
  public path are unknown.
- **The initial JavaScript payload is 2.3 MB gzipped** (6.3 MB parsed) because WebLLM is a
  main-thread import, and it ships a second time inside the worker chunk. Nothing renders
  until it arrives. Whether that is worth an engine-loading refactor is undecided.

## Brand Commitments

- The product is named **Mote** (repo is `llmcoder`).
- It must read as a **runtime, debugger, or piece of computing infrastructure** — small,
  powerful, local, technical, slightly strange — not as an assistant or a chatbot.
- Explicitly banned: purple AI gradients, sparkles, robot imagery, glowing brains, and
  friendly-assistant framing.
- Standing themes: local-first, hardware accelerated, self-contained, browser-native,
  fast and immediate, developer-focused, minimal and precise.
- Motif vocabulary already committed in `PLAN.md` Appendix C: particles, pixels, memory
  cells, tiny contained worlds, computational nodes, a single point of energy surrounded
  by structure.
- Monospace is for code, logs, paths and measurements only — not decoration.

## Evidence on Hand

- `HANDOFF.md` holds real measured pass rates, load times, model sizes and tok/s from an
  Apple M5. **Confirmed: these stay internal.** They are engineering evidence, not
  marketing copy, and the public surface should make no performance claims. Do not put
  them on screen.
- The live demo itself is the evidence. What a visitor watches happen is the proof.
- There are **no** testimonials, users, customers, press, benchmarks against competitors,
  pricing, or third-party validation of any kind. None of these may be fabricated or
  implied.
- Real generated output exists as harness reports (`cdp-report*.json`, gitignored) and the
  seeded starter project.

## Product Principles

1. **The absence is the product.** Every decision should make "nothing leaves this tab"
   more evident, not less. A feature that needs a server is out of scope regardless of
   what it enables — this is the one commitment confirmed as inviolable.
2. **Show the machinery.** The visitor's belief is earned by watching real tool calls,
   real files and a real console, not by a summary of them. System state stays visible.
3. **Be honest about the hardware.** Mote asks a lot of the machine it runs on. It says
   so plainly and refuses cleanly rather than degrading into a demo of itself.
4. **Infrastructure, not assistant.** Precise, dense, technical. The interface should feel
   closer to a debugger than to a chat product.
5. **Claim only what was demonstrated.** No fabricated proof, no numbers on screen that
   were not re-measured on the path the visitor is actually using.

## Accessibility & Inclusion

No product-specific standard was established. Note that the confirmed hardware position
means Mote is deliberately unavailable to some visitors; the explanation they receive is
therefore a primary surface, and must be readable, focusable and complete on its own.
