<p align="center">
  <img src="icon.svg" width="72" alt="DSH Zotero plugin icon">
</p>

# DSH Zotero Plugin

**English** | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-%40hanxu131%2Fdsh--zotero--0.2.0-CB3837.svg)](https://www.npmjs.com/package/@hanxu131/dsh-zotero)
[![DSH Desktop](https://img.shields.io/badge/DSH_Desktop-%E2%89%A5_0.2.1--rc.1%2C_%3C_0.3.0-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Zotero](https://img.shields.io/badge/Zotero-10%2B-CC2936.svg)](https://www.zotero.org/)

A standalone [Zotero](https://www.zotero.org/) plugin for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).
It adds a right-sidebar tab in DSH for browsing and working with your local
Zotero library — search, item details, a PDF reader with annotations and
highlights, citations — and exposes 19 agent tools so the chat assistant can
do the same on your behalf.

## Features

- **Library browsing** — personal and group libraries, collection tree, saved
  searches, sorting and pagination.
- **Search** — metadata (`titleCreatorYear`) and full-text (`everything`)
  modes, tag filters, ranked results.
- **Item details** — creators, fields, abstract, tags, child notes
  (sanitized), attachments, and PDF annotations with page jumps.
- **PDF reader** — rendered in the sidebar with page navigation, zoom,
  page labels, user annotations, and agent highlights overlaid in the same
  layer; select text to quote it into the chat as a citation.
- **Chat integration** — *Add to chat* inserts an item or a quoted PDF
  passage into the current draft without sending it; *Ask* submits a
  question about the selected item. Both use DSH's official session input
  interface.
- **Bibliography export** — BibTeX and RIS via Zotero's own exporter,
  downloadable in the browser or written to the workspace as `.bib`.
- **Metadata import** — create items from a DOI or arXiv identifier
  (fetched from doi.org / arXiv after approval), with optional PDF download.
- **Deep links** — open items in Zotero or jump to a PDF page via
  `zotero://` links (server-constructed, platform allow-listed commands).
- **UI languages** — Simplified Chinese and English, following the DSH host
  language.

## Requirements

- DSH Desktop `>=0.2.1-rc.1 <0.3.0-0`
- [Zotero](https://www.zotero.org/) 10 or later, with the local API enabled
  (see Quick Start)
- The plugin is designed to be cross-platform; only macOS has been verified
  on real hardware so far (see [Verification Status](#verification-status)).

## Installation

From npm (recommended):

```bash
dsh plugin --profile desktop add @hanxu131/dsh-zotero
```

From a local checkout (symlink install; the mapping lives in
[cordis.patch.yml](cordis.patch.yml)):

```bash
dsh plugin --profile desktop add link:/path/to/zoteroplugin-dsh
```

After installing, fully quit DSH and start it again so the plugin's host
half (agent tools and routes) is loaded. Uninstall or disable it from the
DSH plugin management page.

## Quick Start

1. In Zotero, open **Settings → Advanced** and enable
   **"Allow other applications on this computer to communicate with
   Zotero"**. Keep Zotero running.
2. Install the plugin as shown above, then **fully quit and restart DSH**.
3. In DSH, open the right-panel guide page and click the **Zotero library**
   entry. The tab shows the connection status first; if Zotero is not
   reachable, it walks you through the steps above.
4. Browse, search, and read. Reads never modify your library.
   Agent-initiated writes go through two gates: a DSH approval prompt
   first, then Zotero's own authorization dialog on first use. Explicit
   write actions you take in the sidebar (such as saving highlights) skip
   the approval prompt but still pass through Zotero's authorization.

The UI language (中文 / English) follows the DSH host language.

## Configuration

The plugin has a single setting:

| Setting | Default | Description |
| --- | --- | --- |
| `localApiBaseUrl` | `http://127.0.0.1:23119` | Base URL of the Zotero local API. Loopback addresses only; other hosts are rejected. |

The default is set in [cordis.patch.yml](cordis.patch.yml), which mounts the
plugin into a DSH profile. There is nothing else to configure.

## Agent Tools

19 tools are registered with the DSH agent. Read tools never change your
library; view tools drive the sidebar UI; write tools require a DSH approval
prompt and, on first use, Zotero's authorization dialog.

**Read-only**

| Tool | Description |
| --- | --- |
| `list_collections` | List the collection tree and saved searches of a library. |
| `search_library` | Search items (metadata or full-text mode) with tag filters, sorting, and pagination. |
| `get_item` | Fetch full metadata of one item: creators, fields, abstract, tags, attachments, notes. |
| `search_annotations` | Search the PDF annotations of an item by text or tag. |
| `cite` | Format a citation (APA) or return a BibTeX entry. |
| `read_fulltext` | Read a PDF's extracted text with page markers and a per-call character budget. |
| `find_in_pdf` | Find a word or phrase in a PDF and report physical page, page label, and context. |
| `export_bib` | Export BibTeX/RIS as text; optionally write a workspace-relative `.bib` file after approval. |

**View (drive the sidebar UI)**

| Tool | Description |
| --- | --- |
| `open_item` | Open an item or its best PDF in the panel, optionally at a page or quote. |
| `show_items` | Show a list of items in the panel. |
| `highlight` | Highlight a quoted passage in the reader as a session highlight; `save: true` also writes it to Zotero (write approval). |
| `clear_highlights` | Remove session highlights only. Never deletes annotations in Zotero. |

**Write (DSH approval + Zotero authorization)**

| Tool | Description |
| --- | --- |
| `save_highlights` | Save session highlights as Zotero annotations. |
| `add_item` | Create an item from structured fields or a DOI/arXiv identifier; optionally download and attach a PDF. Duplicate DOIs are detected. |
| `update_item` | Update fields of an existing item. |
| `add_note` | Add a child note to an item. |
| `create_collection` | Create a collection. |
| `attach_pdf` | Attach a PDF to an item from a local path, an SSRF-guarded URL, or inline bytes. |
| `authorize_writes` | Request or verify Zotero write authorization. |

## Security

- **Loopback only.** The Zotero base URL is validated to be a loopback
  address; the client never holds credentials and never talks to Zotero
  directly — all traffic flows through the plugin's authenticated host
  routes inside DSH.
- **Two gates on agent writes.** Agent-initiated writes require an
  explicit DSH approval prompt and then Zotero's own authorization dialog
  (see [ADR 0003](docs/adr/0003-differentiated-write-approval.md)).
  Explicit UI actions in the sidebar skip the approval prompt but still
  pass through the same Zotero authorization.
- **File safety.** PDF paths come only from Zotero-resolved attachment
  keys — the routes never accept arbitrary paths; symlink-swap races are
  mitigated with double resolution plus `realpath` comparison, and files are
  validated (`%PDF-` magic, size cap) and read in chunks. `export_bib` can
  only write workspace-relative `.bib` files; absolute paths, `..`
  segments, and symlink escapes are rejected.
- **SSRF guard.** External downloads (DOI/arXiv metadata, PDF URLs) allow
  only public http(s) URLs; DNS results are classified per-address and
  loopback/private/link-local ranges are rejected before connecting, with
  per-hop re-checks on redirects plus size, timeout, and file-magic limits.

## Verification Status

Honest summary; the full development and acceptance log (in Chinese) is in
[docs/development-status.md](docs/development-status.md).

- **Automated**: the repository ships a vitest suite (fake Zotero HTTP
  server, injected filesystem/spawn/network seams) plus a smoke script;
  `npm run verify` runs typecheck, tests, build, and smoke together.
- **Verified on real hardware (read-only)**: macOS with DSH Desktop
  0.2.1-rc.5 — library browsing (803 items), search, item details, PDF
  rendering, and draft insertion were exercised against a real Zotero
  library without writing to it.
- **Automated coverage only, not yet exercised on real hardware**: real
  Zotero writes and the authorization dialog, an actual *Ask* send, live
  DOI/arXiv imports, `zotero://` deep links, real workspace export, and
  write-upload endpoints.
- **Windows/Linux**: not verified on real machines.

## Development

Requires Node `^22.19.0 || >=24`.

```bash
npm install
npm run verify     # typecheck && test && build && smoke
npm run watch      # incremental client-side bundle build
```

Individual steps: `npm run typecheck`, `npm run test`, `npm run build`,
`npm run smoke`.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/implementation-spec.md](docs/implementation-spec.md) | Full implementation spec: feature list, DSH/Zotero contracts, test seams, milestone acceptance matrix, non-goals. |
| [docs/adr/](docs/adr/) | Three architecture decisions: local API + Zotero 10 ([0001](docs/adr/0001-local-api-only-zotero-10.md)), two-half plugin + webServer + single right tab ([0002](docs/adr/0002-dsh-two-halves-webserver-single-right-tab.md)), differentiated write approval ([0003](docs/adr/0003-differentiated-write-approval.md)). |
| [docs/development-status.md](docs/development-status.md) | Detailed development record: implementation notes, milestone log, real-machine acceptance status, load-contract and troubleshooting notes (Chinese). |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Apache-2.0 notices and third-party material registry. |

### Troubleshooting

- The tab loads but shows "cannot reach the plugin host routes": the host
  half needs the plugin to be reloaded — fully restart DSH.
- Connection status says Zotero is unreachable: make sure Zotero 10+ is
  running and the local API setting (Quick Start step 1) is enabled.
- `node scripts/probe-desktop.mjs [port]` is a read-only diagnostic that
  checks the running Desktop's `/dsh-zotero/health`, `/status`, and bundle
  URLs (loopback GET requests only).

## License

[Apache-2.0](LICENSE). Parts of the data layer and metadata import were
ported and adapted from the official ZCode Zotero plugin
([zai-org/zcode-plugins](https://github.com/zai-org/zcode-plugins)
`ui-plugins/zotero`, Apache-2.0, modifications noted); the rest is original.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.
