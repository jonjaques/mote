#!/usr/bin/env node
// render-assets.mjs — rasterise the brand sources in assets/ into the files public/ ships.
//
//   assets/mark.svg          -> public/favicon.svg, apple-touch-icon.png, icon-{192,512}.png
//   assets/icon-maskable.svg -> public/icon-maskable-512.png
//   assets/og.html           -> public/og.png            (1200x630 link preview)
//
// The renderer is the same headless Chrome the CDP harness launches, for one reason: the
// sources use oklch-derived hex, a woff2 loaded out of node_modules, CSS masks and radial
// gradients. ImageMagick's SVG path renders none of that faithfully, and a link preview that
// disagrees with the product it previews is worse than no preview. Chrome renders exactly
// what the app renders.
//
// Outputs are committed — a deploy must not need a browser — so run this only when a source
// in assets/ changes, and commit the PNGs alongside it.
//
//   pnpm assets [--chrome <path>]

import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_CHROME } from "./cdp.mjs";

const root = path.resolve(import.meta.dirname, "..");
const assets = path.join(root, "assets");
const publicDir = path.join(root, "public");

const { values: opts } = parseArgs({
  options: { chrome: { type: "string", default: DEFAULT_CHROME } },
  allowPositionals: false,
});

// Chrome scales a standalone SVG to its intrinsic size, not to the window, so each icon is
// rendered through a throwaway page that stretches it to the exact pixel box we want.
async function wrapSvg(svgPath, size, scratch) {
  const page = path.join(scratch, `${path.basename(svgPath, ".svg")}-${size}.html`);
  await writeFile(
    page,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}img{display:block}</style>` +
      `<img src="file://${svgPath}" width="${size}" height="${size}">`,
  );
  return page;
}

function shoot(source, out, width, height) {
  return new Promise((resolve, reject) => {
    const chrome = spawn(opts.chrome, [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      // Fonts and the mark are read off disk; the budget only guards against a hung load.
      "--virtual-time-budget=4000",
      "--default-background-color=00000000",
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      `file://${source}`,
    ]);
    let stderr = "";
    chrome.stderr.on("data", (chunk) => (stderr += chunk));
    chrome.on("error", reject);
    chrome.on("exit", (code) =>
      code === 0
        ? resolve()
        : // Chrome logs display-link noise on macOS even on success; only surface it on failure.
          reject(new Error(`chrome exited ${code} rendering ${path.basename(source)}\n${stderr}`)),
    );
  });
}

const ICONS = [
  { svg: "mark.svg", out: "icon-192.png", size: 192 },
  { svg: "mark.svg", out: "icon-512.png", size: 512 },
  { svg: "mark.svg", out: "apple-touch-icon.png", size: 180 },
  { svg: "icon-maskable.svg", out: "icon-maskable-512.png", size: 512 },
];

const scratch = await mkdtemp(path.join(tmpdir(), "mote-assets-"));
try {
  await copyFile(path.join(assets, "mark.svg"), path.join(publicDir, "favicon.svg"));
  console.log("favicon.svg   <- assets/mark.svg");

  for (const icon of ICONS) {
    const page = await wrapSvg(path.join(assets, icon.svg), icon.size, scratch);
    await shoot(page, path.join(publicDir, icon.out), icon.size, icon.size);
    console.log(`${icon.out.padEnd(13)} <- assets/${icon.svg} @ ${icon.size}px`);
  }

  await shoot(path.join(assets, "og.html"), path.join(publicDir, "og.png"), 1200, 630);
  console.log("og.png        <- assets/og.html @ 1200x630");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
