---
name: Mote
description: A local browser runtime for an AI coding agent — dark, dense, instrument-grade.
colors:
  signal-cyan: "oklch(0.82 0.16 183)"
  signal-ink: "oklch(0.12 0.02 190)"
  trace-cyan: "oklch(0.55 0.09 183)"
  signal-write: "oklch(0.8 0.15 152)"
  signal-read: "oklch(0.74 0.12 253)"
  signal-net: "oklch(0.8 0.14 96)"
  kind-html: "oklch(0.64 0.065 210)"
  kind-css: "oklch(0.62 0.07 268)"
  kind-js: "oklch(0.66 0.07 100)"
  code-tag: "oklch(0.78 0.12 190)"
  code-name: "oklch(0.84 0.08 210)"
  code-attr: "oklch(0.74 0.06 245)"
  code-string: "oklch(0.80 0.09 78)"
  code-number: "oklch(0.82 0.11 96)"
  code-comment: "oklch(0.585 0.025 250)"
  code-punct: "oklch(0.62 0.02 250)"
  code-caret: "oklch(0.86 0.03 220)"
  code-bracket-match: "oklch(0.3 0.05 190 / 70%)"
  focus-ring: "oklch(0.73 0.14 183)"
  accent-surface: "oklch(0.23 0.03 190)"
  accent-text: "oklch(0.92 0.04 183)"
  cold-graphite: "oklch(0.13 0.008 255)"
  stage: "oklch(0.115 0.007 255)"
  well: "oklch(0.11 0.008 255)"
  panel: "oklch(0.155 0.009 255)"
  card: "oklch(0.16 0.01 255)"
  panel-raised: "oklch(0.18 0.011 255)"
  popover: "oklch(0.19 0.012 255)"
  muted: "oklch(0.19 0.01 255)"
  secondary: "oklch(0.22 0.014 255)"
  input: "oklch(0.27 0.014 250)"
  border: "oklch(0.29 0.014 250)"
  instrument-white: "oklch(0.94 0.012 235)"
  secondary-text: "oklch(0.91 0.012 235)"
  muted-text: "oklch(0.65 0.015 240)"
  code-text: "oklch(0.80 0.03 220)"
  alert-red: "oklch(0.68 0.2 25)"
  log-red: "oklch(0.73 0.16 28)"
  log-red-ink: "oklch(0.12 0.02 28)"
  log-amber: "oklch(0.78 0.13 80)"
typography:
  headline:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "1rem"
    fontWeight: 620
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 620
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "0.68rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0.055em"
  micro:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "0.65rem"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0.02em"
  nano:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "0.62rem"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "0.06em"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.7rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
rounded:
  none: "0"
  sm: "0.2rem"
  md: "0.3rem"
  lg: "0.45rem"
  xl: "0.65rem"
  full: "999px"
spacing:
  "2xs": "0.25rem"
  xs: "0.4rem"
  sm: "0.55rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.25rem"
components:
  button-primary:
    backgroundColor: "{colors.signal-cyan}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0 0.625rem"
    typography: "{typography.micro}"
  button-primary-hover:
    backgroundColor: "color-mix(in oklch, oklch(0.82 0.16 183), transparent 20%)"
    textColor: "{colors.signal-ink}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-text}"
    rounded: "{rounded.md}"
    height: "2rem"
    padding: "0 0.625rem"
  button-ghost-hover:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.instrument-white}"
  button-destructive:
    backgroundColor: "color-mix(in oklch, oklch(0.68 0.2 25), transparent 80%)"
    textColor: "{colors.alert-red}"
    rounded: "{rounded.md}"
    height: "2rem"
    padding: "0 0.625rem"
  select-trigger:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.instrument-white}"
    rounded: "{rounded.md}"
    height: "2.6rem"
    width: "100%"
  textarea-composer:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.instrument-white}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.625rem"
  panel-surface:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.instrument-white}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
  tool-card:
    backgroundColor: "color-mix(in oklch, oklch(0.18 0.011 255), transparent 20%)"
    textColor: "{colors.muted-text}"
    rounded: "{rounded.none}"
    padding: "{spacing.sm}"
    typography: "{typography.micro}"
  tool-card-complete:
    backgroundColor: "color-mix(in oklch, oklch(0.18 0.011 255), transparent 20%)"
    textColor: "{colors.muted-text}"
  tool-card-error:
    backgroundColor: "color-mix(in oklch, oklch(0.18 0.011 255), transparent 20%)"
    textColor: "{colors.log-red}"
  code-well:
    backgroundColor: "{colors.well}"
    textColor: "{colors.code-text}"
    rounded: "{rounded.none}"
    padding: "0.5rem 0.6rem"
    typography: "{typography.code}"
  workspace-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted-text}"
    rounded: "{rounded.none}"
    padding: "0 0.8rem"
  workspace-tab-active:
    backgroundColor: "transparent"
    textColor: "{colors.instrument-white}"
  count-badge:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-text}"
    rounded: "{rounded.full}"
    height: "1.05rem"
    padding: "0 0.3rem"
    typography: "{typography.nano}"
  count-badge-error:
    backgroundColor: "{colors.log-red}"
    textColor: "{colors.log-red-ink}"
    rounded: "{rounded.full}"
  status-dot:
    backgroundColor: "{colors.muted-text}"
    rounded: "{rounded.full}"
    size: "0.375rem"
  status-dot-ready:
    backgroundColor: "{colors.signal-cyan}"
    rounded: "{rounded.full}"
    size: "0.375rem"
