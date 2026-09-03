// Node 22+ pre-defines a `localStorage` global that stays undefined without --localstorage-file,
// and vitest's happy-dom environment only fills globals that are absent, so the DOM's Storage
// never arrives and fs.ts would silently lose persistence. Install a minimal in-memory Storage
// instead of depending on how happy-dom happens to expose its window.
class MemoryStorage implements Storage {
  private items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.items.delete(key)
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value))
  }
}

if (typeof localStorage === 'undefined' || localStorage === undefined) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  })
}
