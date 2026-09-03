#!/usr/bin/env node
// cdp-agent.mjs — drive Mote's agent loop in a real Chrome and score what it renders.
//
// The sandbox iframe has an opaque origin, so nothing on the host side — including CDP on the
// page session — can read what the model rendered. Every probe therefore runs *inside* the
// sandbox through window.__llmcoder.runInSandbox, the same bridge the agent's own run_js tool
// uses. The harness only ever touches window.__llmcoder: no selectors, no synthetic typing, so
// a UI change cannot silently break the measurement.
//
// The unit of work is a (scenario, variant, trial). Variants are patches over the agent config
// applied through the automation bridge between steps, so every arm of an experiment runs
// against one Chrome with one model on the GPU — the alternative was editing src/, which
// reloads the page and throws away a load that costs a minute and 4.4 GB. Trials are the outer
// loop so an interrupted run is still balanced, and the report is written after every one.
//
// Usage
//   node scripts/cdp-agent.mjs --scenario m3 --trials 10                    # PLAN §6 M3
//   node scripts/cdp-agent.mjs --scenario sticky --variant baseline,no-edit --trials 5
//   node scripts/cdp-agent.mjs --scenario coffee --model Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC
//   node scripts/cdp-agent.mjs --compare cdp-report.json --out next.json --scenario sticky
//   node scripts/cdp-agent.mjs --prompt "make the footer red"               # ad hoc, no checks
// Options
//   --url <origin>        dev server (default http://localhost:5180)
//   --scenario <names>    comma list, or a group: m3 | edits | all  (default m3)
//   --variant <names>     comma list from scripts/eval-variants.mjs (default baseline)
//   --model <id>          base model id; default is each scenario's role
//   --trials <n>          repetitions per scenario × variant (default 1)
//   --prompt <text>       ad-hoc prompt, repeatable, run in order after one reset
//   --compare <file>      print this run against an earlier report
//   --transcripts <dir>   where raw model output lands (default evals/transcripts)
//   --no-transcripts      do not write them
//   --headless            hide the window (default: visible, so the run can be watched)
//   --keep-open           leave Chrome running once the report is written
//   --step-timeout <s>    interrupt a prompt after this long (default 420)
//   --out <file>          JSON report (default cdp-report.json)
//   --list                print the scenarios and variants and exit
//   --chrome, --profile   as in cdp-trace.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_CHROME, autoAttach, launchChrome, openPage, sleep } from "./cdp.mjs";
import { MODELS, PROBES, SCENARIOS, SCENARIO_GROUPS } from "./eval-scenarios.mjs";
import { VARIANTS } from "./eval-variants.mjs";

const { values: opts } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5180" },
    model: { type: "string" },
    scenario: { type: "string" },
    variant: { type: "string", default: "baseline" },
    trials: { type: "string", default: "1" },
    prompt: { type: "string", multiple: true },
    compare: { type: "string" },
    transcripts: { type: "string", default: "evals/transcripts" },
    "no-transcripts": { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    "keep-open": { type: "boolean", default: false },
    "step-timeout": { type: "string", default: "420" },
    out: { type: "string", default: "cdp-report.json" },
    list: { type: "boolean", default: false },
    chrome: { type: "string", default: DEFAULT_CHROME },
    profile: { type: "string", default: ".cdp-profile" },
  },
});

const fmt = (n, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : "—");
const list = (value) => String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);

function selectScenarios() {
  if (opts.prompt?.length) {
    return { adhoc: { role: "fast", steps: opts.prompt.map((prompt) => ({ prompt })) } };
  }
  const names = list(opts.scenario ?? "m3").flatMap((name) => SCENARIO_GROUPS[name] ?? [name]);
  const unknown = names.filter((name) => !SCENARIOS[name]);
  if (unknown.length) {
    throw new Error(`unknown scenario ${unknown.join(", ")}; use ${Object.keys(SCENARIOS).join(", ")} or a group (${Object.keys(SCENARIO_GROUPS).join(", ")})`);
  }
  return Object.fromEntries(names.map((name) => [name, SCENARIOS[name]]));
}

function selectVariants() {
  const names = list(opts.variant);
  const unknown = names.filter((name) => !VARIANTS[name]);
  if (unknown.length) throw new Error(`unknown variant ${unknown.join(", ")}; use ${Object.keys(VARIANTS).join(", ")}`);
  return names.length ? names : ["baseline"];
}

// How much of the file survived the edit. Long lines only: a model that rewrites a stylesheet
// from scratch still reproduces `}` and `body {`, and counting those makes any rewrite look
// like a careful edit.
function preservedRatio(before, after) {
  const lines = (before ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 12);
  if (!lines.length) return 1;
  return lines.filter((l) => after.includes(l)).length / lines.length;
}

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