---

# Design System: Mote

## Overview

**Creative North Star: "The Cold Instrument"**

Mote looks like a bench instrument in a dark lab. It is unlabeled until you know it, dense with
readouts, and honest about its own state at all times. Nothing is explained; everything is
displayed. The surface is a near-black graphite with a faint blue cast, ruled into panels by
hairline borders, and the only color in the room is a single cyan that means *this is live*.
Numbers are everywhere — VRAM, bytes, tokens per second, console counts, percentages — and
they are set in tabular figures so they tick in place instead of jittering.

The density is deliberate and high. Type runs small (0.62–1rem across the entire application;
there is no display type anywhere in the chrome), letter-spacing on labels is opened up to
0.055em so they stay legible at that size, and structural padding rarely exceeds 1rem. This is
an interface for someone who already knows what the controls do. Affordance comes from
precision and immediate response, not from generous hit areas or explanatory color.

The one thing the design must never do is look like an AI product. There are no purple
gradients, no sparkles, no robot or brain imagery, and no friendly-assistant framing anywhere
in the system — this is a standing brand commitment, not a stylistic preference. Mote is
infrastructure: a runtime, a debugger, a piece of machinery small enough to fit in a tab. The
cyan is not a brand color being applied decoratively; it is a lamp, and lamps mean something.

**Key Characteristics:**

- Dark-only. `color-scheme: dark` is set at the root; there is no light theme and no toggle.
- Four signal channels on a cold graphite field. Each is a lamp with one meaning, and each
  appears as an icon, a 1px rule or a dot — almost never as a fill.
- Flat by construction — no drop shadows anywhere; depth is four tonal surface steps and 1px borders.
- Square structure, softened controls (see Shapes).
- Every number is tabular; every measurement is visible.
- Monospace is reserved for code, logs, paths, and measurements — never for decoration.

## Colors

A cold graphite field carrying an **emission spectrum**: four narrow chromatic lines, each with
exactly one meaning, on neutrals that stay resolutely colorless. The ground is not tinted by the
signals — it is the black the signals are emitted against. That is why a hue here reads as a lamp
on an instrument rather than as a brand color applied to a surface.

The four channels are the system's spine. They live as `--signal-live`, `--signal-write`,
`--signal-read` and `--signal-net`, and any element can adopt one by taking a `.channel-*` class,
which sets a local `--channel` the element then spends as an icon color, a 1px rule or a dot.
A channel never becomes a large fill.

| Channel | Hue | Means | Where |
|---|---|---|---|
| **Live** | 183 cyan | running *right now* | the sandbox, the loaded runtime's dot, `run_js` / `get_dom` cards, the GPU upload phase, the active tab, the selected file, text selection |
| **Write** | 152 green | now **resident here** | `write_file` cards, files that no longer hold their starter text, cached weights, the Loaded control |
| **Read** | 253 blue | looked at, **not changed** | `read_file` / `list_files` cards, `console.info` |
| **Net** | 96 gold | bytes **crossing the tab boundary** | the fetch phase of a load, the download size and source readout, an uncached model in the picker |

Net is the one warm value in the entire application, and it earns that by being the exception
the product exists to make visible. It appears only while something is arriving from outside the
tab, and it is deliberately absent on a cached model and on the local mirror — the load bar going
gold → cyan → green is the cold start telling its own story without a word of copy.

### Primary

- **Signal Cyan** (`oklch(0.82 0.16 183)`): The live channel, and the system's oldest lamp. Its
  foreground pair is **Signal Ink** (`oklch(0.12 0.02 190)`), the near-black used for text on top
  of it. It is still the only channel that ever takes a full fill, on the primary action button.
