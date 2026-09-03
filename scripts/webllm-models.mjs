#!/usr/bin/env node
// webllm-models.mjs — resolve, mirror, verify and index WebLLM model artifacts.
//
// WebLLM never ships weights. At runtime it fetches, per model, from two hosts
//   weights + tokenizer + config   https://huggingface.co/mlc-ai/<model_id>/resolve/main/<file>
//   compiled WebGPU kernels        https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/<modelVersion>/<lib>.wasm
// and stores them in the browser Cache API under "webllm/model", "webllm/config" and
// "webllm/wasm" (verified against chat.webllm.ai — see PLAN.md, "How chat.webllm.ai serves
// models"). The file list is NOT discoverable from a repo listing: WebLLM 0.2.84 reads
// tensor-cache.json for the shard names and mlc-chat-config.json for the tokenizer files,
// so this script does exactly the same, which keeps it correct for any MLC-converted repo.
//
// Usage
//   node scripts/webllm-models.mjs list      [--filter <substr>] [--max-vram <MB>] [--json]
//   node scripts/webllm-models.mjs resolve   <spec> [--model-lib <url>] [--json]
//   node scripts/webllm-models.mjs download  <spec> [--out models] [--model-lib <url>] [--concurrency 4] [--force]
//   node scripts/webllm-models.mjs verify    <spec> [--out models]
//   node scripts/webllm-models.mjs index     [--out models]
//
// <spec> is a prebuilt model_id (see `list`), `hf:<org>/<repo>`, or a huggingface.co URL.
// A repo that is not in the prebuilt list needs --model-lib: the wasm is per
// architecture + quantisation + context config, not per repo (Qwen2.5-Coder-7B runs on the
// Qwen2-7B wasm), so it cannot be inferred safely. `resolve` prints candidates to pick from.
//
// Set HF_TOKEN to lift Hugging Face's anonymous rate limit. Downloads resume: a file whose
// size already matches the manifest is skipped unless --force.

import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import {
  functionCallingModelIds,
  modelLibURLPrefix,
  modelVersion,
  prebuiltAppConfig,
} from "@mlc-ai/web-llm";

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    filter: { type: "string" },
    "max-vram": { type: "string" },
    json: { type: "boolean", default: false },
    out: { type: "string", default: "models" },
    "model-lib": { type: "string" },
    concurrency: { type: "string", default: "4" },
    force: { type: "boolean", default: false },
  },
});
const [command, spec] = positionals;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// Same normalisation WebLLM applies (src/support.ts cleanModelUrl): every artifact URL is
// <repo>/resolve/main/<file>, whichever of the four accepted repo spellings was given.
function cleanModelUrl(url) {
  url += url.endsWith("/") ? "" : "/";
  url += url.includes("/resolve/") ? "" : "resolve/main/";
  return url;
}

