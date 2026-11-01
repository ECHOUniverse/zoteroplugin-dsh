/**
 * Minimal test PDF generator: Helvetica (WinAnsi) text, one text object per
 * line, optional page labels. Self-contained (no library) so tests stay
 * auditable and reproducible.
 *
 * Attribution: adapted from zai-org/zcode-plugins `ui-plugins/zotero`
 * `test/pdf-fixture.mjs` (repo LICENSE: Apache-2.0). Modifications: ported
 * to TypeScript with this project's structure; `sampleTwoPage()` returns a
 * two-page document with a cross-page-capable body, curly quotes and an
 * end-of-line hyphenation. See THIRD_PARTY_NOTICES.md.
 */

/** WinAnsi bytes (curly quotes ’ “ ” and dashes – —). */
function winAnsi(text: string): Buffer {
  const map: Record<string, number> = { '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97 }
  const bytes: number[] = []
  for (const char of text) {
    const code = map[char] ?? char.charCodeAt(0)
    if (code === 0x28 || code === 0x29 || code === 0x5c) bytes.push(0x5c)
    bytes.push(code > 255 ? 0x3f : code)
  }
  return Buffer.from(bytes)
}

export interface MakePdfOptions {
  /** Printed page labels: Nums entries. */
  labels?: { start: number; style: 'r' | 'D'; first?: number }[]
  width?: number
  height?: number
}

export function makePdf(pages: string[][], options: MakePdfOptions = {}): Buffer {
  const width = options.width ?? 612
  const height = options.height ?? 792
  const objects: Buffer[] = []
  const add = (body: Buffer): number => {
    objects.push(body)
    return objects.length
  }
  const font = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'))
  const pagesId = objects.length + 1
  objects.push(null as unknown as Buffer) // Pages placeholder
  const kids: number[] = []
  for (const lines of pages) {
    const parts = [Buffer.from('BT /F1 11 Tf 14 TL 72 720 Td\n')]
    for (const line of lines) parts.push(Buffer.from('('), winAnsi(line), Buffer.from(') Tj T*\n'))
    parts.push(Buffer.from('ET\n'))
    const stream = Buffer.concat(parts)
    const content = add(
      Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    )
    kids.push(
      add(
        Buffer.from(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
        ),
      ),
    )
  }
  objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`)
  const labels = options.labels
    ? ` /PageLabels << /Nums [${options.labels.map((label) => `${label.start} << /S /${label.style}${label.first !== undefined ? ` /St ${label.first}` : ''} >>`).join(' ')}] >>`
    : ''
  const catalog = add(Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R${labels} >>`))
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let length = chunks[0]!.length
  objects.forEach((body, index) => {
    offsets.push(length)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')])
    chunks.push(chunk)
    length += chunk.length
  })
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
  ].join('')
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`))
  return Buffer.concat(chunks)
}

/**
 * Two-page sample with a quote split across the page boundary, curly quotes,
 * end-of-line de-hyphenation and printed page labels (roman front matter).
 */
export function sampleTwoPage(): Buffer {
  return makePdf(
    [
      ['Preface', 'This front matter page carries a roman numeral label.'],
      [
        'Second-Class Values Revisited',
        'Abstract. We design a type system that tracks storage modes.',
        'When a function returns a stack-allocated value, we just don’t',
        'pop the stack! Instead, the stack frame is de-',
        'allocated together with a parent the next time.',
        'The “delayed popping” strategy reduces GC pressure.',
        'Continuing across the boundary: the evaluation section starts',
      ],
      ['Evaluation', 'Execution time improves between 10% and 25% with respect', 'to standard execution on our benchmarks.'],
    ],
    { labels: [{ start: 0, style: 'r' }, { start: 1, style: 'D' }] },
  )
}

/** A PDF with no text at all on its pages (scanned-paper stand-in). */
export function sampleScanned(): Buffer {
  return makePdf([[], []])
}