- **Signal Write** (`oklch(0.8 0.15 152)`), **Signal Read** (`oklch(0.74 0.12 253)`) and
  **Signal Net** (`oklch(0.8 0.14 96)`): The other three channels. All sit at lightness 0.74–0.80
  and chroma 0.12–0.15 so no one of them shouts over the others, and all clear 8:1 against every
  surface in the system.
- **Trace Cyan** (`oklch(0.55 0.09 183)`): The marking left behind. The dimmed cyan for the
  assistant's role label, the version number, plain console lines, the status-bar guarantees, and
  hairline ticks. It carries the family resemblance without competing with a channel.
- **Focus Ring** (`oklch(0.73 0.14 183)`): Sits between the two, used only for the 3px
  `focus-visible` ring at 50% opacity and the default outline.

### Secondary

- **Accent Surface** (`oklch(0.23 0.03 190)`) and **Accent Text** (`oklch(0.92 0.04 183)`): A
  faintly cyan-tinted graphite pair. Its only current use is the file path inside a tool card,
  which reads as almost-white with a trace of the signal hue so it is legibly interactive
  before you hover it.

### Tertiary

Two diagnostic colors that are deliberately *not* the destructive red:

- **Log Red** (`oklch(0.73 0.16 28)`): Errors that already happened — console error lines,
  failed tool calls, runtime error text, the error count badge on the Console tab. Its
  foreground pair is **Log Red Ink** (`oklch(0.12 0.02 28)`), used only for the count on that
  badge — the one place Log Red is a fill rather than a text color.
- **Log Amber** (`oklch(0.78 0.13 80)`): Attention without failure — console warnings and the
  unsaved-file dot in the editor. It sits 16° from Signal Net and the two never share a region:
  Net lives in the runtime panel, Log Amber in console output.

### Subordinate registers

Two places need to differentiate more things than four channels can carry. Both stay below the
channels in chroma so they read as *tinted*, never as signals.

- **File-type tints**, on the file-tree icon only: **HTML** `oklch(0.64 0.065 210)`, **CSS**
  `oklch(0.62 0.07 268)`, **JS** `oklch(0.66 0.07 100)`. Chroma is capped at 0.08 — a third of a
  channel's — because these sit directly beside the cyan selection rule and the green authored
  dot, which must win.
- **The editor's syntax palette**, on the well: tag and keyword `oklch(0.78 0.12 190)`, function
  and definition `oklch(0.84 0.08 210)`, attribute and property `oklch(0.74 0.06 245)`, string
  `oklch(0.80 0.09 78)`, number and literal `oklch(0.82 0.11 96)`, comment and meta
  `oklch(0.585 0.025 250)` italic, operator and punctuation `oklch(0.62 0.02 250)`, invalid at
  Log Red. Structure is carried by the cyan family, values by a single warm note, and comments
  recede to 4.9:1 rather than disappearing. Four hues is the floor for code that still has to be
  scannable; this is deliberately not a sixth register invented for the editor.

### Neutral

- **Cold Graphite** (`oklch(0.13 0.008 255)`): The ground. The application background and the
  base for every tonal step above it.
- **Stage** (`oklch(0.115 0.007 255)`): Slightly *below* the ground — the workspace surface the
  sandbox iframe sits on, so the rendered page reads as an object placed on a darker table.
- **Well** (`oklch(0.11 0.008 255)`): The darkest surface in the system, and the only one that
  goes darker than the ground on purpose. Every place raw text is shown — the code editor, the
  console, the raw model stream, `run_js` snippets — is a well.
- **Panel** (`oklch(0.155 0.009 255)`): Chrome. The side pane, workspace bar, file tree, and
  status bar.
- **Card** (`oklch(0.16 0.01 255)`) / **Panel Raised** (`oklch(0.18 0.011 255)`) / **Popover**
  (`oklch(0.19 0.012 255)`): The three steps of "in front of the chrome" — cards, then input
  and select fields, then floating menus.
- **Muted** (`oklch(0.19 0.01 255)`) and **Secondary** (`oklch(0.22 0.014 255)`): Hover and
  pressed fills for otherwise transparent controls.
- **Border** (`oklch(0.29 0.014 250)`) and **Input** (`oklch(0.27 0.014 250)`): Every rule in
  the interface. Borders are always exactly 1px and never doubled; where a border needs to
  recede further it is mixed toward transparent (`color-mix(in oklch, var(--border), transparent 30–65%)`)
  rather than given a new value.
