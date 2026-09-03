#!/usr/bin/env node
// cdp-agent.mjs — drive Mote's agent loop in a visible Chrome and score what it renders.
//
// The sandbox iframe has an opaque origin, so nothing on the host side — including CDP on the
// page session — can read what the model rendered. Every probe therefore runs *inside* the
// sandbox through window.__llmcoder.runInSandbox, the same bridge the agent's own run_js tool
// uses. The harness only ever touches window.__llmcoder: no selectors, no synthetic typing,
// so a UI change cannot silently break the measurement.
//
// Usage
//   node scripts/cdp-agent.mjs --scenario m3 --trials 10       # PLAN §6 M3 acceptance
//   node scripts/cdp-agent.mjs --scenario coffee               # M4 on the smart model
//   node scripts/cdp-agent.mjs --prompt "make the footer red"  # ad hoc, no checks
// Options
//   --url <origin>       dev server (default http://localhost:5180)
//   --model <id>         base model id; default is the scenario's role (fast / smart)
//   --scenario <name>    blue | alert | m3 (= blue + alert) | coffee | all
//   --trials <n>         repetitions per scenario (default 1)
//   --prompt <text>      ad-hoc prompt, repeatable, run in order after one reset
//   --headless           hide the window (default: visible, so the run can be watched)
//   --keep-open          leave Chrome running once the report is written
//   --step-timeout <s>   interrupt a prompt after this long (default 420)
//   --out <file>         JSON report (default cdp-report.json)
//   --chrome, --profile  as in cdp-trace.mjs

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { DEFAULT_CHROME, autoAttach, launchChrome, openPage, sleep } from "./cdp.mjs";

const { values: opts } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5180" },
    model: { type: "string" },
    scenario: { type: "string" },
    trials: { type: "string", default: "1" },
    prompt: { type: "string", multiple: true },
    headless: { type: "boolean", default: false },
    "keep-open": { type: "boolean", default: false },
    "step-timeout": { type: "string", default: "420" },
    out: { type: "string", default: "cdp-report.json" },
    chrome: { type: "string", default: DEFAULT_CHROME },
    profile: { type: "string", default: ".cdp-profile" },
  },
});

const MODELS = {
  fast: "Qwen3-0.6B-q4f16_1-MLC",
  smart: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
};

// Probes are function bodies evaluated inside the sandbox; they must return JSON-serialisable
// values because the bridge stringifies results before they cross the origin boundary.
const PROBES = {
  background: `
    const visible = (el) => {
      const c = getComputedStyle(el).backgroundColor;
      return c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent" ? c : null;
    };
    return { color: visible(document.body) ?? visible(document.documentElement) };`,
  // alert() is a no-op in a sandbox without allow-modals, so stubbing it is safe and the only
  // way to observe the handler firing. Inline onclick handlers resolve alert from window scope.
  alerts: `
    const alerts = [];
    window.alert = (m) => alerts.push(String(m));
    const buttons = [...document.querySelectorAll("button, input[type=button], input[type=submit], [role=button]")];
    for (const b of buttons) b.click();
    return { buttons: buttons.length, alerts };`,
  page: `
    const text = document.body.innerText.toLowerCase();
    let rules = 0;
    for (const s of document.styleSheets) { try { rules += s.cssRules.length; } catch {} }
    return {
      heading: Boolean(document.querySelector("h1, h2, h3")),
      form: Boolean(document.querySelector("form")),
      fields: document.querySelectorAll("form input, form textarea").length,
      menu: /menu/.test(text),
      coffee: /coffee/.test(text),
      rules,
      chars: document.documentElement.outerHTML.length,
    };`,
  sticky: `
    const pinned = new Set();
    const selector = "header, nav, .header, #header, h1, [class*=header], [id*=header]";
    for (const el of document.querySelectorAll(selector)) {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const p = getComputedStyle(e).position;
        if (p === "sticky" || p === "fixed") { pinned.add(e.tagName.toLowerCase() + ":" + p); break; }
      }
    }
    const text = document.body.innerText.toLowerCase();
    return { pinned: [...pinned], form: Boolean(document.querySelector("form")), menu: /menu/.test(text) };`,
};

