// cdp.mjs — the DevTools-protocol plumbing shared by cdp-trace.mjs and cdp-agent.mjs.
// Zero dependencies: Node's built-in WebSocket + fetch, raw CDP JSON.
//
// Chrome 136+ refuses --remote-debugging-port on the default profile, so every launch uses a
// separate user-data-dir (default .cdp-profile/). Anything the page caches — 300 MB to 4 GB of
// model shards — lands in THAT profile, which makes it a reproducible warm target and useless
// for warming your daily Chrome.

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

export const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

export async function waitForDevtools(port, ms = 20000) {
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
export class CDP {
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

// Launch Chrome with remote debugging on a free port and connect a browser-level CDP socket.
// `headless` defaults to false: WebGPU works either way on this Mac, but a visible window is
// the only way to watch a model edit the sandbox while a harness drives it.
export async function launchChrome({ chrome = DEFAULT_CHROME, profile = ".cdp-profile", headless = false, windowSize = "1440,960" } = {}) {
  const port = await freePort();
  const process_ = spawn(
    chrome,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.resolve(profile)}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      `--window-size=${windowSize}`,
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const kill = () => {
    if (!process_.killed) process_.kill("SIGTERM");
  };
  process.on("SIGINT", () => {
    kill();
    process.exit(130);
  });

  try {
    const version = await waitForDevtools(port);
    const cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();
    return {
      cdp,
      version,
      kill,
      close: async () => {
        await cdp.send("Browser.close").catch(() => {});
        kill();
      },
      // Leave Chrome running after the script exits: drop the socket and the child handle.
      detach: () => {
        cdp.ws.close();
        process_.unref();
      },
    };
  } catch (error) {
    kill();
    throw error;
  }
}

// Attach to every target Chrome creates (pages, iframes, dedicated and service workers).
// `onSession(sessionId, targetInfo)` runs while the target is still paused, so hooks such as
// Network.enable are live before a worker's first fetch; otherwise early shards are missed.
export function autoAttach(cdp, { onSession, onCrash } = {}) {
  const sessions = new Map(); // sessionId -> targetInfo
  cdp.on(async (msg) => {
    const { method, params } = msg;
    if (method === "Target.targetCrashed" || method === "Inspector.targetCrashed") {
      // A crashed renderer takes the model with it and a visible tab reloads itself, which
      // looks like a mysterious "page reloaded" unless the crash is reported here.
      const target = params?.targetId
        ? [...sessions.values()].find((t) => t.targetId === params.targetId)
        : sessions.get(msg.sessionId);
      onCrash?.({ ...(params ?? {}), url: target?.url, type: target?.type });
      return;
    }
    if (method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = params;
      sessions.set(sessionId, targetInfo);
      // Inspector.targetCrashed only arrives on sessions that enabled the domain.
      if (targetInfo.type === "page" || targetInfo.type === "iframe") {
        await cdp.send("Inspector.enable", {}, sessionId).catch(() => {});
      }
      if (onSession) await onSession(sessionId, targetInfo).catch(() => {});
      await cdp
        .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
        .catch(() => {});
      if (waitingForDebugger) await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      return;
    }
    if (method === "Target.detachedFromTarget") sessions.delete(params.sessionId);
  });
  return sessions;
}

// Open `url` in a fresh tab and return a `Runtime.evaluate` bound to that page's session.
export async function openPage(cdp, sessions, url) {
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const { targetId } = await cdp.send("Target.createTarget", { url });

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
    if (exceptionDetails) {
      throw new Error(exceptionDetails.text + ": " + (exceptionDetails.exception?.description ?? ""));
    }
    return result.value;
  };

  for (let i = 0; i < 300; i++) {
    if ((await evaluate("document.readyState").catch(() => "")) === "complete") break;
    await sleep(100);
  }
  return { pageSession, evaluate };
}