- **Instrument White** (`oklch(0.94 0.012 235)`): Primary text. **Secondary Text**
  (`oklch(0.91 0.012 235)`) on secondary fills; **Muted Text** (`oklch(0.65 0.015 240)`) for
  labels, metadata, and anything not currently the subject.
- **Code Text** (`oklch(0.80 0.03 220)`): Monospace foreground on wells — a desaturated
  blue-grey, never pure white.

### Named Rules

**The One Meaning Per Channel Rule.** This replaces the old Single Signal Rule, which held that
Signal Cyan marked the one live thing per region. That rule was written when cyan was the only
hue, and in practice it broke: every completed tool card took a cyan border, so a round of four
inspections looked exactly like a rewrite and cyan meant nothing in the transcript.

The rule now is stricter, not looser. **A channel means one thing everywhere in the application,
and an element takes at most one channel.** Cyan did not get more permissive — it got narrower:
it marks what is *live*, and stopped standing in for "finished", "cached" and "resident", which
now have their own channel. Before adding a hue, prove the meaning is not already one of the
four; before spending a channel on an element, prove it is the only channel that element could
carry. Two elements in the same region may both be cyan when both are genuinely live.

**The Channels Are Lamps Rule.** A channel appears as an icon, a 1px rule, a dot, or text — never
as a large fill. Signal Cyan on the primary action button is the single exception in the system,
and the reason the Loaded control gives up its fill the moment it stops being pressable: a fill
that large stops reading as emitted light and starts reading as a surface.

**The Two Reds Rule.** **Alert Red** (`oklch(0.68 0.2 25)`) is for actions *you can take* —
destructive buttons, inline delete confirmations, error banners you must respond to. **Log Red**
(`oklch(0.73 0.16 28)`) is for things that *already happened* — console output, failed tool
calls, error counts. They are close enough to be mistaken for each other and must never be
swapped.

**The Cool Axis Rule.** Every neutral sits at hue 235–255 with chroma ≤0.015 — unchanged, and
now load-bearing in a way it was not before. It used to be justified by cyan being the only real
color in the room; with four channels overhead it is the only thing keeping them legible. Tinting
a surface toward any channel would make that channel ambient, and an ambient signal is not a
signal. The ramp sits *on* the graphite; it never colors it.

## Typography

**Body Font:** Inter Variable (with `sans-serif` fallback), loaded via `@fontsource-variable/inter`
**Label/Mono Font:** `ui-monospace, SFMono-Regular, Menlo, monospace`

**Character:** One family, six sizes, five weights, and a hard split between prose and evidence.
Inter runs with `font-feature-settings: "cv02", "cv03", "cv04", "cv11"` on `html` — the
single-storey alternates that make it read more like a technical face and less like a marketing
one. There is no display type in the entire application; the largest text on screen is 1rem.
Weight, tracking, and case do the work that size would normally do.

### Hierarchy

- **Headline** (620, 1rem, 1.1, -0.025em): The product name in the brand block. The only
  `h1` in the app.
- **Title** (620, 0.8rem, -0.025em): Section headings — "Runtime", "Session". Small enough to
  sit inside the chrome rather than above it.
- **Body** (400, 0.78rem, 1.55): Message text and empty-state copy. `white-space: pre-wrap` so
  the model's line breaks survive. Text is set at `color-mix(in oklch, var(--foreground), transparent 6%)`
  — a hair below full white, so system labels can be brighter than conversation when they need to be.
- **Label** (650, 0.68rem, 0.055em): The workhorse. Brand subtitle, version, status bar,
  storage line, message role tags, file tree and console headers. Uppercased with
  `text-transform` where it labels a region (headers, role tags at weight 700); sentence case
  where it is a readout.
- **Micro** (500, 0.65rem, tabular): Progress percentages, tool-card metadata, run statistics.
  Almost always a number.
- **Nano** (650, 0.62rem, 0.06em): The floor. Count badges, menu group labels, and file-size
  readouts. Nothing in this system is set smaller, and nothing at this size is set below weight
  650 — see the Small-And-Tracked Rule.
- **Code** (400, 0.62–0.72rem, 1.5–1.65, mono): Editor content at 0.72rem, console lines at
  0.7rem, tool code and the raw stream box at 0.62rem. Size tracks how much of it you are
  expected to read.

### Named Rules

**The Monospace Is Evidence Rule.** Monospace means the characters matter individually: source
code, console output, file paths, and `run_js` snippets. It is never used for headings, labels,
buttons, or atmosphere. A monospace heading would make Mote look like a product imitating a
terminal instead of being an instrument.

