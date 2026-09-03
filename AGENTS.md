# Mote agent guide

`PLAN.md` is the product and architecture specification. Read the relevant section before changing behavior; keep this file focused on constraints that are easy to violate while implementing it.

## Toolchain

- Use **pnpm**. `pnpm-lock.yaml` is authoritative even though this machine normally prefers Bun.
- Verify substantive changes with `pnpm build` (`tsc -b && vite build`).
- Do not add `models/`, `.cdp-profile/`, traces, or generated build output to Git. Model weights are multi-gigabyte local artifacts.
- Keep commits small and milestone-oriented. Do not mix opportunistic refactors into feature commits.

## WebLLM

- Keep the `WebWorkerMLCEngine` singleton in `src/llm/engine.ts`, never React state. React Strict Mode and the compiler assume state values are immutable; the engine is not.
- Construct the worker with the literal `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })` shape so Vite can split it.
- Merge local records with `prebuiltAppConfig`; suffix local `model_id` values with ` (local)`. Resolve mirror URLs to absolute same-origin URLs before passing them to WebLLM because its cache helpers reject root-relative URLs.
- Keep Qwen tool use on `response_format: { type: "structural_tag" }`. Do not use WebLLM's `tools` parameter; it is restricted to a small Hermes model list.
- Return tool results as `user` messages wrapped in `<tool_response>`. Qwen conversation templates do not support `role: "tool"`.
- Keep Qwen3 thinking disabled for agent requests, generation temperature low, tool rounds capped, and the smart model context override at 8192.

## Sandbox boundary

- Preserve `<iframe sandbox="allow-scripts">` without `allow-same-origin`. Model-authored code must remain unable to access the host document, storage, or model cache.
- The host accepts bridge messages only when `event.source === iframe.contentWindow`. The iframe posts to `"*"` because its origin is opaque.
- Keep the restrictive CSP in assembled `srcdoc`. Inline script and style are intentional; arbitrary network access is not.
- `srcdoc` cannot resolve virtual relative files. Assemble `index.html`, `styles.css`, `app.js`, and the runtime into one document in the host.
- Every `write_file` may reload the iframe and reset page state. Wait for the bridge to become ready before inspecting runtime results.

## Product code

- `src/sandbox/fs.ts` owns the virtual filesystem. Tools and React views must use the same singleton rather than maintaining duplicate file state.
- `src/sandbox/runtime.ts` owns the host/iframe bridge. Keep live bridge and engine objects outside reducer state.
- `src/state.tsx` is the single React reducer/context; do not add a store dependency for this proof of concept.
- Tool results should stay compact. Do not echo full `write_file` contents, and truncate long reads.
- A follow-up editing prompt should inspect existing files and preserve unrelated content instead of regenerating blindly.

## Interface

- The product is **Mote**: a small, self-contained browser runtime, not a generic friendly chatbot.
- Favor precise runtime/debugger language, dense readable controls, visible system state, and the established dark graphite/cyan visual system.
- Avoid purple AI gradients, sparkles, robot imagery, excessive rounded cards, and decorative monospace. Use monospace only for code, logs, paths, and measurements.
- Keep keyboard focus, disabled/loading/error states, mobile layout, and reduced viewport widths working whenever UI changes.