const excerpt = (text, length = 180) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, length);

async function runStep(evaluate, step, label) {
  if (step.fixture) {
    await evaluate(`window.__llmcoder.setProject(${JSON.stringify(step.fixture)})`);
  }
  await evaluate("window.__llmcoder.clearTranscripts()");
  const before = await evaluate("window.__llmcoder.getProject()");
  const outcome = await runPrompt(evaluate, step.prompt, label);
  const after = await evaluate("window.__llmcoder.getProject()").catch(() => before);
  const consoleErrors = await evaluate(
    "window.__llmcoder.getConsole().filter((e) => e.level === 'error').map((e) => e.args.join(' '))",
  ).catch(() => []);
  const transcripts = await evaluate("window.__llmcoder.getTranscripts()").catch(() => []);
  const run = outcome.run ?? { content: "", tools: [], rounds: 0, cutOff: false };
  const tools = run.tools.map((t) => t.call.name + (typeof t.call.arguments.path === "string" ? ` ${t.call.arguments.path}` : ""));
  const toolDetails = run.tools.map((t) => ({
    name: t.call.name,
    arguments: Object.fromEntries(
      Object.entries(t.call.arguments).map(([k, v]) => [k, typeof v === "string" && v.length > 400 ? `${v.slice(0, 400)}… [${v.length} chars]` : v]),
    ),
    status: t.status,
    summary: t.result?.summary,
    runtimeErrors: t.result?.runtimeErrors,
  }));
  const wrote = run.tools.filter((t) => (t.call.name === "write_file" || t.call.name === "edit_file") && t.status === "complete");
  const changed = Object.keys(after).filter((p) => after[p] !== before[p]);
  const firstWrite = run.tools.findIndex((t) => t.call.name === "write_file" || t.call.name === "edit_file");
  const inspectedFirst =
    firstWrite > 0 && run.tools.slice(0, firstWrite).some((t) => t.call.name === "read_file" || t.call.name === "list_files");

  const result = {
    prompt: step.prompt,
    ok: outcome.ok,
    error: outcome.ok ? run.error : outcome.error,
    timedOut: Boolean(outcome.timedOut),
    reloaded: Boolean(outcome.reloaded),
    seconds: +outcome.seconds.toFixed(1),
    rounds: run.rounds,
    cutOff: run.cutOff,
    tokens: run.stats ? { prompt: run.stats.promptTokens, completion: run.stats.completionTokens, perSecond: run.stats.tokensPerSecond } : undefined,
    tools,
    toolDetails,
    changed,
    inspectedFirst,
    // Findings the loop fed back, and calls that failed: the two places a round goes missing.
    findings: transcripts.flatMap((t) => t.rounds.flatMap((r) => r.findings ?? [])),
    failedCalls: transcripts.flatMap((t) => t.rounds.flatMap((r) => r.calls.filter((c) => c.ok === false).map((c) => `${c.name}: ${excerpt(c.summary, 100)}`))),
    parseErrors: transcripts.flatMap((t) => t.rounds.flatMap((r) => r.parseErrors)),
    preserved: step.edit
      ? Object.fromEntries(changed.map((p) => [p, +preservedRatio(before[p], after[p]).toFixed(2)]))
      : undefined,
    consoleErrors,
    content: run.content,
    project: after,
    transcripts,
  };

  // Checks in order of what they explain: a run that never wrote is not a styling failure.
  const checks = {};
  if (step.probe) {
    checks.ran = !result.error && !result.timedOut;
    checks.wrote = wrote.length > 0 && changed.length > 0;
    if (checks.ran && checks.wrote) {
      const probe = await probeSandbox(evaluate, PROBES[step.probe]);
      result.probe = probe.value ?? null;
      if (probe.error) checks.probed = false;
      else for (const [name, check] of Object.entries(step.checks ?? {})) checks[name] = Boolean(check(probe.value, result));
      checks.clean = consoleErrors.length === 0;
    }
    result.checks = checks;
    result.pass = Object.values(checks).every(Boolean);
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    result.reason = result.pass
      ? null
      : result.error
        ? `run failed: ${result.error}`
        : result.timedOut
          ? "timed out"
          : `failed ${failed.join(", ")}`;
  }
  return result;
}