**The Tabular Rule.** Every number that can change in place gets
`font-variant-numeric: tabular-nums` — progress percentages, byte counts, VRAM, tokens per
second, file sizes, console counts, timestamps, the version. A readout that reflows while it
updates is a broken readout.

**The Small-And-Tracked Rule.** Below 0.7rem, letter-spacing opens to 0.055em and weight rises
to 650. Small type in this system is dense on purpose, never faint: reach for tracking and
weight before reaching for a larger size.

## Layout

**The shell.** A two-column CSS grid at `100vw × 100svh` with `overflow: hidden` on `body`:
a fixed side pane at `minmax(19rem, 24rem)` and the workspace at `minmax(0, 1fr)`. The
application never scrolls; its panes do.

**The panes.** The side pane is a three-row grid — brand / runtime panel / chat — where only the
chat row flexes (`minmax(0, 1fr)`). The workspace is header / surface / status bar on the same
pattern. Both carry `min-height: 0` and `overflow: hidden`, and every inner scroll region
repeats `min-height: 0`.

**Chrome heights are fixed and matched.** The brand block and the workspace bar are both
`min-height: 4rem` so the two columns start on the same line. Section headers inside panes are
`2.6rem`. The status bar is `1.8rem`. These are structural, not incidental.

**Rhythm.** Panel padding is `1rem`. Control gaps run `0.25rem` (button clusters) to `0.5rem`
(field rows). Internal card padding is `0.55rem`. Vertical rhythm inside the message list is a
`0.8rem` block with a 1px top rule rather than a gap — conversation reads as a log, not as
bubbles.

**Responsive.** Desktop is the supported context; everything below is about staying
serviceable outside it. Three content-driven conditions, each measured at the width where the
design actually breaks rather than at a device size:

- **`1140px` — actions collapse.** The workspace bar's labelled min-content is `815px`; below
  about `1140px` it stops fitting. The action labels drop and Reload / Export / Seed / Reset
  become icons, each keeping its `title` and `aria-label`. Reset's confirmation label is
  exempt, since a destructive control must still ask its question.
- **`860px` — the shell stacks.** With the actions collapsed the two-column shell has a hard
  floor of `819px` (a `17rem` pane plus a `547px` bar), so `860px` is the last width where two
  columns hold. Below it the grid collapses to a single column of `minmax(100svh, auto)` rows —
  chat first as a full screen, workspace below — `body` regains `overflow: auto`, the workspace
  bar wraps its tabs above its actions, tabs go `flex: 1`, and the file tree narrows to `8.5rem`.
- **`max-height: 560px` — short viewports.** A landscape phone gives each pane 390px of height,
  which leaves the chat a sliver and pushes the composer out of a layout that cannot scroll. The
  shell becomes `height: auto` and the page scrolls.

The side pane column is `clamp(17rem, 28vw, 24rem)`, not `minmax(19rem, 24rem)`: a `minmax`
first track is awarded its maximum whenever the second track's minimum is `0`, so the pane kept
`384px` on a `900px` window while the workspace was clipped. The clamp makes the pane yield
first and still hold `24rem` once the window can afford it.

Touch sizing is keyed to `pointer: coarse`, not to width — a touchscreen laptop is not a phone.
Only hit areas grow, to `2.75rem`; type, spacing and colour are untouched, because the density
is the design. The one exception is `.tool-path`, an inline link inside tool-card rows set
`0.15rem` apart, where a 44px box would overlap its neighbours; it reaches `35px` via padding
offset by negative margin, which clears WCAG 2.2's 24px minimum.

The preview's phone mode is a separate control, not a breakpoint: it constrains the iframe to
`min(390px, 100%)` with side rules.

### Named Rules

**The Nothing-Below-The-Fold Rule.** Every grid row that contains a scroll container declares
`min-height: 0`, and every flexible track is `minmax(0, 1fr)`, never bare `1fr`. A grid item's
automatic minimum is its content, so without this the message list pushes the composer off
screen as the conversation grows and the action bar widens the page on mobile. This is not a
preference — it is the reason the layout works.

**It applies to the column axis too.** `.side-pane` and `.main-area` declare
`grid-template-columns: minmax(0, 1fr)` rather than leaving the single column implicit. An
implicit `auto` column is sized from its widest child's min-content, so the model select's full
label made the pane's track `316px` inside a `287px` pane and silently clipped the version, the
load percentage and the delete button off the right edge. An implicit column is a bare `1fr` by
another name.

## Elevation & Depth

