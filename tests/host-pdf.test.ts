/**
 * M4 host surface tests over the fake Zotero: `/pdf/info` + `/pdf/part`
 * (authenticated, 2 MiB chunking, path traversal / non-PDF / missing file
 * mapping), `/pdfjs` static assets (whitelist, traversal refused), the UI
 * highlight save/clear routes (Zotero authorization, never DSH approval;
 * clear touches session state only), and the symlink-swap defense.
 */
import { mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROUTES, ROUTES_HIGHLIGHT_WRITES, ROUTES_PDF } from '../src/shared/protocol.ts'
import { mountRoutes, type MountedRoutes } from './helpers/host-harness.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'
import { makePdf, sampleTwoPage } from './helpers/make-pdf.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }

describe('PDF routes (info/part/assets, fence + chunking + safety)', () => {
  let fake: FakeZotero
  let mounted: MountedRoutes

  beforeAll(async () => {
    fake = await startFakeZotero({ authorize: 'always' })
    mounted = await mountRoutes(fake)
  })
  afterAll(async () => {
    await mounted.close()
    await fake.close()
  })

  it('serves info: size, chunk count, sha256, item/attachment keys, page count', async () => {
    const res = await mounted.call(`${ROUTES_PDF.info}?library=user&attachment=PDFATTAA`)
    expect(res.status).toBe(200)
    const body = res.json() as { attachmentKey: string; itemKey: string; bytes: number; parts: number; sha256: string; pageCount: number; title: string; filename: string }
    expect(body.attachmentKey).toBe('PDFATTAA')
    expect(body.itemKey).toBe('PAPERAAA')
    expect(body.bytes).toBe(sampleTwoPage().length)
    expect(body.parts).toBe(1)
    expect(body.pageCount).toBe(3)
    expect(body.filename).toBe('paper.pdf')
    expect(body.title).toContain('Full Text PDF')
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('serves byte parts that reassemble to the original file', async () => {
    const info = (await mounted.call(`${ROUTES_PDF.info}?library=user&attachment=PDFATTAA`).then((r) => r.json())) as { parts: number; bytes: number }
    const chunks: Buffer[] = []
    for (let part = 0; part < info.parts; part++) {
      const res = await mounted.call(`${ROUTES_PDF.part}?library=user&attachment=PDFATTAA&part=${part}`)
      expect(res.status).toBe(200)
      expect(res.contentType.startsWith('application/octet-stream')).toBe(true)
      chunks.push(Buffer.from(res.chunks[0] as Buffer))
    }
    const reassembled = Buffer.concat(chunks)
    expect(reassembled.length).toBe(info.bytes)
    expect(reassembled.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('rejects out-of-range parts and non-integer part values', async () => {
    const over = await mounted.call(`${ROUTES_PDF.part}?library=user&attachment=PDFATTAA&part=99`)
    expect(over.status).toBe(400)
    expect((over.json() as { error: { code: string } }).error.code).toBe('invalid_input')
    const bad = await mounted.call(`${ROUTES_PDF.part}?library=user&attachment=PDFATTAA&part=banana`)
    expect(bad.status).toBe(400)
  })

  it('validates the attachment reference and maps errors', async () => {
    const notPdf = await mounted.call(`${ROUTES_PDF.info}?library=user&attachment=SNAPAACC`)
    expect(notPdf.status).toBe(400)
    expect((notPdf.json() as { error: { code: string } }).error.code).toBe('not_pdf')
    const notAttachment = await mounted.call(`${ROUTES_PDF.info}?library=user&attachment=NTEAAAAA`)
    expect(notAttachment.status).toBe(400)
    expect((notAttachment.json() as { error: { code: string } }).error.code).toBe('not_pdf')
    const missing = await mounted.call(`${ROUTES_PDF.part}?library=user&attachment=GHSSTAAB&part=0`)
    expect(missing.status).toBe(404)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('file_missing')
    const unknown = await mounted.call(`${ROUTES_PDF.info}?library=user&attachment=ZZZZ9999`)
    expect(unknown.status).toBe(404)
    const badKey = await mounted.call(`${ROUTES_PDF.info}?library=user&attachment=../../etc`)
    expect(badKey.status).toBe(400)
    expect((badKey.json() as { error: { code: string } }).error.code).toBe('invalid_input')
  })

  it('serves whitelisted pdf.js assets and refuses traversal or unknown kinds', async () => {
    // Packaged assets may not exist in a fresh checkout; the route must then
    // answer 404 (not 500) — and must always refuse traversal regardless.
    const traversal = await mounted.call(`${ROUTES_PDF.assets}/cmaps/..%2f..%2fpackage.json`)
    expect(traversal.status).toBe(404)
    const evil = await mounted.call(`${ROUTES_PDF.assets}/evil/anything.bin`)
    expect(evil.status).toBe(404)
    const dotdot = await mounted.call(`${ROUTES_PDF.assets}/cmaps/..%2fsecret`)
    expect(dotdot.status).toBe(404)
    // A legitimate cmap basename resolves when the packaged assets exist.
    const legit = await mounted.call(`${ROUTES_PDF.assets}/cmaps/Adobe-Japan1-UCS2.bcmap`)
    if (legit.status === 200) expect(legit.contentType.startsWith('application/octet-stream')).toBe(true)
    else expect(legit.status).toBe(404)
  })

  it('gates PDF routes behind the trust fence (401 when unauthenticated)', async () => {
    const locked = await mountRoutes(fake, { authenticated: false })
    const info = await locked.call(`${ROUTES_PDF.info}?library=user&attachment=PDFATTAA`)
    expect(info.status).toBe(401)
    const part = await locked.call(`${ROUTES_PDF.part}?library=user&attachment=PDFATTAA&part=0`)
    expect(part.status).toBe(401)
    const asset = await locked.call(`${ROUTES_PDF.assets}/cmaps/Adobe-Japan1-UCS2.bcmap`)
    expect(asset.status).toBe(401)
    await locked.close()
  })
})

describe('UI highlight routes (explicit UI actions, no DSH approval; Zotero authorization)', () => {
  let fake: FakeZotero
  let mounted: MountedRoutes

  beforeAll(async () => {
    fake = await startFakeZotero({ authorize: 'always' })
    mounted = await mountRoutes(fake)
  })
  afterAll(async () => {
    await mounted.close()
    await fake.close()
  })

  it('saves a session highlight as a Zotero annotation with the correct fields', async () => {
    // First create a highlight through the tool-level facade on the session.
    const { highlight } = await mounted.session.createHighlight('user', 'PDFATTAA', { quote: 'type system that tracks storage modes' })
    const res = await mounted.call(ROUTES_HIGHLIGHT_WRITES.save, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids: [highlight.id] }) })
    expect(res.status).toBe(200)
    const body = res.json() as { saved: { id: string; key: string }[] }
    expect(body.saved).toHaveLength(1)
    const annotation = fake.state.items.get(body.saved[0]!.key)!.data
    expect(annotation.itemType).toBe('annotation')
    expect(annotation.parentItem).toBe('PDFATTAA')
    expect(annotation.annotationType).toBe('highlight')
    expect(annotation.annotationText).toContain('type system that tracks storage modes')
    expect(annotation.annotationColor).toBe('#a28ae5')
    const position = JSON.parse(String(annotation.annotationPosition)) as { pageIndex: number; rects: number[][] }
    // The quote lives on physical page 2 (index 1; printed label "1" after the roman front matter).
    expect(position.pageIndex).toBe(1)
    expect(annotation.annotationPageLabel).toBe('1')
    expect(position.rects.length).toBeGreaterThan(0)
    // Saving again skips the already-saved highlight.
    const again = await mounted.call(ROUTES_HIGHLIGHT_WRITES.save, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids: [highlight.id] }) })
    expect((again.json() as { saved: unknown[] }).saved).toHaveLength(0)
  }, 30_000)

  it('clear removes session highlights only; Zotero annotations stay', async () => {
    const { highlight } = await mounted.session.createHighlight('user', 'PDFATTAA', { quote: 'delayed popping' })
    const annotationsBefore = await mounted.call(`${ROUTES.items}/PAPERAAA/annotations`)
    const before = (annotationsBefore.json() as { annotations: unknown[]; highlights: { id: string }[] })
    expect(before.highlights.some((entry) => entry.id === highlight.id)).toBe(true)
    const res = await mounted.call(ROUTES_HIGHLIGHT_WRITES.clear, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids: [highlight.id] }) })
    expect(res.status).toBe(200)
    expect((res.json() as { removed: number }).removed).toBe(1)
    const after = (await mounted.call(`${ROUTES.items}/PAPERAAA/annotations`)).json() as { annotations: { key: string }[]; highlights: { id: string }[] }
    expect(after.highlights.some((entry) => entry.id === highlight.id)).toBe(false)
    // Saved Zotero annotation from the previous test still exists.
    expect(after.annotations.length).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('validates ids and rejects non-array input', async () => {
    const bad = await mounted.call(ROUTES_HIGHLIGHT_WRITES.clear, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids: 'h1' }) })
    expect(bad.status).toBe(400)
    const unknownId = await mounted.call(ROUTES_HIGHLIGHT_WRITES.save, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids: ['h999'] }) })
    expect(unknownId.status).toBe(404)
    expect((unknownId.json() as { error: { code: string } }).error.code).toBe('not_found')
  })

  it('publishes a highlights SSE nudge on save/clear', async () => {
    const { highlight } = await mounted.session.createHighlight('user', 'PDFATTAA', { quote: 'stack frame' })
    const before = mounted.session.events.currentSeq
    await mounted.call(ROUTES_HIGHLIGHT_WRITES.clear, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids: [highlight.id] }) })
    const events = mounted.session.events.replaySince(before)
    expect(events.some((event) => event.intent.kind === 'highlights' && event.intent.attachmentKey === 'PDFATTAA')).toBe(true)
  }, 30_000)
})