function headersFor(url) {
  const h = { "user-agent": "llmcoder-webllm-models/1.0" };
  if (process.env.HF_TOKEN && /huggingface\.co/.test(url)) {
    h.authorization = `Bearer ${process.env.HF_TOKEN}`;
  }
  return h;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: headersFor(url) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function quantOf(id) {
  return (id.match(/q\d+f\d+(?:_\d+)?/) || [""])[0];
}

// Returns a WebLLM ModelRecord plus a `source` tag saying where it came from.
function resolveRecord(spec, modelLibOverride) {
  const prebuilt = prebuiltAppConfig.model_list.find((r) => r.model_id === spec);
  if (prebuilt) {
    return { ...prebuilt, model_lib: modelLibOverride ?? prebuilt.model_lib, source: "prebuilt" };
  }

  let repoUrl;
  if (spec.startsWith("hf:")) repoUrl = `https://huggingface.co/${spec.slice(3)}`;
  else if (/^https?:\/\//.test(spec)) repoUrl = spec;
  else {
    throw new Error(
      `"${spec}" is not a prebuilt model_id (try \`list\`) and not an hf:<org>/<repo> or URL spec.`,
    );
  }
  const cleaned = cleanModelUrl(repoUrl);
  const modelId = cleaned.split("/resolve/")[0].split("/").filter(Boolean).pop();

  // Another prebuilt record may already point at this exact repo under a different
  // model_id (the -1k context variants do this); reuse its wasm.
  const sibling = prebuiltAppConfig.model_list.find((r) => cleanModelUrl(r.model) === cleaned);
  const model_lib = modelLibOverride ?? sibling?.model_lib;
  if (!model_lib) {
    const q = quantOf(modelId);
    const candidates = [
      ...new Set(
        prebuiltAppConfig.model_list
          .filter((r) => !q || quantOf(r.model_id) === q)
          .map((r) => r.model_lib),
      ),
    ];
    throw new Error(
      `No model_lib known for ${repoUrl}. Pass --model-lib <url>. ` +
        `Prebuilt wasm files for quantisation "${q || "any"}" (${modelVersion}):\n  ` +
        candidates.map((u) => u.replace(modelLibURLPrefix, "")).join("\n  "),
    );
  }
  return {
    model: cleaned,
    model_id: modelId,
    model_lib,
    ...(sibling ? { vram_required_MB: sibling.vram_required_MB, overrides: sibling.overrides } : {}),
    source: sibling ? `prebuilt sibling ${sibling.model_id}` : "custom",
  };
}

// Everything the browser will fetch for this record, in the order WebLLM fetches it.
async function buildManifest(record) {
  const base = cleanModelUrl(record.model);
  const config = await fetchJson(base + "mlc-chat-config.json");
  const tensorCache = await fetchJson(base + "tensor-cache.json");
  const files = [
    { path: "mlc-chat-config.json", url: base + "mlc-chat-config.json" },
    { path: "tensor-cache.json", url: base + "tensor-cache.json" },
    // MLC tooling still refers to the same manifest by its older name. Keeping both names
    // costs only tens of kilobytes and makes the mirror useful outside the browser too.
    { path: "ndarray-cache.json", url: base + "ndarray-cache.json" },
    // WebLLM only loads tokenizer.json (falling back to tokenizer.model); mirroring every
    // file the config lists costs a few MB and keeps the mirror usable by mlc_llm too.
    ...(config.tokenizer_files ?? []).map((f) => ({ path: f, url: base + f })),
    ...tensorCache.records.map((r) => ({ path: r.dataPath, url: base + r.dataPath, bytes: r.nbytes })),
  ];
  const wasm = { path: path.basename(record.model_lib), url: record.model_lib };
  const shardBytes = tensorCache.records.reduce((n, r) => n + r.nbytes, 0);
  return { record, base, config, files, wasm, shardBytes };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function sizeOf(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

async function downloadOne(file, dest, onBytes) {
  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(file.url, { headers: headersFor(file.url), redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${file.url}`);
  const part = dest + ".part";
  const counter = new TransformStream({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part));
  await rename(part, dest);
}

async function download(manifest, outDir, { concurrency, force }) {
  const dir = path.join(outDir, manifest.record.model_id);
  await mkdir(dir, { recursive: true });
  const queue = [...manifest.files, manifest.wasm];
  const total = queue.length;
  let done = 0;
  let skipped = 0;
  let bytes = 0;
  const started = Date.now();
  const tick = setInterval(() => {
    const s = (Date.now() - started) / 1000;
    process.stderr.write(
      `\r  ${done + skipped}/${total} files  ${(bytes / 1048576).toFixed(0)} MB  ${(bytes / 1048576 / s).toFixed(1)} MB/s   `,
    );
  }, 500);

  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const dest = path.join(dir, f.path);
      const have = await sizeOf(dest);
      const complete = have >= 0 && (f.bytes === undefined || have === f.bytes);
      if (complete && !force) {
        skipped++;
        continue;
      }
      await downloadOne(f, dest, (n) => (bytes += n));
      done++;
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    clearInterval(tick);
    process.stderr.write("\n");
  }
  await writeLocalRecord(manifest, outDir);
  await writeIndex(outDir);
  return { dir, downloaded: done, skipped, bytes };
}

// The record the app uses when serving this mirror from /models/. Only the two URLs change;
// vram/overrides/features carry over because they describe the weights, not the host.
async function writeLocalRecord(manifest, outDir) {
  const { record } = manifest;
  const { source, ...rest } = record;
  const local = {
    ...rest,
    model: `/models/${record.model_id}/`,
    model_lib: `/models/${record.model_id}/${manifest.wasm.path}`,
    supports_native_tools: functionCallingModelIds.includes(record.model_id),
    upstream: { model: manifest.base, model_lib: record.model_lib, source, webllm: modelVersion },
    shard_bytes: manifest.shardBytes,
    downloaded_at: new Date().toISOString(),
  };
  await writeFile(
    path.join(outDir, record.model_id, "record.json"),
    JSON.stringify(local, null, 2) + "\n",
  );
}

async function writeIndex(outDir) {
  const entries = [];
  for (const name of (await readdir(outDir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    try {
      entries.push(JSON.parse(await readFile(path.join(outDir, name, "record.json"), "utf8")));
    } catch {
      /* directory without a finished record.json: partial download, leave it out */
    }
  }
  await writeFile(path.join(outDir, "index.json"), JSON.stringify(entries, null, 2) + "\n");
  return entries;
}

async function verify(manifest, outDir) {
  const dir = path.join(outDir, manifest.record.model_id);
  const problems = [];
  for (const f of [...manifest.files, manifest.wasm]) {
    const have = await sizeOf(path.join(dir, f.path));
    if (have < 0) problems.push(`missing  ${f.path}`);
    else if (f.bytes !== undefined && have !== f.bytes)
      problems.push(`size     ${f.path}: have ${have}, want ${f.bytes}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function printResolved(manifest) {
  const { record, files, wasm, shardBytes } = manifest;
  const shards = files.filter((f) => f.bytes !== undefined).length;
  console.log(`model_id     ${record.model_id}   (${record.source})`);
  console.log(`weights      ${manifest.base}`);
  console.log(`model_lib    ${record.model_lib}`);
  console.log(`vram         ${record.vram_required_MB ?? "?"} MB   low_resource=${record.low_resource_required ?? "?"}`);
  if (record.overrides) console.log(`overrides    ${JSON.stringify(record.overrides)}`);
  if (record.required_features) console.log(`features     ${record.required_features.join(", ")}`);
  console.log(`native tools ${functionCallingModelIds.includes(record.model_id) ? "yes (Hermes prompt)" : "no (use structural_tag)"}`);
  console.log(`arch         ${manifest.config.model_type} / ${manifest.config.quantization} / ctx ${manifest.config.context_window_size} / conv ${manifest.config.conv_template?.name ?? "?"}`);
  console.log(`files        ${files.length} + wasm  (${shards} shards, ${(shardBytes / 1048576).toFixed(1)} MB of weights)`);
  console.log(`wasm file    ${wasm.path}`);
}

async function main() {
  const outDir = path.resolve(opts.out);
  switch (command) {
    case "list": {
      const maxVram = opts["max-vram"] ? Number(opts["max-vram"]) : Infinity;
      const rows = prebuiltAppConfig.model_list
        .filter((r) => !opts.filter || r.model_id.toLowerCase().includes(opts.filter.toLowerCase()))
        .filter((r) => (r.vram_required_MB ?? 0) <= maxVram)
        .sort((a, b) => (a.vram_required_MB ?? 0) - (b.vram_required_MB ?? 0));
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      console.log(`@mlc-ai/web-llm prebuilt models (${modelVersion}) — ${rows.length} shown`);
      console.log("  vram_MB  low  tools  model_id                                          model_lib");
      for (const r of rows) {
        console.log(
          `  ${String(Math.round(r.vram_required_MB ?? 0)).padStart(7)}  ${r.low_resource_required ? " y " : " - "}  ${functionCallingModelIds.includes(r.model_id) ? "  y  " : "  -  "}  ${r.model_id.padEnd(48)}  ${path.basename(r.model_lib)}`,
        );
      }
      return;
    }
    case "resolve": {
      if (!spec) throw new Error("resolve needs a <spec>");
      const manifest = await buildManifest(resolveRecord(spec, opts["model-lib"]));
      if (opts.json) {
        console.log(JSON.stringify({ ...manifest, config: undefined }, null, 2));
      } else printResolved(manifest);
      return;
    }
    case "download": {
      if (!spec) throw new Error("download needs a <spec>");
      const manifest = await buildManifest(resolveRecord(spec, opts["model-lib"]));
      printResolved(manifest);
      console.log(`-> ${path.join(outDir, manifest.record.model_id)}`);
      const r = await download(manifest, outDir, {
        concurrency: Math.max(1, Number(opts.concurrency) || 4),
        force: opts.force,
      });
      const problems = await verify(manifest, outDir);
      console.log(
        `downloaded ${r.downloaded}, skipped ${r.skipped} (already complete), ${(r.bytes / 1048576).toFixed(1)} MB fetched`,
      );
      if (problems.length) {
        console.error("verify FAILED:\n  " + problems.join("\n  "));
        process.exitCode = 1;
      } else console.log(`verify OK; ${path.join(outDir, "index.json")} updated`);
      return;
    }
    case "verify": {
      if (!spec) throw new Error("verify needs a <spec>");
      const manifest = await buildManifest(resolveRecord(spec, opts["model-lib"]));
      const problems = await verify(manifest, outDir);
      if (problems.length) {
        console.error(problems.join("\n"));
        process.exitCode = 1;
      } else console.log(`OK ${manifest.record.model_id} complete in ${outDir}`);
      return;
    }
    case "index": {
      const entries = await writeIndex(outDir);
      console.log(`${entries.length} local model(s) indexed in ${path.join(outDir, "index.json")}`);
      for (const e of entries) console.log(`  ${e.model_id}  ${(e.shard_bytes / 1048576).toFixed(0)} MB`);
      return;
    }
    default:
      console.error(
        "usage: webllm-models.mjs <list|resolve|download|verify|index> [spec] [options]  (see header comment)",
      );
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