**There are no drop shadows in this system.** Nothing floats, nothing lifts, nothing casts.
Depth is built entirely from four tonal surface steps and 1px hairlines:

```
well          oklch(0.11  0.008 255)   raw text: editor, console, stream
stage         oklch(0.115 0.007 255)   the table the sandbox sits on
cold-graphite oklch(0.13  0.008 255)   the ground
panel         oklch(0.155 0.009 255)   chrome: side pane, bars, tree
card          oklch(0.16  0.01  255)
panel-raised  oklch(0.18  0.011 255)   fields, selects, wells-in-chrome
popover       oklch(0.19  0.012 255)   floating menus
```

The steps are small — 0.02–0.03 lightness — because the border does the separating. Layering
without borders would be mud at this contrast.

### Shadow Vocabulary

`box-shadow` exists in exactly three roles, none of them elevation:

- **Signal glow** (`box-shadow: 0 0 1rem color-mix(in oklch, var(--primary), transparent 45%)`):
  A cyan halo on the mote mark and the brand symbol's core. It says *something is running here*.
- **Status halo** (`box-shadow: 0 0.2rem 0.6rem color-mix(in oklch, <dot color>, transparent 55–65%)`):
  The same idea at readout scale, under status dots. Takes the dot's own color, so an idle dot
  glows grey and a ready dot glows cyan.
- **Inset rule** (`box-shadow: inset 1px 0 var(--primary)` / `inset 0 -1px var(--primary)`):
  A 1px cyan edge marking the selected file and the active segment. It is a border drawn where
  a border would shift the layout — not a shadow.

### Named Rules

**The Glow Means Alive Rule.** A glow is a state signal, never atmosphere. It appears only on
elements that are actually live — a loaded runtime, a ready sandbox, the running mote. Adding a
glow for warmth makes every real signal in the interface unreadable.

**The Inset Rule.** Selection and active state are a 1px inset cyan rule, never a fill. Fills at
this density read as disabled surfaces; the rule reads as a marker.

## Shapes

**Structure is square. Controls are soft.** The distinction is load-bearing and carries the
North Star: the instrument is milled from a block, the controls on its face are handled.

**Square (radius 0):** every panel, the tool cards, the progress track, the stream box, code
wells, the segmented control's frame, inline error and confirmation blocks, the workspace
surface, the file tree rows, the brand symbol. Panels are separated by 1px borders and abutted
edge-to-edge; they never sit as detached rounded rectangles on a background.

**Soft (radius `0.3rem`, from the `sm 0.2 / md 0.3 / lg 0.45 / xl 0.65` scale):** things you
press or type into — buttons, inputs, textareas, select triggers, menu items. Small buttons clamp
to `min(var(--radius-md), 8–10px)` so the curve stays proportional as the control shrinks.

**Pill (`999px`):** true tokens only — count badges, status dots, the unsaved-file dot. A pill
in this system means "a discrete quantity or state", never "a rounded button".

**Geometry.** The brand symbol is the system's one piece of drawn identity: a `1.75rem` square
outlined in 35%-transparent cyan, with a `0.5rem` glowing core centered inside and two
`0.25rem` cyan pixels clipped to opposite outer corners. The same `0.5rem` square recurs as
`.mote-mark` in the empty chat state, rotated 45°. Corner ticks and 1px rules are the system's
decorative vocabulary; there is nothing else.

### Named Rules

**The Milled Panel Rule.** If it holds something, it is square. If you press it or type into it,
it is `0.3rem`. If it counts or reports, it is a pill. There is no fourth case.

## Components

The character across the board is **machined and unlabeled**: dense, tight, small type, no
decoration and no hand-holding. Controls are sized for someone who already knows what they do.

### Buttons

- **Shape:** Soft (`0.3rem`), 1px transparent border so variants can borrow the border box
  without shifting layout.
- **Primary:** Signal Cyan fill, Signal Ink text, `h-9` (2.25rem), `px-2.5`. Hover drops the fill
  to 80% opacity. This is the only cyan fill on screen — usually "Load model".
- **Ghost:** The default for workspace actions (Reload, Export, Reset). Transparent at rest with
  muted text; hover fills Muted and lifts text to Instrument White. Icon at 0.85–1rem, label at
  0.75rem, `gap: 0.25rem` between siblings.
- **Destructive:** Never a red fill. Alert Red text on a 10% Alert Red wash, rising to 20% on
  hover. It appears only after an inline confirmation has already been requested.
