# QuickScorePDF

A fast, keyboard-driven desktop application for scoring a set of PDF files green / amber / red. Scores, notes, and progress are saved automatically alongside the PDFs and can be exported as a CSV file.

---

## Features

- **PDF viewer** — renders PDFs via [pdf.js](https://mozilla.github.io/pdf.js/) with per-file zoom and scroll memory
- **Three-tier scoring** — green / amber / red, assignable by keyboard or button
- **Freetext notes** — attach a short note to any PDF; saved with scores and exported to CSV
- **Persistent state** — scores and notes are written to `quick-score-pdf.json` in the PDF folder; reopening the same folder resumes where you left off
- **Progress tracking** — sidebar progress bar shows how many files have been scored
- **CSV export** — one row per file: `filename`, `score`, `note`
- **Keyboard-first** — every action reachable without a mouse (see [Keyboard shortcuts](#keyboard-shortcuts))
- **CLI support** — launch with a directory or a list of PDF files as arguments

---

## Keyboard shortcuts

| Key(s) | Action |
|---|---|
| `1` / `G` | Score green |
| `2` / `A` | Score amber |
| `3` / `R` | Score red |
| `N` | Focus note editor |
| `Cmd+Enter` (in note) | Save note |
| `Escape` (in note) | Cancel note edit |
| `←` / `→` | Previous / next file |
| `↑` / `↓` | Scroll PDF up / down |
| `+` / `−` | Zoom in / out |
| `0` | Reset zoom |
| `Cmd+O` | Open / change folder |
| `Cmd+E` | Export CSV |
| `?` | Toggle shortcuts panel |
| `Escape` | Close overlay |

After scoring a file the app advances automatically to the next unscored file. When all files are scored a summary overlay is shown.

---

## Command-line usage

```sh
# Open a folder — all PDFs in the folder are loaded
quick-score-pdf /path/to/pdfs/

# Score a specific subset of PDFs
quick-score-pdf /path/to/pdfs/a.pdf /path/to/pdfs/b.pdf
```

In file-list mode only the named PDFs appear in the session; the `quick-score-pdf.json` state file records the subset so the same selection is restored on relaunch.

---

## State file (`quick-score-pdf.json`)

A JSON file written to the PDF folder whenever a score or note changes. Example:

```json
{
  "folder": "/Users/alice/papers",
  "scores": {
    "alpha.pdf": "green",
    "beta.pdf": null,
    "gamma.pdf": "red"
  },
  "notes": {
    "alpha.pdf": "Strong methodology, worth a second read.",
    "gamma.pdf": "Confounded results — see section 3."
  }
}
```

`null` scores mean unscored. The `notes` key is omitted when there are no notes. In file-list mode a `filter` key lists the selected filenames.

---

## Project structure

```
quick-score-pdf/
├── src-tauri/               # Rust / Tauri backend
│   ├── src/
│   │   ├── lib.rs           # All Tauri commands and session logic
│   │   └── main.rs          # Binary entry point
│   ├── Cargo.toml
│   ├── tauri.conf.json      # App config (window, CSP, asset protocol, icons)
│   └── icons/               # App icons (PNG, required by Tauri)
├── ui/                      # Vanilla HTML/CSS/JS frontend
│   ├── index.html           # Single-page layout (welcome, app, overlays)
│   ├── styles.css           # Dark-theme stylesheet
│   ├── main.js              # All frontend logic (ES module)
│   └── lib/
│       ├── pdf.min.mjs      # pdf.js library (committed, no build step)
│       └── pdf.worker.min.mjs
├── package.json             # Tauri CLI and pdfjs-dist dev dependencies
└── README.md
```

### Backend (`src-tauri/src/lib.rs`)

Written in Rust using [Tauri 2](https://v2.tauri.app/). Key types:

- **`Session`** — owns the folder path, optional file filter (CLI mode), `BTreeMap` of scores, and `BTreeMap` of notes. Serialises to `quick-score-pdf.json`.
- **`SessionView` / `FileEntry`** — read-only projections sent to the frontend via Tauri IPC.

Registered Tauri commands:

| Command | Description |
|---|---|
| `get_cli_session` | Parse CLI args and load/create a session on startup |
| `select_folder` | Open a native folder picker and load/create a session |
| `get_session` | Return the current session view |
| `set_score` | Update a file's score and persist |
| `set_note` | Update a file's note and persist |
| `get_pdf_url` | Resolve a filename to an absolute path for the asset protocol |
| `export_csv` | Open a native save dialog and write `filename,score,note` CSV |

### Frontend (`ui/main.js`)

Plain ES module — no framework, no bundler. Key state:

- `session` — mirror of the backend `SessionView`
- `currentIndex` — index of the currently open file
- `fileViewState` — `Map<filename, {scale, scrollTop}>` for per-file zoom/scroll memory

PDFs are fetched via Tauri's asset protocol (`convertFileSrc`) and rendered onto `<canvas>` elements by pdf.js. This keeps keyboard events in the main document (no cross-origin iframe focus issues).

---

## Building

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| [Rust](https://rustup.rs/) | stable | Install via `rustup` |
| Node.js | 18+ | For the Tauri CLI |
| Tauri CLI | v2 | Installed via `npm install` |

Platform-specific system dependencies are listed in the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

### Install Node dependencies

```sh
npm install
```

This installs the Tauri CLI and `pdfjs-dist`. The pdf.js build files in `ui/lib/` are already committed so no additional copy step is needed.

### Development (with hot-reload)

```sh
npm run dev
# or: npx tauri dev
```

Opens the app in a native window. The Rust backend recompiles on change; the frontend reloads on file save.

### Production build

```sh
npm run build
# or: npx tauri build
```

Output is placed in `src-tauri/target/release/`:

| Platform | Artefact(s) |
|---|---|
| **macOS** | `QuickScorePDF.app` bundle + `.dmg` installer (in `bundle/dmg/`) |
| **Windows** | `.exe` + NSIS `.exe` installer + `.msi` installer (in `bundle/`) |
| **Linux** | `.deb`, `.rpm`, and/or `.AppImage` (in `bundle/`) |

The release profile (`Cargo.toml`) enables LTO, single codegen unit, size optimisation (`opt-level = "s"`), and symbol stripping, keeping the binary small.

#### macOS — code signing and notarisation

To distribute outside the Mac App Store, set the following environment variables before `tauri build`:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
```

See the [Tauri code signing guide](https://v2.tauri.app/distribute/sign/macos/) for full details.

#### Windows — code signing

Set `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (or configure a certificate in `tauri.conf.json`). See the [Windows signing guide](https://v2.tauri.app/distribute/sign/windows/).

#### Cross-compilation

Tauri builds for the host platform only. To produce artefacts for other platforms use CI (e.g. GitHub Actions with `tauri-apps/tauri-action`) with runners for each target OS.

---

## Licence

MIT