function hueOf(color) {
  const m = color?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((v) => Number(v) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, saturation: 0, lightness: max };
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  const lightness = (max + min) / 2;
  const saturation = d / (1 - Math.abs(2 * lightness - 1));
  return { hue, saturation, lightness };
}

// "Blue" covers navy through sky blue; hue keeps #007bff and lightblue in, teal and purple out.
function isBlue(color) {
  const hsl = hueOf(color);
  return Boolean(hsl) && hsl.hue >= 185 && hsl.hue <= 260 && hsl.saturation >= 0.25 && hsl.lightness < 0.95;
}

function preservedRatio(before, after) {
  const lines = (before ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 12);
  if (!lines.length) return 1;
  return lines.filter((l) => after.includes(l)).length / lines.length;
}

const SCENARIOS = {
  blue: {
    role: "fast",
    steps: [
      {
        prompt: "make the background blue",
        probe: "background",
        judge: (v) => (isBlue(v.color) ? null : `background is ${v.color ?? "unset"}`),
      },
    ],
  },
  alert: {
    role: "fast",
    steps: [
      {
        prompt: "add a button that alerts hi",
        probe: "alerts",
        judge: (v) => {
          if (v.buttons === 0) return "no button rendered";
          return v.alerts.some((a) => /\bhi\b/i.test(a)) ? null : `clicking produced alerts ${JSON.stringify(v.alerts)}`;
        },
      },
    ],
  },
  coffee: {
    role: "smart",
    steps: [
      {
        prompt: "build a landing page for a coffee shop with a menu and contact form",
        probe: "page",
        judge: (v) => {
          const missing = [];
          if (!v.heading) missing.push("heading");
          if (!v.form) missing.push("form");
          if (v.fields < 2) missing.push("form fields");
          if (!v.menu) missing.push("menu");
          if (!v.coffee) missing.push("coffee copy");
          if (v.rules < 6) missing.push(`styling (${v.rules} rules)`);
          return missing.length ? `missing ${missing.join(", ")}` : null;
        },
      },
      {
        prompt: "make the header sticky",
        probe: "sticky",
        edit: true,
        judge: (v) => {
          if (!v.pinned.length) return "no sticky or fixed header";
          const lost = [];
          if (!v.form) lost.push("form");
          if (!v.menu) lost.push("menu");
          return lost.length ? `regenerated without the ${lost.join(" and ")}` : null;
        },
      },
    ],
  },
};
SCENARIOS.m3 = { role: "fast", steps: [...SCENARIOS.blue.steps, ...SCENARIOS.alert.steps], independent: true };

