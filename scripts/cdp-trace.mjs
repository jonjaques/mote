#!/usr/bin/env node
// cdp-trace.mjs — drive Chrome over the DevTools Protocol and record every model artifact a
// WebLLM page fetches. Zero dependencies: Node's built-in WebSocket + fetch, raw CDP JSON.
//
// Why CDP rather than the DevTools Network panel or a tab-scoped extension: chat.webllm.ai runs
// the engine in a *service worker* (ServiceWorkerMLCEngine), so the page's own network log stays
// empty while ~700 MB stream in. Target.setAutoAttach(flatten:true) on the browser endpoint,
// plus Network.enable on every attached session (page, dedicated worker, service worker), is
// what sees all of it.
//
// Chrome 136+ refuses --remote-debugging-port on the default profile, so this always launches a
// separate one (--profile, default .cdp-profile/). Bytes it caches land in THAT profile's Cache
// API — good as a reproducible prewarm/benchmark target, useless for warming your daily Chrome.
//
// Usage
//   node scripts/cdp-trace.mjs --url https://chat.webllm.ai --send hi
//   node scripts/cdp-trace.mjs --url "http://localhost:5173/?model=Qwen3-0.6B-q4f16_1-MLC&autoload=1"
// Options
//   --headed          show the window (default --headless=new; WebGPU works in both on macOS)
//   --chrome <path>   Chrome binary
//   --profile <dir>   user-data-dir (default .cdp-profile)
//   --send <text>     type into the first <textarea> and press Enter once the page has loaded
//   --idle <s>        stop after this many seconds with no artifact traffic (default 20)
//   --timeout <s>     hard stop (default 900)
//   --out <file>      JSON trace (default cdp-trace.json)

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    url: { type: "string", default: "https://chat.webllm.ai" },
    headed: { type: "boolean", default: false },
    chrome: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    profile: { type: "string", default: ".cdp-profile" },
    send: { type: "string" },
    idle: { type: "string", default: "20" },
    timeout: { type: "string", default: "900" },
    out: { type: "string", default: "cdp-trace.json" },
  },
});

const ARTIFACT_HOST = /huggingface\.co|hf\.co|xethub|cdn-lfs|raw\.githubusercontent\.com/;

function kindOf(url) {
  const file = url.split("?")[0].split("/").pop() ?? "";
  if (/^params_shard_\d+\.bin$/.test(file)) return "shard";
  if (file.endsWith(".wasm")) return "wasm";
  if (file === "ndarray-cache.json" || file === "tensor-cache.json") return "manifest";
  if (file === "mlc-chat-config.json") return "config";
  if (/tokenizer|vocab|merges/.test(file)) return "tokenizer";
  return "other";
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(port, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome did not open its DevTools endpoint in time");
}

// Minimal flat-session CDP client: one browser-level socket, sessionId routes to targets.
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`websocket error: ${e.message ?? e}`));
      this.ws.onmessage = (e) => this.dispatch(JSON.parse(e.data));
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  dispatch(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of this.listeners) fn(msg);
  }
  on(fn) {
    this.listeners.push(fn);
  }
}