- **Focus / Active:** `focus-visible` draws a 3px ring at 50% Focus Ring plus a solid border;
  active translates the button down 1px (`active:translate-y-px`), except on menu triggers.
  Disabled is `opacity: 0.5` with pointer events off.

### Inputs and the composer

- **Style:** Panel Raised fill, Border stroke, `0.3rem` radius, 0.78rem text.
- **Composer:** A two-column grid — textarea plus send button, aligned to `end` — with
  `max-height: 9rem`, `resize: none`, and `field-sizing: content` so it grows with the message
  and then scrolls. Enter sends, Shift+Enter breaks, Esc stops generation; the empty state says
  so rather than a placeholder.
- **Focus:** Border shifts to Focus Ring, 3px ring at 50%. Transition is `color, box-shadow` only —
  never geometry.

### Tool call cards

The signature component, and where the channels do the most work. A three-column grid — leading
icon, content, trailing status — with a 1px border, an 80%-opacity Panel Raised fill, and square
corners.

**The card carries the channel of its tool**: `write_file` is Write, `read_file` and `list_files`
are Read, `run_js` and `get_dom` are Live (they are the two tools that reach into the running
page). The leading icon says *what the call was*, at 88% of the channel; the trailing icon says
*whether it finished*, muted while running and full channel once complete. The border is the same
lamp receded to 24% at rest and 34% when complete — close together on purpose, because the icons
already carry the channel and a firmer rule turns a round of four calls into four competing
outlines. A failure overrides the channel outright: Log Red on both icons and the text, and a
45%-opacity Alert Red border. What the call was going to do stops mattering once it failed.

The tool name is 0.65rem at weight 650 in Instrument White; the file path beside it is a
`.tool-path` button in Accent Text, mono, `text-decoration: underline dotted` with
`text-underline-offset: 0.2em`, that opens the file in the editor and goes solid Signal Cyan on
hover or focus. Long values ellipsize on one line; `run_js` code and console output drop into a
code well below, capped at `7.5rem` with its own scroll.

### Workspace tabs

Text-only, no chrome. Muted at rest, Instrument White when active, with a 1px Signal Cyan rule
drawn `-0.65rem` below the label via `::after` and inset `0.8rem` on both sides so it underlines
the word rather than the whole tab. Icons are 0.85rem. A tab may carry a count badge — Muted for
the file count, Log Red for the console error count.

### The runtime panel

The densest region and the clearest statement of the system. A section heading with a status dot
that is grey until a model is loaded and cyan after; a full-width `2.6rem` select whose options
are grouped "On this machine" / "Hugging Face", each showing VRAM and cache state as a `small`
line; a metadata row of icon-plus-value pairs; a `0.2rem` progress track with the label on the
left and a tabular percentage on the right; and a storage readout centered underneath. The
progress bar is a plain `width` transition on an inner `span` — see Do's and Don'ts.

In the grouped menu, each option's source icon carries its channel — green for cached, gold for a
Hugging Face record that is not — so the one question the menu is really asking, *which of these
costs me a download*, is answered before a label is read. The `small` line is deliberately left
neutral; colouring it too would put ten green and gold rows in competition.

**The panel is where the spectrum tells the cold start.** Before a load, an uncached model shows
its download size and source in Net gold and a cached one shows "Cached in browser" in Write
green — the cost of a choice, legible before it is made. During a load, the track and the route
line run gold while shards are still arriving from `huggingface.co`, then cross-fade (500ms,
`background-color` only) to cyan the moment those bytes start going to the GPU. Afterwards the
Load control takes `data-resident` and swaps its cyan fill for a green wash: cyan means live, and
a control that cannot be pressed again for the rest of the session is not the live thing in this
pane — the sandbox is.

The local mirror is deliberately exempt from gold. Its bytes never leave the machine, so its
fetch phase runs cyan; claiming a network crossing that did not happen would be the one kind of
dishonesty this palette exists to prevent.

### Console and editor wells

Both are Well-black, monospace, and scroll independently. Console lines are a three-column grid
(icon, timestamp, content) at 0.7rem with a `color-mix`-recessed 1px separator. Only warnings and
errors color the whole line — Log Amber and Log Red, icon included — because only they are
exceptional. `console.info` takes the Read channel on its icon alone and leaves the text at Code
Text; a plain `log` keeps its Trace Cyan icon, since it came from the running page.

The editor draws its syntax from the palette above, not from a stock theme. It used to pass
`theme="dark"` to CodeMirror, which quietly supplied the library's own highlight style — magenta
tags, warm orange strings — making the largest colored region in the application the one region
belonging to no design system. It now passes `theme="none"` and ships a `HighlightStyle`; if the
editor ever shows a hue that is not in the syntax list above, that prop has regressed.

