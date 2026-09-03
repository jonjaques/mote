// What `pnpm cdp:agent` measures, as data.
//
// A scenario is a list of steps. A step is a prompt, an optional fixture project to start it
// from, a probe that runs *inside* the sandbox, and named checks over what the probe saw. The
// checks are named rather than folded into one pass/fail string because a pass rate tells you a
// change was worse and never tells you what broke: forty trials of `missing menu, styling` is a
// prompt problem, forty of `no button rendered` is a tool problem.
//
// Fixtures matter as much. Measuring "make the header sticky" used to mean building a coffee
// shop page first — two minutes of 7B generation per trial, and a different page every time, so
// the edit was measured against a moving target. Starting the step from a fixed page makes it a
// twenty-second measurement of exactly the behaviour under test.

// A small, complete, plausibly model-written page. Deliberately not prettier-formatted: a
// fixture that already matches the formatter's output would hide whether formatting changed
// what the model then reads back.
const COFFEE_PAGE = {
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ember &amp; Oak Coffee</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header class="site-header">
      <h1>Ember &amp; Oak</h1>
      <nav><a href="#menu">Menu</a> <a href="#visit">Visit</a></nav>
    </header>
    <main>
      <section id="menu">
        <h2>Menu</h2>
        <ul class="menu-list">
          <li><span>Espresso</span><span>3.00</span></li>
          <li><span>Cortado</span><span>3.75</span></li>
          <li><span>Cold brew</span><span>4.25</span></li>
        </ul>
      </section>
      <section id="visit">
        <h2>Say hello</h2>
        <form id="contact">
          <label>Name <input name="name" required /></label>
          <label>Email <input name="email" type="email" required /></label>
          <label>Message <textarea name="message" rows="3"></textarea></label>
          <button type="submit">Send</button>
        </form>
        <output id="sent"></output>
      </section>
    </main>
    <script src="app.js"></script>
  </body>
</html>
`,
  'styles.css': `:root { color-scheme: light; --ink: #241c17; --paper: #fbf7f2; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: var(--paper); font-family: ui-sans-serif, system-ui, sans-serif; }
.site-header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 1rem 1.5rem; border-bottom: 1px solid #e2d6c8; }
.site-header h1 { margin: 0; font-size: 1.4rem; letter-spacing: -0.02em; }
nav a { margin-left: 1rem; color: inherit; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
section + section { margin-top: 3rem; }
.menu-list { margin: 0; padding: 0; list-style: none; }
.menu-list li { display: flex; justify-content: space-between; padding: 0.6rem 0; border-bottom: 1px dashed #e2d6c8; }
form { display: grid; gap: 0.75rem; max-width: 24rem; }
label { display: grid; gap: 0.25rem; font-size: 0.85rem; }
input, textarea { padding: 0.5rem; border: 1px solid #cbb9a6; background: #fff; font: inherit; }
button { justify-self: start; padding: 0.6rem 1.2rem; color: var(--paper); background: var(--ink); border: 0; font: inherit; cursor: pointer; }
`,
  'app.js': `const form = document.querySelector("#contact");
const sent = document.querySelector("#sent");
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  sent.textContent = "Thanks — we'll be in touch.";
});
`,
}

// Probes are function bodies evaluated inside the sandbox; they must return JSON-serialisable
// values because the bridge stringifies results before they cross the origin boundary.
export const PROBES = {
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
      coffee: /coffee|espresso|latte|brew/.test(text),
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
    return {
      pinned: [...pinned],
      form: Boolean(document.querySelector("form")),
      menu: /menu/.test(text),
      items: document.querySelectorAll(".menu-list li, li").length,
    };`,
  dark: `
    const rgb = (c) => (c.match(/\\d+/g) ?? []).slice(0, 3).map(Number);
    const lum = (c) => { const [r, g, b] = rgb(c); return r === undefined ? null : (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
    const body = getComputedStyle(document.body);
    return {
      background: lum(body.backgroundColor),
      text: lum(body.color),
      form: Boolean(document.querySelector("form")),
      items: document.querySelectorAll(".menu-list li, li").length,
    };`,
}

function hueOf(color) {
  const m = color?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return null
  const [r, g, b] = m.slice(1).map((v) => Number(v) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return { hue: 0, saturation: 0, lightness: max }
  let hue
  if (max === r) hue = ((g - b) / d) % 6
  else if (max === g) hue = (b - r) / d + 2
  else hue = (r - g) / d + 4
  hue = (hue * 60 + 360) % 360
  const lightness = (max + min) / 2
  return { hue, saturation: d / (1 - Math.abs(2 * lightness - 1)), lightness }
}

// "Blue" covers navy through sky blue; hue keeps #007bff and lightblue in, teal and purple out.
function isBlue(color) {
  const hsl = hueOf(color)
  return Boolean(hsl) && hsl.hue >= 185 && hsl.hue <= 260 && hsl.saturation >= 0.25 && hsl.lightness < 0.95
}

export const SCENARIOS = {
  blue: {
    role: 'fast',
    steps: [
      {
        prompt: 'make the background blue',
        probe: 'background',
        checks: { blue: (v) => isBlue(v.color) },
      },
    ],
  },
  alert: {
    role: 'fast',
    steps: [
      {
        prompt: 'add a button that alerts hi',
        probe: 'alerts',
        checks: {
          button: (v) => v.buttons > 0,
          alerts: (v) => v.alerts.some((a) => /\bhi\b/i.test(a)),
        },
      },
    ],
  },
  // The whole-page build, from the starter files. The expensive one.
  coffee: {
    role: 'smart',
    steps: [
      {
        prompt: 'build a landing page for a coffee shop with a menu and contact form',
        probe: 'page',
        checks: {
          heading: (v) => v.heading,
          form: (v) => v.form,
          fields: (v) => v.fields >= 2,
          menu: (v) => v.menu,
          copy: (v) => v.coffee,
          styling: (v) => v.rules >= 6,
        },
      },
    ],
  },
  // Editing in place, from a fixed page. This is the behaviour edit_file, the write guard and
  // history compaction all exist for, and starting from a fixture is what makes it cheap enough
  // to run ten times per variant.
  sticky: {
    role: 'smart',
    steps: [
      {
        prompt: 'make the header sticky',
        fixture: COFFEE_PAGE,
        edit: true,
        probe: 'sticky',
        checks: {
          pinned: (v) => v.pinned.length > 0,
          'kept the form': (v) => v.form,
          'kept the menu': (v) => v.menu && v.items >= 3,
        },
      },
    ],
  },
  // A second edit shape: a change that has to touch several rules without losing the page.
  dark: {
    role: 'smart',
    steps: [
      {
        prompt: 'switch the page to a dark colour scheme',
        fixture: COFFEE_PAGE,
        edit: true,
        probe: 'dark',
        checks: {
          'dark background': (v) => v.background !== null && v.background < 0.35,
          'readable text': (v) => v.text !== null && v.text - v.background > 0.35,
          'kept the form': (v) => v.form,
          'kept the menu': (v) => v.items >= 3,
        },
      },
    ],
  },
  // Two turns in one context: build, then edit what was just built. The only scenario where the
  // second step sees a page the model itself wrote, which is where history compaction bites.
  followup: {
    role: 'smart',
    steps: [
      { ...{ prompt: 'build a landing page for a coffee shop with a menu and contact form' }, probe: 'page', checks: {
        heading: (v) => v.heading,
        form: (v) => v.form,
        menu: (v) => v.menu,
        styling: (v) => v.rules >= 6,
      } },
      {
        prompt: 'make the header sticky',
        edit: true,
        probe: 'sticky',
        checks: {
          pinned: (v) => v.pinned.length > 0,
          'kept the form': (v) => v.form,
          'kept the menu': (v) => v.menu,
        },
      },
    ],
  },
}

// PLAN §6 M3 acceptance: two independent one-round requests on the fast model.
SCENARIOS.m3 = { role: 'fast', steps: [...SCENARIOS.blue.steps, ...SCENARIOS.alert.steps], independent: true }

export const SCENARIO_GROUPS = {
  m3: ['m3'],
  edits: ['sticky', 'dark'],
  all: ['blue', 'alert', 'coffee', 'sticky', 'dark'],
}

export const MODELS = {
  fast: 'Qwen3-0.6B-q4f16_1-MLC',
  smart: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
  page: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',
}