async function main() {
  const port = await freePort();
  const profile = path.resolve(opts.profile);
  const chrome = spawn(
    opts.chrome,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      ...(opts.headed ? [] : ["--headless=new"]),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const shutdown = () => {
    if (!chrome.killed) chrome.kill("SIGTERM");
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });

  const trace = {
    url: opts.url,
    startedAt: new Date().toISOString(),
    chrome: null,
    targets: [],
    requests: [],
    summary: {},
  };
  const requests = new Map(); // requestId -> record
  const sessions = new Map(); // sessionId -> targetInfo
  let lastActivity = 0;

  try {
    const version = await waitForDevtools(port);
    trace.chrome = version.Browser;
    const cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();

    cdp.on(async (msg) => {
      const { method, params, sessionId } = msg;
      if (method === "Target.attachedToTarget") {
        const { sessionId: sid, targetInfo, waitingForDebugger } = params;
        sessions.set(sid, targetInfo);
        trace.targets.push({ type: targetInfo.type, url: targetInfo.url });
        // Order matters: the target is paused until runIfWaitingForDebugger, and we want the
        // network hooks live before a worker's first fetch, otherwise early shards are missed.
        await cdp.send("Network.enable", {}, sid).catch(() => {});
        await cdp
          .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid)
          .catch(() => {});
        if (waitingForDebugger) await cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
        return;
      }
      if (method === "Target.detachedFromTarget") {
        sessions.delete(params.sessionId);
        return;
      }
      if (!method?.startsWith("Network.")) return;
      const target = sessions.get(sessionId);
      if (method === "Network.requestWillBeSent") {
        const { requestId, request, timestamp, redirectResponse } = params;
        if (!ARTIFACT_HOST.test(request.url)) return;
        const existing = requests.get(requestId);
        if (existing && redirectResponse) {
          // HF answers /resolve/ with a 302 to its CDN; keep the logical URL, note the hop.
          existing.redirects.push(request.url);
          return;
        }
        requests.set(requestId, {
          url: request.url,
          kind: kindOf(request.url),
          from: target?.type ?? "?",
          start: timestamp,
          redirects: [],
          status: null,
          bytes: 0,
          seconds: null,
          fromCache: false,
          error: null,
        });
        lastActivity = Date.now();
      } else if (method === "Network.responseReceived") {
        const r = requests.get(params.requestId);
        if (!r) return;
        r.status = params.response.status;
        r.fromCache = Boolean(params.response.fromDiskCache || params.response.fromServiceWorker);
        r.server = params.response.headers?.server ?? params.response.headers?.Server ?? null;
        lastActivity = Date.now();
      } else if (method === "Network.loadingFinished") {
        const r = requests.get(params.requestId);
        if (!r) return;
        r.bytes = params.encodedDataLength;
        r.seconds = +(params.timestamp - r.start).toFixed(3);
        lastActivity = Date.now();
      } else if (method === "Network.loadingFailed") {
        const r = requests.get(params.requestId);
        if (!r) return;
        r.error = params.errorText;
        lastActivity = Date.now();
      }
    });

    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetId } = await cdp.send("Target.createTarget", { url: opts.url });

    // The page session arrives asynchronously via attachedToTarget.
    let pageSession;
    for (let i = 0; i < 100 && !pageSession; i++) {
      pageSession = [...sessions.entries()].find(([, t]) => t.targetId === targetId)?.[0];
      if (!pageSession) await sleep(100);
    }
    if (!pageSession) throw new Error("page target never attached");

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        pageSession,
      );
      if (exceptionDetails) throw new Error(exceptionDetails.text + ": " + (exceptionDetails.exception?.description ?? ""));
      return result.value;
    };

    for (let i = 0; i < 300; i++) {
      if ((await evaluate("document.readyState").catch(() => "")) === "complete") break;
      await sleep(100);
    }
    await sleep(1500); // let the SPA hydrate before poking it
    const gpu = await evaluate(
      "navigator.gpu ? navigator.gpu.requestAdapter().then(a => a ? (a.info?.vendor + ' ' + a.info?.architecture) : 'no adapter') : 'no navigator.gpu'",
    ).catch((e) => `error: ${e.message}`);
    console.error(`page loaded; WebGPU adapter: ${gpu}`);

    if (opts.send) {
      // readyState says nothing about a client-rendered SPA; chat.webllm.ai mounts its composer
      // a few seconds after load, so poll for the textarea instead of trusting the first look.
      let focused = false;
      for (let i = 0; i < 150 && !focused; i++) {
        focused = await evaluate(
          "(() => { const t = document.querySelector('textarea'); if (!t) return false; t.focus(); return true; })()",
        ).catch(() => false);
        if (!focused) await sleep(200);
      }
      if (!focused) throw new Error("--send: no <textarea> appeared on the page within 30s");
      await cdp.send("Input.insertText", { text: opts.send }, pageSession);
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send(
          "Input.dispatchKeyEvent",
          { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined },
          pageSession,
        );
      }
      console.error(`sent "${opts.send}"`);
    }

    const idleMs = Number(opts.idle) * 1000;
    const deadline = Date.now() + Number(opts.timeout) * 1000;
    let lastPrinted = "";
    while (Date.now() < deadline) {
      await sleep(1000);
      const done = [...requests.values()].filter((r) => r.seconds !== null);
      const bytes = done.reduce((n, r) => n + r.bytes, 0);
      const line = `${done.length}/${requests.size} artifact requests, ${(bytes / 1048576).toFixed(0)} MB`;
      if (line !== lastPrinted) {
        process.stderr.write(`\r  ${line}   `);
        lastPrinted = line;
      }
      if (requests.size > 0 && Date.now() - lastActivity > idleMs) break;
    }
    process.stderr.write("\n");

    trace.cache = await evaluate(`(async () => {
      const out = {};
      for (const k of (await caches.keys()).filter(k => k.startsWith('webllm'))) {
        const c = await caches.open(k); const keys = await c.keys();
        out[k] = { entries: keys.length, sample: keys.slice(0, 3).map(r => r.url) };
      }
      out.serviceWorker = navigator.serviceWorker?.controller?.scriptURL ?? null;
      return out;
    })()`).catch((e) => ({ error: e.message }));

    trace.requests = [...requests.values()];
    const byKind = {};
    const byHost = {};
    for (const r of trace.requests) {
      const host = new URL(r.url).host;
      byKind[r.kind] ??= { count: 0, bytes: 0 };
      byHost[host] ??= { count: 0, bytes: 0 };
      byKind[r.kind].count++;
      byKind[r.kind].bytes += r.bytes;
      byHost[host].count++;
      byHost[host].bytes += r.bytes;
    }
    const finished = trace.requests.filter((r) => r.seconds !== null);
    trace.summary = {
      requests: trace.requests.length,
      finished: finished.length,
      totalBytes: finished.reduce((n, r) => n + r.bytes, 0),
      wallSeconds: finished.length ? +(Math.max(...finished.map((r) => r.start + r.seconds)) - Math.min(...finished.map((r) => r.start))).toFixed(1) : 0,
      issuedFrom: [...new Set(trace.requests.map((r) => r.from))],
      byKind,
      byHost,
    };
    await writeFile(opts.out, JSON.stringify(trace, null, 2) + "\n");

    const mb = (n) => (n / 1048576).toFixed(1).padStart(8);
    console.log(`\n${trace.chrome}  →  ${opts.url}`);
    console.log(`issued from: ${trace.summary.issuedFrom.join(", ") || "(none)"}   wall: ${trace.summary.wallSeconds}s   total: ${mb(trace.summary.totalBytes)} MB`);
    for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(10)} ${String(v.count).padStart(4)} req ${mb(v.bytes)} MB`);
    for (const [h, v] of Object.entries(byHost)) console.log(`  ${h.padEnd(40)} ${String(v.count).padStart(4)} req ${mb(v.bytes)} MB`);
    if (trace.cache && !trace.cache.error) {
      for (const [k, v] of Object.entries(trace.cache)) if (typeof v === "object" && v) console.log(`  cache ${k.padEnd(14)} ${v.entries} entries`);
      console.log(`  service worker: ${trace.cache.serviceWorker ?? "none"}`);
    }
    console.log(`trace written to ${opts.out}`);
    await cdp.send("Browser.close").catch(() => {});
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