async function runScenario(evaluate, { name, scenario, variant, trial, trials }) {
  await evaluate("window.__llmcoder.resetConfig()");
  if (Object.keys(VARIANTS[variant]).length) {
    await evaluate(`window.__llmcoder.setConfig(${JSON.stringify(VARIANTS[variant])})`);
  }
  await evaluate("window.__llmcoder.clearChat()");
  await evaluate("window.__llmcoder.resetProject()");

  const steps = [];
  for (const [index, step] of scenario.steps.entries()) {
    if (scenario.independent && index > 0) {
      await evaluate("window.__llmcoder.clearChat()");
      await evaluate("window.__llmcoder.resetProject()");
    }
    const label = `[${name}/${variant} ${trial}/${trials}${scenario.steps.length > 1 ? ` step ${index + 1}` : ""}]`;
    // A reload takes the run with it and is nothing to do with the model. Retry once; a step
    // that reloads twice is recorded as void and left out of the pass rate entirely, because
    // scoring it as a failure would put the machine's bad minute in the model's column.
    let result = await runStep(evaluate, step, label);
    if (result.reloaded) {
      console.error(`  ${label} lost to a page reload; retrying once`);
      result = await runStep(evaluate, step, label);
      result.void = result.reloaded;
    }
    steps.push(result);

    const verdict = result.void ? "VOID" : result.pass === undefined ? "done" : result.pass ? "PASS" : "FAIL";
    const extras = [
      `${result.seconds}s`,
      `${result.rounds} round${result.rounds === 1 ? "" : "s"}`,
      result.tools.length ? result.tools.join(", ") : "no tools",
      result.preserved && Object.keys(result.preserved).length
        ? `preserved ${Object.entries(result.preserved).map(([p, r]) => `${p} ${Math.round(r * 100)}%`).join(", ")}`
        : null,
      result.inspectedFirst ? "inspected first" : null,
    ].filter(Boolean);
    console.error(`  ${label} ${verdict}  ${extras.join("  ·  ")}${result.reason ? `\n      ${result.reason}` : ""}`);
    for (const finding of result.findings) console.error(`      finding: ${excerpt(finding, 140)}`);
    for (const failure of result.failedCalls.slice(0, 3)) console.error(`      refused: ${failure}`);
    // On a failure, the model's own words explain more than any of the above.
    if (result.pass === false) {
      const raw = result.transcripts.at(-1)?.rounds.at(-1)?.raw ?? result.content;
      console.error(`      said: ${excerpt(raw, 200)}`);
    } else if (result.pass === undefined) {
      console.error(`      ${excerpt(result.content, 200) || "(no text)"}`);
    }
    // A page that missed one requirement is still worth editing; only stop when nothing landed.
    if (result.pass === false && !result.changed.length) break;
  }
  return {
    steps,
    void: steps.some((s) => s.void),
    pass: steps.every((s) => s.pass !== false) && steps.length === scenario.steps.length,
  };
}

function summarize(runs) {
  const summary = {};
  for (const run of runs) {
    const key = `${run.scenario}::${run.variant}`;
    if (run.void) {
      const voided = (summary[key] ??= { scenario: run.scenario, variant: run.variant, model: run.model, trials: 0, passes: 0, oneRound: 0, seconds: [], rounds: [], completionTokens: [], failures: {}, tools: {} });
      voided.voids = (voided.voids ?? 0) + 1;
      continue;
    }
    const entry = (summary[key] ??= {
      scenario: run.scenario,
      variant: run.variant,
      model: run.model,
      trials: 0,
      passes: 0,
      oneRound: 0,
      seconds: [],
      rounds: [],
      completionTokens: [],
      failures: {},
      tools: {},
    });
    entry.trials += 1;
    if (run.pass) entry.passes += 1;
    if (run.pass && run.steps.every((s) => s.rounds === 1)) entry.oneRound += 1;
    for (const step of run.steps) {
      entry.seconds.push(step.seconds);
      entry.rounds.push(step.rounds);
      if (step.tokens?.completion) entry.completionTokens.push(step.tokens.completion);
      for (const [name, ok] of Object.entries(step.checks ?? {})) {
        if (!ok) entry.failures[name] = (entry.failures[name] ?? 0) + 1;
      }
      for (const tool of step.tools) {
        const bare = tool.split(" ")[0];
        entry.tools[bare] = (entry.tools[bare] ?? 0) + 1;
      }
    }
  }
  for (const entry of Object.values(summary)) {
    entry.meanSeconds = +mean(entry.seconds).toFixed(1);
    entry.meanRounds = +mean(entry.rounds).toFixed(2);
    entry.meanTokens = Math.round(mean(entry.completionTokens)) || undefined;
    delete entry.seconds;
    delete entry.rounds;
    delete entry.completionTokens;
  }
  return summary;
}

