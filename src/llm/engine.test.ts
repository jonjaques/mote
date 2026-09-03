import { describe, expect, it } from 'vitest'

import { parseLoadReport } from './engine'

describe('parseLoadReport', () => {
  it('reads a network fetch report', () => {
    const report = parseLoadReport(
      'Fetching param cache[12/88]: 2100MB fetched. 47% completed, 12 secs elapsed. It can take a while when we first visit this page to populate the cache. Later refreshes will become faster.',
    )
    expect(report.phase).toBe('fetch')
    expect(report.shard).toBe(12)
    expect(report.shards).toBe(88)
    expect(report.bytes).toBe(2_100 * 1_048_576)
  })

  it('distinguishes the GPU upload of an already-cached model', () => {
    const report = parseLoadReport('Loading model from cache[88/88]: 4086MB loaded. 100% completed, 9 secs elapsed.')
    expect(report.phase).toBe('gpu')
    expect(report.shard).toBe(88)
    expect(report.shards).toBe(88)
  })

  it('passes an unrecognised report through verbatim', () => {
    const report = parseLoadReport('Start to fetch params')
    expect(report.phase).toBe('other')
    expect(report.text).toBe('Start to fetch params')
    expect(report.shard).toBeUndefined()
  })

  it('tolerates no report at all', () => {
    expect(parseLoadReport(undefined)).toEqual({ phase: 'other', text: '' })
  })
})