function selectScenarios() {
  if (opts.prompt?.length) {
    return { adhoc: { role: "fast", steps: opts.prompt.map((prompt) => ({ prompt })) } };
  }
  const name = opts.scenario ?? "m3";
  if (name === "all") return { blue: SCENARIOS.blue, alert: SCENARIOS.alert, coffee: SCENARIOS.coffee };
  if (name === "m3") return { blue: SCENARIOS.blue, alert: SCENARIOS.alert };
  if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}; use ${Object.keys(SCENARIOS).join(", ")}, all`);
  return { [name]: SCENARIOS[name] };
}

const fmt = (n, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : "—");

async function waitForModel(evaluate, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const state = await evaluate("window.__llmcoder ? { phase: window.__llmcoder.phase, progress: window.__llmcoder.progress, error: window.__llmcoder.error, model: window.__llmcoder.model } : null").catch(() => null);
    if (state?.phase === "ready") {
      console.error(`  model ready: ${state.model}`);
      return state;
    }
    if (state?.phase === "error") throw new Error(`model load failed: ${state.error}`);
    const bucket = state?.progress !== undefined ? `${Math.floor(state.progress * 4) * 25}%` : "";
    const line = `${state?.phase ?? "booting"} ${bucket}`.trim();
    if (line !== last) {
      console.error(`  ${line}`);
      last = line;
    }
    await sleep(250);
  }
  throw new Error("model did not become ready in time");
}

async function loadModel(evaluate, model) {
  const target = `${opts.url.replace(/\/$/, "")}/?model=${encodeURIComponent(model)}&autoload=1`;
  const origin = await evaluate("performance.timeOrigin").catch(() => 0);
  await evaluate(`location.assign(${JSON.stringify(target)})`).catch(() => {});
  // The old document keeps answering until it unloads; wait for a fresh timeOrigin.
  for (let i = 0; i < 100; i++) {
    const next = await evaluate("performance.timeOrigin").catch(() => origin);
    if (next !== origin) break;
    await sleep(100);
  }
  for (let i = 0; i < 300; i++) {
    if ((await evaluate("document.readyState").catch(() => "")) === "complete") break;
    await sleep(100);
  }
  return waitForModel(evaluate);
}

async function runPrompt(evaluate, text, label) {
  await evaluate(`(() => {
    window.__cdpRun = null;
    window.__llmcoder.send(${JSON.stringify(text)}).then(
      (run) => { window.__cdpRun = { ok: true, run }; },
      (error) => { window.__cdpRun = { ok: false, error: String((error && error.message) || error) }; },
    );
  })()`);
  const started = Date.now();
  const deadline = started + Number(opts["step-timeout"]) * 1000;
  let lastLine = "";
  while (Date.now() < deadline) {
    await sleep(500);
    // A reload (Vite, a manual refresh, a renderer crash) discards window.__cdpRun and, for a
    // moment, window.__llmcoder itself; either way the run is lost and only the page can say so.
    const state = await evaluate(`(() => {
      if (window.__cdpRun) return window.__cdpRun;
      if (!window.__llmcoder || !window.__llmcoder.getMessages) return { reloaded: true };
      const messages = window.__llmcoder.getMessages();
      const last = messages[messages.length - 1];
      const tools = (last?.tools ?? []).map((t) => t.call.name + (typeof t.call.arguments.path === "string" ? " " + t.call.arguments.path : ""));
      return { pending: true, tools, chars: (last?.content ?? "").length };
    })()`).catch(() => ({ reloaded: true }));
    if (state.reloaded) {
      console.error(`  ${label} page reloaded mid-run; waiting for the model to come back`);
      await waitForModel(evaluate);
      return { ok: false, error: "page reloaded during the run", reloaded: true, seconds: (Date.now() - started) / 1000 };
    }
    if (!state.pending) return { ...state, seconds: (Date.now() - started) / 1000 };
    const line = state.tools.at(-1) ?? (state.chars ? "streaming text" : "prefill");
    if (line !== lastLine) {
      console.error(`  ${label} ${fmt((Date.now() - started) / 1000, 0)}s  ${line}`);
      lastLine = line;
    }
  }
  await evaluate("window.__llmcoder.stop()").catch(() => {});
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const state = await evaluate("window.__cdpRun").catch(() => null);
    if (state) return { ...state, timedOut: true, seconds: (Date.now() - started) / 1000 };
  }
  return { ok: false, error: "timed out and could not be interrupted", timedOut: true, seconds: (Date.now() - started) / 1000 };
}

async function probeSandbox(evaluate, body) {
  const response = await evaluate(`window.__llmcoder.runInSandbox(${JSON.stringify(body)}).then(
    (r) => r,
    (error) => ({ ok: false, error: String((error && error.message) || error) }),
  )`);
  if (!response.ok) return { error: response.error ?? "probe threw" };
  try {
    return { value: JSON.parse(response.result) };
  } catch {
    return { value: response.result };
  }
}

async function runStep(evaluate, step, label) {
  const before = await evaluate("window.__llmcoder.getProject()");
  const outcome = await runPrompt(evaluate, step.prompt, label);
  const after = await evaluate("window.__llmcoder.getProject()").catch(() => before);
  const consoleErrors = await evaluate(
    "window.__llmcoder.getConsole().filter((e) => e.level === 'error').map((e) => e.args.join(' '))",
  ).catch(() => []);
  const run = outcome.run ?? { content: "", tools: [], rounds: 0, cutOff: false };
  const toolNames = run.tools.map((t) => t.call.name + (typeof t.call.arguments.path === "string" ? ` ${t.call.arguments.path}` : ""));
  const toolDetails = run.tools.map((t) => ({
    name: t.call.name,
    arguments: Object.fromEntries(
      Object.entries(t.call.arguments).map(([k, v]) => [k, typeof v === "string" && v.length > 400 ? `${v.slice(0, 400)}… [${v.length} chars]` : v]),
    ),
    status: t.status,
    summary: t.result?.summary,
    runtimeErrors: t.result?.runtimeErrors,
  }));
  const written = run.tools.filter((t) => t.call.name === "write_file" && t.status === "complete");
  const changed = Object.keys(after).filter((p) => after[p] !== before[p]);
  const inspectedFirst = (() => {
    const firstWrite = run.tools.findIndex((t) => t.call.name === "write_file");
    return firstWrite > 0 && run.tools.slice(0, firstWrite).some((t) => t.call.name === "read_file" || t.call.name === "list_files");
  })();
  const preserved = step.edit
    ? Object.fromEntries(changed.map((p) => [p, +preservedRatio(before[p], after[p]).toFixed(2)]))
    : undefined;

  const result = {
    prompt: step.prompt,
    ok: outcome.ok,
    error: outcome.ok ? run.error : outcome.error,
    timedOut: Boolean(outcome.timedOut),
    seconds: +outcome.seconds.toFixed(1),
    rounds: run.rounds,
    cutOff: run.cutOff,
    tools: toolNames,
    toolDetails,
    changed,
    inspectedFirst,
    preserved,
    consoleErrors,
    content: run.content,
    project: after,
  };

  let reason = null;
  if (result.error) reason = `run failed: ${result.error}`;
  else if (result.timedOut) reason = "timed out";
  else if (step.probe && written.length === 0) reason = "no successful write_file";
  else if (step.probe && changed.length === 0) reason = "project unchanged";
  if (!reason && step.probe) {
    const probe = await probeSandbox(evaluate, PROBES[step.probe]);
    result.probe = probe.value ?? null;
    if (probe.error) reason = `probe failed: ${probe.error}`;
    else reason = step.judge(probe.value, result);
  }
  if (!reason && step.probe && consoleErrors.length) reason = `runtime errors: ${consoleErrors.join(" | ").slice(0, 160)}`;
  result.pass = step.probe ? reason === null : undefined;
  result.reason = reason;
  return result;
}

async function main() {
  const scenarios = selectScenarios();
  const trials = Math.max(1, Number(opts.trials));
  const report = {
    url: opts.url,
    startedAt: new Date().toISOString(),
    chrome: null,
    trials,
    scenarios: {},
  };

  const { cdp, version, close, detach } = await launchChrome({ chrome: opts.chrome, profile: opts.profile, headless: opts.headless });
  report.chrome = version.Browser;
  try {
    const sessions = autoAttach(cdp, {
      onCrash: (crash) => console.error(`  !! target crashed: ${crash.status ?? ""} ${crash.errorCode ?? ""} ${crash.url ?? crash.targetId}`),
    });
    const { evaluate } = await openPage(cdp, sessions, "about:blank");
    let loadedModel = null;

    for (const [name, scenario] of Object.entries(scenarios)) {
      const model = opts.model ?? MODELS[scenario.role];
      if (model !== loadedModel) {
        console.error(`\n== ${model}`);
        await loadModel(evaluate, model);
        loadedModel = model;
      }
      const entry = { model, steps: scenario.steps.map((s) => s.prompt), trials: [] };
      report.scenarios[name] = entry;
      console.error(`\n== ${name} × ${trials}`);

      for (let trial = 1; trial <= trials; trial++) {
        await evaluate("window.__llmcoder.clearChat()");
        await evaluate("window.__llmcoder.resetProject()");
        const steps = [];
        for (const [index, step] of scenario.steps.entries()) {
          if (scenario.independent && index > 0) {
            await evaluate("window.__llmcoder.clearChat()");
            await evaluate("window.__llmcoder.resetProject()");
          }
          const label = `[${name} ${trial}/${trials}${scenario.steps.length > 1 ? ` step ${index + 1}` : ""}]`;
          const result = await runStep(evaluate, step, label);
          steps.push(result);
          const verdict = result.pass === undefined ? "done" : result.pass ? "PASS" : "FAIL";
          const extras = [
            `${result.seconds}s`,
            `${result.rounds} round${result.rounds === 1 ? "" : "s"}`,
            result.tools.length ? result.tools.join(", ") : "no tools",
            result.preserved && Object.keys(result.preserved).length ? `preserved ${Object.entries(result.preserved).map(([p, r]) => `${p} ${Math.round(r * 100)}%`).join(", ")}` : null,
            result.inspectedFirst ? "inspected first" : null,
          ].filter(Boolean);
          console.error(`  ${label} ${verdict}  ${extras.join("  ·  ")}${result.reason ? `\n      ${result.reason}` : ""}`);
          if (result.pass === undefined) {
            console.error(`      ${(result.content || "(no text)").replace(/\s+/g, " ").slice(0, 200)}`);
          }
          // A page that missed one requirement is still worth editing; only stop when nothing was written.
          if (result.pass === false && !result.changed.length) break;
        }
        entry.trials.push({ steps, pass: steps.every((s) => s.pass !== false) && steps.length === scenario.steps.length });
      }

      const scored = entry.trials.filter((t) => t.steps.some((s) => s.pass !== undefined));
      if (scored.length) {
        const passes = entry.trials.filter((t) => t.pass).length;
        const oneRound = entry.trials.filter((t) => t.pass && t.steps.every((s) => s.rounds === 1)).length;
        const seconds = entry.trials.flatMap((t) => t.steps.map((s) => s.seconds));
        const rounds = entry.trials.flatMap((t) => t.steps.map((s) => s.rounds));
        entry.summary = {
          passes,
          trials: entry.trials.length,
          oneRound,
          meanSeconds: +(seconds.reduce((a, b) => a + b, 0) / seconds.length).toFixed(1),
          meanRounds: +(rounds.reduce((a, b) => a + b, 0) / rounds.length).toFixed(2),
          failures: entry.trials.flatMap((t, i) => t.steps.filter((s) => s.pass === false).map((s) => `trial ${i + 1}: ${s.reason}`)),
        };
      }
    }

    await writeFile(opts.out, JSON.stringify(report, null, 2) + "\n");

    console.log(`\n${report.chrome}  →  ${opts.url}`);
    console.log("scenario   model                                        pass   1-round  mean s  mean rounds");
    for (const [name, entry] of Object.entries(report.scenarios)) {
      const s = entry.summary;
      if (!s) {
        console.log(`${name.padEnd(10)} ${entry.model.padEnd(44)} ${String(entry.trials.length).padStart(3)} run(s), no checks`);
        continue;
      }
      console.log(`${name.padEnd(10)} ${entry.model.padEnd(44)} ${`${s.passes}/${s.trials}`.padStart(5)}  ${`${s.oneRound}/${s.trials}`.padStart(7)}  ${fmt(s.meanSeconds).padStart(6)}  ${fmt(s.meanRounds, 2).padStart(11)}`);
      for (const failure of s.failures) console.log(`           ${failure}`);
    }
    console.log(`report written to ${opts.out}`);

    if (opts["keep-open"]) {
      console.error("leaving Chrome open (--keep-open); close the window to release the profile");
      detach();
    } else {
      await close();
    }
  } catch (error) {
    if (!opts["keep-open"]) await close().catch(() => {});
    throw error;
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