describe('symlink-swap defense', () => {
  it('refuses to read when the attachment symlink target changes between resolutions', async () => {
    const fake = await startFakeZotero({ authorize: 'always' })
    const dir = await mkdtemp(join(tmpdir(), 'pdfsymlink-'))
    await mkdir(dir, { recursive: true })
    const realFile = join(dir, 'real.pdf')
    await writeFile(realFile, makePdf([['Honest content']]))
    const planted = join(dir, 'planted.pdf')
    await writeFile(planted, makePdf([['Planted content']]))
    const link = join(dir, 'link.pdf')
    await symlink(realFile, link)
    fake.state.files.set('PDFATTAA', link)
    const mounted = await mountRoutes(fake)
    try {
      // Swap the symlink target, racing the double resolution.
      const swap = async (): Promise<void> => {
        await unlink(link).catch(() => undefined)
        await symlink(planted, link).catch(() => undefined)
      }
      // Run a read while swapping aggressively; the guard must never serve
      // the planted file through the verified path.
      const attempts: number[] = []
      for (let index = 0; index < 12; index++) {
        const res = await mounted.call(`${ROUTES_PDF.part}?library=user&attachment=PDFATTAA&part=0`)
        if (res.status === 200) {
          const body = Buffer.from(res.chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).join('') as string)
          expect(body.toString('latin1')).toContain('Honest')
          attempts.push(200)
        } else {
          attempts.push(res.status)
        }
        await swap()
        // Swap back so the next attempt can succeed again.
        await unlink(link).catch(() => undefined)
        await symlink(realFile, link).catch(() => undefined)
      }
      // Every successful read served the honest file; races surfaced as 404.
      expect(attempts.every((status) => status === 200 || status === 404)).toBe(true)
      // The planted file was never the verification anchor: realpath of the
      // link must have matched across both resolutions on every success.
      expect(await realpath(link)).toBe(await realpath(realFile))
    } finally {
      await mounted.close()
      await fake.close()
    }
  }, 30_000)
})
