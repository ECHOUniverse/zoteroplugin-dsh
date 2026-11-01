import { describe, expect, it } from 'vitest'
import {
  KEY_PATTERN,
  LIMITS,
  MIN_ZOTERO_MAJOR,
  ZoteroError,
  isItemKey,
  libraryPrefix,
  normalizeItemQuery,
  parseItemKey,
  parseLinkHeader,
  parseTotalResults,
} from '../src/domain/model.ts'

describe('LIMITS', () => {
  it('pins the numbers the spec fixes', () => {
    expect(LIMITS.pageSize).toBe(50)
    expect(LIMITS.searchDefault).toBe(25)
    expect(LIMITS.searchMax).toBe(100)
    expect(LIMITS.panelMax).toBe(500)
    expect(LIMITS.writeBatch).toBe(50)
    expect(LIMITS.itemKeyBatch).toBe(50)
  })

  it('sets the supported Zotero floor to 10', () => {
    expect(MIN_ZOTERO_MAJOR).toBe(10)
  })
})

describe('item keys', () => {
  it('matches the Zotero 8-char charset without 0/1/O/I', () => {
    expect(KEY_PATTERN.source).toBe('^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$')
    expect(isItemKey('PAPERAAA')).toBe(true)
    expect(isItemKey('ABCD0123')).toBe(false)
    expect(isItemKey('ABCEO123')).toBe(false)
    expect(isItemKey('short')).toBe(false)
    expect(isItemKey('toolongkey99')).toBe(false)
  })

  it('parseItemKey returns the key or throws invalid_input', () => {
    expect(parseItemKey('PAPERAAA', 'key')).toBe('PAPERAAA')
    expect(() => parseItemKey('../evil', 'key')).toThrowError(ZoteroError)
    expect(() => parseItemKey('../evil', 'key')).toThrowError(/key/)
    try {
      parseItemKey('with space', 'attachmentKey')
      expect.unreachable()
    } catch (error) {
      expect((error as ZoteroError).code).toBe('invalid_input')
    }
  })
})

describe('libraryPrefix', () => {
  it('maps the personal library to users/0', () => {
    expect(libraryPrefix('user')).toBe('/api/users/0')
  })

  it('maps group ids to /api/groups/<id>', () => {
    expect(libraryPrefix('g12345')).toBe('/api/groups/12345')
  })

  it('rejects anything else before it can reach fetch', () => {
    for (const bad of ['self', 'groups', 'g', 'g12a', '-1', '', 'user/../../admin', 'G1', 'g-1']) {
      try {
        libraryPrefix(bad)
        expect.unreachable(`expected "${bad}" to be rejected`)
      } catch (error) {
        expect((error as ZoteroError).code).toBe('invalid_input')
      }
    }
  })
})

