import { beforeEach, describe, expect, it } from 'vitest'

import { VirtualFileSystem } from './fs'

describe('VirtualFileSystem', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts with the three starter files', () => {
    const fs = new VirtualFileSystem()
    expect(fs.list().map((file) => file.path)).toEqual(['app.js', 'index.html', 'styles.css'])
    expect(fs.read('index.html')).toContain('href="styles.css"')
    expect(fs.read('index.html')).toContain('src="app.js"')
  })

  it('normalises leading ./ and backslashes and rejects escapes', () => {
    const fs = new VirtualFileSystem()
    fs.write('./notes.txt', 'a')
    expect(fs.read('notes.txt')).toBe('a')
    fs.write('assets\\logo.svg', '<svg/>')
    expect(fs.read('assets/logo.svg')).toBe('<svg/>')
    // A leading slash is a model habit, not an escape attempt, so it maps to the project root.
    fs.write('/rooted.txt', 'r')
    expect(fs.read('rooted.txt')).toBe('r')
    expect(() => fs.write('../escape', 'x')).toThrow(/Invalid project path/)
    expect(() => fs.write('a/../b', 'x')).toThrow(/Invalid project path/)
    expect(() => fs.write('   ', 'x')).toThrow(/Invalid project path/)
    expect(() => fs.read('missing.css')).toThrow(/File not found/)
  })

  it('returns the UTF-8 byte count on write and bumps the revision', () => {
    const fs = new VirtualFileSystem()
    const before = fs.getRevision()
    expect(fs.write('index.html', 'héllo')).toBe(6)
    expect(fs.getRevision()).toBe(before + 1)
  })

  it('knows which files are still starter or seed content', () => {
    const fs = new VirtualFileSystem()
    expect(fs.isPristine('index.html')).toBe(true)
    expect(fs.isPristine('./styles.css')).toBe(true)
    expect(fs.isPristine('missing.txt')).toBe(true)
    fs.write('styles.css', 'body{}')
    expect(fs.isPristine('styles.css')).toBe(false)
    fs.seed()
    expect(fs.isPristine('app.js')).toBe(true)
  })

  it('hands out a frozen snapshot that only changes when the project does', () => {
    const fs = new VirtualFileSystem()
    const first = fs.getSnapshot()
    expect(fs.getSnapshot()).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.files)).toBe(true)
    expect(first.files['index.html']).toContain('Your tiny world is ready.')

    fs.write('index.html', '<p>next</p>')
    const second = fs.getSnapshot()
    expect(second).not.toBe(first)
    expect(second.revision).toBe(first.revision + 1)
    expect(second.files['index.html']).toBe('<p>next</p>')
    expect(first.files['index.html']).toContain('Your tiny world is ready.')
    expect(fs.getSnapshot()).toBe(second)
  })

  it('persists to localStorage and reloads from it', () => {
    const fs = new VirtualFileSystem()
    fs.write('index.html', '<p>persisted</p>')
    const again = new VirtualFileSystem()
    expect(again.read('index.html')).toBe('<p>persisted</p>')
  })

  it('falls back to the starter project when storage is corrupt', () => {
    localStorage.setItem('mote:project:v1', '{not json')
    expect(new VirtualFileSystem().read('index.html')).toContain('Your tiny world is ready.')
    localStorage.setItem('mote:project:v1', JSON.stringify(['array']))
    expect(new VirtualFileSystem().read('index.html')).toContain('Your tiny world is ready.')
  })

  it('reset and seed replace the whole project and notify subscribers', () => {
    const fs = new VirtualFileSystem()
    let notifications = 0
    const unsubscribe = fs.subscribe(() => {
      notifications += 1
    })
    fs.write('extra.js', '1')
    fs.seed()
    expect(fs.list().map((file) => file.path)).toEqual(['app.js', 'index.html', 'styles.css'])
    expect(fs.read('index.html')).toContain('Signal')
    fs.reset()
    expect(fs.read('index.html')).toContain('Your tiny world is ready.')
    expect(notifications).toBe(3)
    unsubscribe()
    fs.write('index.html', 'x')
    expect(notifications).toBe(3)
  })
})
