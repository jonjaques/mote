export type ProjectPath = 'index.html' | 'styles.css' | 'app.js' | (string & {})

export interface ProjectFile {
  path: ProjectPath
  content: string
  bytes: number
}

// What React subscribes to. A new frozen object per revision so that anything derived from
// it in render (the srcdoc, the file tree) has a reactive input the React Compiler can see.
// Reading the singleton directly inside render or useMemo is memoised away by the compiler
// and the preview silently stops updating.
export interface ProjectSnapshot {
  revision: number
  files: Readonly<Record<string, string>>
}

export function listProjectFiles(files: Readonly<Record<string, string>>): ProjectFile[] {
  return Object.entries(files)
    .map(([path, content]) => ({ path, content, bytes: encoder.encode(content).byteLength }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

const encoder = new TextEncoder()
const STORAGE_KEY = 'mote:project:v1'

const starterFiles: Record<string, string> = {
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mote project</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <span class="signal" aria-hidden="true"></span>
      <h1>Your tiny world is ready.</h1>
      <p>Ask Mote to build something, or edit the files directly through its tools.</p>
    </main>
    <script src="app.js"></script>
  </body>
</html>`,
  'styles.css': `:root {
  color: #dce7e8;
  background: #111719;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

* { box-sizing: border-box; }

body {
  display: grid;
  min-height: 100vh;
  margin: 0;
  place-items: center;
}

main {
  width: min(34rem, calc(100% - 3rem));
  padding: 3rem;
  border: 1px solid #344346;
}

.signal {
  display: block;
  width: .6rem;
  height: .6rem;
  margin-bottom: 2rem;
  background: #63e6d1;
}

h1 { margin: 0; font-size: clamp(2rem, 7vw, 4rem); line-height: .95; letter-spacing: -.05em; }
p { max-width: 38ch; margin: 1.5rem 0 0; color: #91a4a7; line-height: 1.6; }`,
  'app.js': `console.log("Mote sandbox mounted");

document.querySelector(".signal")?.animate(
  [
    { opacity: 0.35, transform: "scale(0.7)" },
    { opacity: 1, transform: "scale(1)" },
  ],
  { duration: 900, iterations: Infinity, direction: "alternate", easing: "ease-in-out" },
);`,
}

const seedFiles: Record<string, string> = {
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Signal Garden</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <p class="label">SEED EXAMPLE / 01</p>
      <h1>Signal<br />Garden</h1>
      <button id="pulse">Send a pulse</button>
      <output id="reading">System quiet</output>
    </main>
    <script src="app.js"></script>
  </body>
</html>`,
  'styles.css': `:root { color: #e8f5e9; background: #102318; font-family: ui-monospace, monospace; }
* { box-sizing: border-box; }
body { display: grid; min-height: 100vh; margin: 0; place-items: center; }
main { width: min(38rem, calc(100% - 2rem)); padding: 3rem; border: 1px solid #406348; }
.label { color: #7ca486; font-size: .7rem; letter-spacing: .12em; }
h1 { margin: 2rem 0; font: 700 clamp(4rem, 14vw, 8rem)/.78 system-ui; letter-spacing: -.08em; }
button { padding: .8rem 1rem; color: #102318; background: #a6f0b5; border: 0; font: inherit; cursor: pointer; }
output { display: block; margin-top: 1rem; color: #7ca486; font-size: .75rem; }`,
  'app.js': `const button = document.querySelector("#pulse");
const reading = document.querySelector("#reading");
button?.addEventListener("click", () => {
  const value = Math.floor(Math.random() * 900 + 100);
  reading.textContent = \`Pulse \${value} acknowledged\`;
  console.log("pulse", value);
});`,
}

export function normalizeProjectPath(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/').replace(/^\.?\//, '')
  if (!normalized || normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error(`Invalid project path: ${path}`)
  }
  return normalized
}

export class VirtualFileSystem {
  private files = this.load()
  private listeners = new Set<() => void>()
  private revision = 0
  private snapshot: ProjectSnapshot = this.takeSnapshot()

  getRevision = (): number => this.revision

  getSnapshot = (): ProjectSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): ProjectFile[] {
    return listProjectFiles(this.snapshot.files)
  }

  read(path: string): string {
    const normalized = normalizeProjectPath(path)
    const content = this.files.get(normalized)
    if (content === undefined) throw new Error(`File not found: ${normalized}`)
    return content
  }

  // True when the file is absent or still carries starter or seed content, i.e. nothing a
  // model could need to preserve. The write_file tool uses this to exempt a fresh build from
  // its read-before-overwrite rule.
  isPristine(path: string): boolean {
    const normalized = normalizeProjectPath(path)
    const content = this.files.get(normalized)
    return (
      content === undefined ||
      content === starterFiles[normalized] ||
      content === seedFiles[normalized]
    )
  }

  write(path: string, content: string): number {
    const normalized = normalizeProjectPath(path)
    this.files.set(normalized, content)
    this.notify()
    return encoder.encode(content).byteLength
  }

  reset(): void {
    this.files = new Map(Object.entries(starterFiles))
    this.notify()
  }

  // A new revision with unchanged files: the keyed iframe remounts and page state resets.
  touch(): void {
    this.notify()
  }

  seed(): void {
    this.files = new Map(Object.entries(seedFiles))
    this.notify()
  }

  private takeSnapshot(): ProjectSnapshot {
    return Object.freeze({
      revision: this.revision,
      files: Object.freeze(Object.fromEntries(this.files)),
    })
  }

  private notify(): void {
    this.revision += 1
    this.snapshot = this.takeSnapshot()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.files)))
    } catch {
      // A working in-memory sandbox is more useful than rejecting edits when storage is full.
    }
    for (const listener of this.listeners) listener()
  }

  private load(): Map<string, string> {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (!saved) return new Map(Object.entries(starterFiles))
      const parsed: unknown = JSON.parse(saved)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return new Map(Object.entries(starterFiles))
      }
      const entries = Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      )
      return entries.length ? new Map(entries) : new Map(Object.entries(starterFiles))
    } catch {
      return new Map(Object.entries(starterFiles))
    }
  }
}

export const projectFS = new VirtualFileSystem()