describe('normalizeItemQuery', () => {
  it('applies the documented defaults', () => {
    const query = normalizeItemQuery({})
    expect(query).toEqual({ mode: 'titleCreatorYear', sort: 'dateModified', direction: 'desc', start: 0, limit: 50 })
  })

  it('sorts titles and creators ascending by default', () => {
    expect(normalizeItemQuery({ sort: 'title' }).direction).toBe('asc')
    expect(normalizeItemQuery({ sort: 'creator' }).direction).toBe('asc')
    expect(normalizeItemQuery({ sort: 'date' }).direction).toBe('desc')
    expect(normalizeItemQuery({ sort: 'dateAdded' }).direction).toBe('desc')
  })

  it('keeps an explicit direction', () => {
    expect(normalizeItemQuery({ sort: 'title', direction: 'desc' }).direction).toBe('desc')
  })

  it('clamps pagination into the panel bounds', () => {
    expect(normalizeItemQuery({ limit: 0 }).limit).toBe(1)
    expect(normalizeItemQuery({ limit: 10_000 }).limit).toBe(LIMITS.panelMax)
    expect(normalizeItemQuery({ start: -5 }).start).toBe(0)
    expect(normalizeItemQuery({ start: 3 }).start).toBe(3)
  })

  it('rejects unknown sort/direction/mode values', () => {
    for (const query of [
      { sort: 'evil' as unknown as string },
      { direction: 'sideways' as unknown as string },
      { mode: 'index' as unknown as string },
    ]) {
      try {
        normalizeItemQuery(query)
        expect.unreachable()
      } catch (error) {
        expect((error as ZoteroError).code).toBe('invalid_input')
      }
    }
  })

  it('rejects non-integer pagination', () => {
    for (const query of [{ start: 1.5 }, { limit: Number.NaN }, { start: Number.POSITIVE_INFINITY }]) {
      try {
        normalizeItemQuery(query)
        expect.unreachable()
      } catch (error) {
        expect((error as ZoteroError).code).toBe('invalid_input')
      }
    }
  })

  it('drops empty q and rejects control characters', () => {
    expect(normalizeItemQuery({ q: '   ' }).q).toBeUndefined()
    expect(normalizeItemQuery({ q: 'region inference' }).q).toBe('region inference')
    try {
      normalizeItemQuery({ q: 'bad\u0000inject' })
      expect.unreachable()
    } catch (error) {
      expect((error as ZoteroError).code).toBe('invalid_input')
    }
  })

  it('caps query length', () => {
    try {
      normalizeItemQuery({ q: 'a'.repeat(1001) })
      expect.unreachable()
    } catch (error) {
      expect((error as ZoteroError).code).toBe('invalid_input')
    }
    expect(normalizeItemQuery({ q: 'a'.repeat(500) }).q).toHaveLength(500)
  })

  it('validates tag lists and keeps Zotero tag syntax', () => {
    expect(normalizeItemQuery({ tag: 'stack' }).tag).toEqual(['stack'])
    expect(normalizeItemQuery({ tag: ['stack', 'types'] }).tag).toEqual(['stack', 'types'])
    expect(normalizeItemQuery({ tag: '-draft' }).tag).toEqual(['-draft'])
    try {
      normalizeItemQuery({ tag: ['ok', 'bad\nnewline'] })
      expect.unreachable()
    } catch (error) {
      expect((error as ZoteroError).code).toBe('invalid_input')
    }
  })

  it('validates keys against the item key charset and batches at 50', () => {
    expect(normalizeItemQuery({ keys: ['PAPERAAA', 'PREPRAAA'] }).keys).toEqual(['PAPERAAA', 'PREPRAAA'])
    try {
      normalizeItemQuery({ keys: ['PAPERAAA', 'not-a-key'] })
      expect.unreachable()
    } catch (error) {
      expect((error as ZoteroError).code).toBe('invalid_input')
    }
    const charset = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
    const fiftyOne = Array.from({ length: 51 }, (_, i) => `PPPPPPP${charset[i % charset.length]}`)
    try {
      normalizeItemQuery({ keys: fiftyOne })
      expect.unreachable()
    } catch (error) {
      expect((error as ZoteroError).code).toBe('invalid_input')
    }
  })

  it('accepts collection and saved-search references that stay path-safe', () => {
    expect(normalizeItemQuery({ collection: 'CLPLAAAA' }).collection).toBe('CLPLAAAA')
    // 名称引用支持「父/子」路径（读取层再做 URL 编码，/ 不会拼进路径段）。
    expect(normalizeItemQuery({ collection: 'PL/Type Systems' }).collection).toBe('PL/Type Systems')
    expect(normalizeItemQuery({ search: 'SRCHAAAA' }).search).toBe('SRCHAAAA')
    try {
      normalizeItemQuery({ collection: 'bad\nnewline' })
      expect.unreachable()
    } catch (error) {
      expect((error as ZoteroError).code).toBe('invalid_input')
    }
    try {
      normalizeItemQuery({ search: '   ' })
      expect.unreachable()
    } catch (error) {
      expect((error as ZoteroError).code).toBe('invalid_input')
    }
  })
})

describe('response header parsing', () => {
  it('reads Total-Results', () => {
    expect(parseTotalResults('123')).toBe(123)
    expect(parseTotalResults(null)).toBeUndefined()
    expect(parseTotalResults('not-a-number')).toBeUndefined()
    expect(parseTotalResults('-4')).toBeUndefined()
  })

  it('parses Link header pagination targets', () => {
    const link = [
      '<http://127.0.0.1:23119/api/users/0/items/top?limit=25&start=25>; rel="next"',
      '<http://127.0.0.1:23119/api/users/0/items/top?limit=25&start=50>; rel="last"',
    ].join(', ')
    const parsed = parseLinkHeader(link)
    expect(parsed.next).toEqual({ start: 25, limit: 25 })
    expect(parsed.last).toEqual({ start: 50, limit: 25 })
    expect(parsed.first).toBeUndefined()
  })

  it('tolerates missing or malformed Link headers', () => {
    expect(parseLinkHeader(null)).toEqual({})
    expect(parseLinkHeader('garbage')).toEqual({})
  })
})

describe('ZoteroError', () => {
  it('carries a code and details without leaking secrets', () => {
    const error = new ZoteroError('not_found', 'No item with key PAPERAAA.', { library: 'user' })
    expect(error.code).toBe('not_found')
    expect(error.details).toEqual({ library: 'user' })
    expect(error.name).toBe('ZoteroError')
    expect(error.message).not.toMatch(/key=/i)
  })
})
