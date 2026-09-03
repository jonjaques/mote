import { RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { PreflightFailure, PreflightVerdict } from '@/llm/models'

// PRODUCT.md fixes the position this screen takes: a visitor Mote cannot run gets an honest
// account of why and nothing else. No degraded mode, no replayed session, no canned demo —
// faking the demo would contradict the one thing the product exists to prove. So this replaces
// the shell outright rather than sitting inside it, and it is the only surface that visitor
// sees; it has to explain what Mote is on its own.
const FAILURES: Record<
  PreflightFailure,
  { lead: string; body: string; key: string; value: string }
> = {
  'no-webgpu': {
    lead: 'This browser has no WebGPU.',
    body: 'Mote runs the model on your own GPU, inside this tab. There is no server behind it to fall back to and no API to call instead, so without WebGPU there is nothing left to run.',
    key: 'Browser',
    value: 'Chrome 113+, Edge 113+, or Safari 18+',
  },
  'no-adapter': {
    lead: 'This browser has WebGPU, but no GPU it will hand out.',
    body: 'The API is present and returned no adapter — usually a virtual machine, a remote desktop, or a driver the browser has blocklisted. Mote has no software renderer to fall back to; a model this size only runs on real hardware.',
    key: 'Diagnose',
    value: 'chrome://gpu reports which driver was refused, and why',
  },
}

export function Unsupported({ verdict }: { verdict: Extract<PreflightVerdict, { ok: false }> }) {
  const failure = FAILURES[verdict.reason]

  return (
    <main className="preflight">
      <div className="preflight-scroll">
        <section className="preflight-card" aria-labelledby="preflight-heading">
          <header className="preflight-brand">
            {/* The brand symbol with its core unlit and unglowed. A glow in this system means
                the thing is running, and on this machine nothing is. */}
            <div className="brand-symbol is-dark" aria-hidden="true">
              <span />
            </div>
            <div>
              <h1>Mote</h1>
              <p>Local browser runtime</p>
            </div>
          </header>

          <h2 id="preflight-heading">This machine cannot run Mote.</h2>
          <p className="preflight-lead">{failure.lead}</p>
          <p>{failure.body}</p>

          <dl className="readout">
            <dt>Needs</dt>
            <dd>WebGPU, and a GPU with roughly 5 GB free</dd>
            <dt>{failure.key}</dt>
            <dd>{failure.value}</dd>
            <dt>Detected</dt>
            <dd>
              <code>{verdict.detected}</code>
            </dd>
          </dl>

          <p className="preflight-close">
            There is no degraded mode and no recorded demo behind this page. Mote either runs on
            your hardware or it does not — which is the whole of what it claims.
          </p>

          <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
            <RotateCw />
            Re-run the check
          </Button>
        </section>

        <footer className="preflight-status">
          <span>
            <i className="status-dot" /> Preflight failed
          </span>
          <span>No fallback</span>
          <span>Nothing was sent anywhere</span>
        </footer>
      </div>
    </main>
  )
}