function printSummary(summary, title) {
  console.log(`\n${title}`);
  console.log("scenario    variant          pass   1-round  mean s  rounds  tokens  what failed");
  for (const entry of Object.values(summary)) {
    const failures = [
      ...Object.entries(entry.failures)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} ×${count}`),
      entry.voids ? `(${entry.voids} void)` : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `${entry.scenario.padEnd(11)} ${entry.variant.padEnd(16)} ${`${entry.passes}/${entry.trials}`.padStart(5)}  ` +
        `${`${entry.oneRound}/${entry.trials}`.padStart(7)}  ${fmt(entry.meanSeconds).padStart(6)}  ` +
        `${fmt(entry.meanRounds, 2).padStart(6)}  ${String(entry.meanTokens ?? "—").padStart(6)}  ${failures}`,
    );
  }
}

function printComparison(baseline, current) {
  console.log("\nagainst the baseline report");
  console.log("scenario    variant          pass            mean s          rounds");
  for (const [key, entry] of Object.entries(current)) {
    const was = baseline[key];
    if (!was) continue;
    const rate = (e) => e.passes / e.trials;
    const delta = (now, then, digits = 1) => {
      const d = now - then;
      return `${d >= 0 ? "+" : ""}${d.toFixed(digits)}`;
    };
    console.log(
      `${entry.scenario.padEnd(11)} ${entry.variant.padEnd(16)} ` +
        `${`${was.passes}/${was.trials} → ${entry.passes}/${entry.trials}`.padEnd(13)} ${delta(rate(entry) * 100, rate(was) * 100, 0).padStart(4)}%  ` +
        `${`${fmt(was.meanSeconds)} → ${fmt(entry.meanSeconds)}`.padEnd(14)} ${`${fmt(was.meanRounds, 2)} → ${fmt(entry.meanRounds, 2)}`}`,
    );
  }
}

async function saveTranscripts(run) {
  if (opts["no-transcripts"]) return;
  const dir = path.resolve(opts.transcripts);
  await mkdir(dir, { recursive: true });
  for (const [index, step] of run.steps.entries()) {
    for (const transcript of step.transcripts ?? []) {
      const file = path.join(dir, `${run.scenario}-${run.variant}-t${run.trial}-s${index + 1}.json`);
      await writeFile(
        file,
        JSON.stringify({ scenario: run.scenario, variant: run.variant, model: run.model, pass: step.pass, checks: step.checks, transcript }, null, 2) + "\n",
      );
    }
  }
}

async function main() {
  if (opts.list) {
    console.log(`scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
    console.log(`groups:    ${Object.entries(SCENARIO_GROUPS).map(([k, v]) => `${k} (${v.join(" ")})`).join(", ")}`);
    console.log(`variants:  ${Object.keys(VARIANTS).join(", ")}`);
    return;
  }

  const scenarios = selectScenarios();
  const variants = selectVariants();
  const trials = Math.max(1, Number(opts.trials));
  const report = {
    url: opts.url,
    startedAt: new Date().toISOString(),
    chrome: null,
    trials,
    variants,
    runs: [],
  };

  // Grouped by model so a run loads each set of weights once, whatever order the scenarios
  // were named in. Trials sit inside the group: the arms of an experiment must see the same
  // machine, and a laptop twenty minutes into a run is not the machine it was at the start.
  const byModel = new Map();
  for (const [name, scenario] of Object.entries(scenarios)) {
    const model = opts.model ?? MODELS[scenario.role];
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push([name, scenario]);
  }

  const { cdp, version, close, detach } = await launchChrome({ chrome: opts.chrome, profile: opts.profile, headless: opts.headless });
  report.chrome = version.Browser;
  try {
    const sessions = autoAttach(cdp, {
      onCrash: (crash) => console.error(`  !! target crashed: ${crash.status ?? ""} ${crash.errorCode ?? ""} ${crash.url ?? crash.targetId}`),
    });
    const { evaluate } = await openPage(cdp, sessions, "about:blank");

    for (const [model, entries] of byModel) {
      console.error(`\n== ${model}`);
      await loadModel(evaluate, model);
      for (let trial = 1; trial <= trials; trial++) {
        for (const [name, scenario] of entries) {
          for (const variant of variants) {
            const outcome = await runScenario(evaluate, { name, scenario, variant, trial, trials });
            const run = { scenario: name, variant, model, trial, ...outcome };
            await saveTranscripts(run);
            // Transcripts are on disk; keeping them in the report as well would double a
            // 40-trial file to tens of megabytes for no extra information.
            report.runs.push({ ...run, steps: run.steps.map(({ transcripts: _kept, ...step }) => step) });
            report.summary = summarize(report.runs);
            await writeFile(opts.out, JSON.stringify(report, null, 2) + "\n");
          }
        }
      }
    }

    console.log(`\n${report.chrome}  →  ${opts.url}`);
    printSummary(report.summary ?? {}, `${trials} trial${trials === 1 ? "" : "s"} per scenario × variant`);
    if (opts.compare) {
      const baseline = JSON.parse(await readFile(opts.compare, "utf8"));
      printComparison(baseline.summary ?? {}, report.summary ?? {});
    }
    console.log(`report written to ${opts.out}${opts["no-transcripts"] ? "" : `, transcripts to ${opts.transcripts}/`}`);

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