Editor headers are `2.6rem`, uppercase Label type, with the filename in sentence case and an
amber dot when the buffer is dirty.

The file tree keys its icon to file type (the subordinate tints above) and marks every file that
no longer holds its starter text with a Write-green dot beside the byte count — the tree's half
of the write channel, in the same discrete-state vocabulary as the editor's amber dot. Selection
stays a 1px cyan inset rule on the left, so a file can be selected, authored, both, or neither
without the two signals colliding.

### The sandbox starter page

Mote ships a starter project that the model then edits, and it is a deliberate miniature of the
same world rendered in the model's own idiom: `#111719` ground, `#dce7e8` text, a single
`0.6rem` `#63e6d1` square ("the signal") that pulses via the Web Animations API, one hairline
`#344346` box, and a `clamp(2rem, 7vw, 4rem)` headline at `-0.05em`. It is the one place in the
project where display type exists. It is **not** part of the host design system: it uses hex,
a system font stack, and a different surface scale on purpose.

### Named Rules

**The Inline Confirmation Rule.** Destructive actions confirm in place, never through
`window.confirm`. The control's own row becomes a confirmation strip — the question, a
destructive confirm, a ghost cancel — bordered and washed in Alert Red. Reset does the same by
swapping its own label to "Replace all files?" and reverting after 4 seconds or on blur. A
modal dialog would block the tab and the automation harness both.

**The Readout Rule.** System state is always on screen, never behind a hover or a menu: sandbox
readiness, console line and error counts, the origin guarantees, storage used, VRAM, tokens per
second. The status bar's job is to make the machine's condition continuously legible.

## Do's and Don'ts

### Do:

- **Do** keep each channel to its one meaning, and give an element at most one channel. Reach for
  a `.channel-*` class and spend `--channel`; do not mint a bright/dim/border triplet per hue.
- **Do** check a new meaning against the four channels before adding a fifth hue. "Finished",
  "cached" and "resident" all turned out to be Write; "the sandbox" and "generating" are both
  Live.
- **Do** set `font-variant-numeric: tabular-nums` on every changing number.
- **Do** give every new scroll region `min-height: 0` and every flexible grid track
  `minmax(0, 1fr)`.
- **Do** reach for `color-mix(in oklch, <token>, transparent N%)` to recede a border or fill.
  That is how this system makes a value quieter — not by introducing a new token.
- **Do** confirm destructive actions inline, in the control's own row.
- **Do** keep chrome heights aligned: `4rem` top bars, `2.6rem` section headers, `1.8rem` status
  bar.
- **Do** reserve monospace for code, logs, paths, and measurements.
- **Do** test every UI change at ≤760px, where the shell stacks into two full-height screens.

### Don't:

- **Don't** introduce purple gradients, sparkles, robot or brain imagery, or friendly-assistant
  framing. This is a standing brand commitment from `PRODUCT.md`, not a style preference.
- **Don't** add drop shadows. If something needs to separate, it takes a border or a tonal step.
- **Don't** use a glow for atmosphere. A glow means the element is live.
- **Don't** round a panel, a tool card, a code well, or a progress track. Structure is square.
- **Don't** animate layout properties — `width`, `height`, `padding`, `margin` — on the load
  progress bar. The design detector hook blocks those writes, and the bar's inner `span` width
  is the one exception that is already accounted for.
- **Don't** put Inter, or any other webfont, into the sandbox starter CSS. The host application
  keeps Inter; generated pages use a system stack, because they are a different world and
  because a sandboxed page cannot load fonts through the CSP.
- **Don't** call `window.confirm`, `alert`, or `prompt` from the host or the sandbox. The sandbox
  runtime deliberately replaces all three with an in-page toast plus a console line.
- **Don't** add a light theme or a theme toggle. `color-scheme: dark` is set at the root and the
  entire palette is built for it.
- **Don't** use Alert Red for things that already happened, or Log Red on a control you can press.
- **Don't** tint a neutral toward a channel. The Cool Axis Rule is what keeps four hues legible;
  an ambient signal is not a signal.
- **Don't** give a channel a large fill. They are lamps — icons, 1px rules, dots and text. The
  primary action button is the single documented exception.
- **Don't** show Net gold for anything that did not cross the tab boundary. The local mirror
  loads cyan for exactly this reason.
- **Don't** pass `theme="dark"` to CodeMirror. It silently overrides the syntax palette with the
  library's own, which is where the magenta tags came from.
