import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const { invoke, convertFileSrc } = window.__TAURI__.core;

window.addEventListener('unhandledrejection', e => console.error('Unhandled rejection:', e.reason));

// ── State ──────────────────────────────────────────────────────────────────────
let session = null;       // { folder, files: [{name, score, note}] }
let currentIndex = null;
const fileViewState = new Map(); // filename → { scale, scrollTop }

// ── DOM refs ───────────────────────────────────────────────────────────────────
const welcomeEl       = document.getElementById('welcome');
const appEl           = document.getElementById('app');
const folderNameEl    = document.getElementById('folder-name');
const fileListEl      = document.getElementById('file-list');
const pdfContainer    = document.getElementById('pdf-container');
const pdfLoading      = document.getElementById('pdf-loading');
const noFileEl        = document.getElementById('no-file');
const currentFilename = document.getElementById('current-filename');
const progressBar     = document.getElementById('progress-bar');
const progressText    = document.getElementById('progress-text');
const doneOverlay     = document.getElementById('done-overlay');
const doneSummary     = document.getElementById('done-summary');
const shortcutsOverlay = document.getElementById('shortcuts-overlay');
const noteInput       = document.getElementById('note-input');
const errorBanner     = document.getElementById('error-banner');
const errorText       = document.getElementById('error-text');

// ── Errors ─────────────────────────────────────────────────────────────────────
/** Show `message` in the banner until dismissed; `err` (a backend string or Error) is appended. */
function showError(message, err) {
  const detail = err === undefined ? '' : `: ${err?.message ?? err}`;
  errorText.textContent = message + detail;
  errorBanner.classList.remove('hidden');
  if (err !== undefined) console.error(message, err);
}
function hideError() { errorBanner.classList.add('hidden'); }

// ── PDF rendering ──────────────────────────────────────────────────────────────
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
const DEFAULT_SCALE = 1.5;

let currentScale = DEFAULT_SCALE;
// Invariant: non-null only once the document for currentIndex is loaded and on screen.
let currentPdfDoc = null;
// Bumped by every file open and zoom. Async work captures it at the start and abandons
// itself if it has changed, so a slow, superseded request can never overwrite the view.
let viewGen = 0;
// True while the PDF for currentIndex is being fetched and rendered; scoring is refused
// meanwhile, so a score can never be given to a file that is not yet on screen.
let pdfLoadInProgress = false;

function updateZoomLabel() {
  document.getElementById('zoom-level').textContent = Math.round(currentScale * 100) + '%';
}

/**
 * Render every page of `doc` off-screen, then swap them in. Returns false, leaving the
 * view untouched, if a newer open or zoom has started in the meantime.
 */
async function renderPages(doc, scale, gen, keepScrollRatio) {
  // Draw at device resolution and display at CSS size, so pages are sharp on Retina screens
  const ratio = window.devicePixelRatio || 1;
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    if (gen !== viewGen) return false;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    frag.appendChild(canvas);
    const transform = ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0];
    await page.render({ canvas, viewport, transform }).promise;
    if (gen !== viewGen) return false;
  }

  const scrollRatio = pdfContainer.scrollTop / (pdfContainer.scrollHeight || 1);
  pdfContainer.replaceChildren(frag);
  if (keepScrollRatio) pdfContainer.scrollTop = scrollRatio * pdfContainer.scrollHeight;
  return true;
}

async function rerenderAtScale(scale) {
  const doc = currentPdfDoc;
  const gen = ++viewGen;
  currentScale = scale;
  updateZoomLabel();
  try {
    await renderPages(doc, scale, gen, true);
  } catch (err) {
    if (gen === viewGen) console.error('PDF render error:', err);
  }
}

// Redraw when the window moves to a screen with a different pixel ratio
(function watchPixelRatio() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
    if (currentPdfDoc) rerenderAtScale(currentScale);
    watchPixelRatio();
  }, { once: true });
})();

async function zoomBy(delta) {
  if (!currentPdfDoc) return;
  const idx = ZOOM_STEPS.findIndex(s => s >= currentScale);
  const next = delta > 0
    ? ZOOM_STEPS[Math.min(idx + 1, ZOOM_STEPS.length - 1)]
    : ZOOM_STEPS[Math.max(idx - 1, 0)];
  if (next === currentScale) return;
  await rerenderAtScale(next);
}

async function zoomReset() {
  if (!currentPdfDoc) return;
  await rerenderAtScale(DEFAULT_SCALE);
}

/** Load and display `filename` at `scale`, then scroll to `scrollTop`. */
async function loadPdf(filename, scale, scrollTop, gen) {
  let doc = null;
  try {
    const filePath = await invoke('get_pdf_url', { filename });
    if (gen !== viewGen) return;
    const response = await fetch(convertFileSrc(filePath));
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${filename}`);
    const data = await response.arrayBuffer();
    if (gen !== viewGen) return;
    doc = await pdfjsLib.getDocument({ data }).promise;
    if (!(await renderPages(doc, scale, gen, false))) return;

    currentPdfDoc = doc;
    doc = null;  // now owned by currentPdfDoc; do not destroy below
    pdfLoadInProgress = false;
    pdfLoading.classList.add('hidden');
    pdfContainer.classList.remove('hidden');
    // Only possible once the container is displayed
    pdfContainer.scrollTop = scrollTop;
  } catch (err) {
    if (gen !== viewGen) return;
    console.error('PDF render error:', err);
    pdfLoadInProgress = false;
    pdfLoading.classList.add('hidden');
    noFileEl.style.display = 'flex';
    noFileEl.textContent = `Failed to load PDF: ${err?.message ?? err}`;
  } finally {
    doc?.destroy();
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────────
function renderSession(s) {
  session = s;
  folderNameEl.textContent = s.folder.split('/').pop() || s.folder;
  folderNameEl.title = s.folder;

  const total  = s.files.length;
  const scored = s.files.filter(f => f.score).length;
  const pct    = total ? Math.round((scored / total) * 100) : 0;
  progressBar.style.width = pct + '%';
  progressText.textContent = `${scored} / ${total}`;

  fileListEl.innerHTML = '';
  s.files.forEach((file, i) => {
    const li = document.createElement('li');
    li.className = 'file-item' + (file.score ? ` score-${file.score}` : '') + (i === currentIndex ? ' active' : '');
    li.dataset.index = i;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const fname = document.createElement('span');
    fname.className = 'fname';
    fname.title = file.name;
    fname.textContent = file.name;
    li.append(dot, fname);
    li.addEventListener('click', () => onFileClick(i));
    fileListEl.appendChild(li);
  });

  if (currentIndex !== null) updateScoreButtons(s.files[currentIndex]?.score ?? null);
}

function updateScoreButtons(score) {
  document.querySelectorAll('.score-btn[data-score]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.score === score);
  });
}

function saveCurrentViewState() {
  // While a file is still loading, the view does not show it, so there is nothing to save
  if (currentIndex === null || !session || !currentPdfDoc) return;
  const name = session.files[currentIndex].name;
  fileViewState.set(name, { scale: currentScale, scrollTop: pdfContainer.scrollTop });
}

async function openFile(index) {
  saveCurrentViewState();

  const gen = ++viewGen;
  currentPdfDoc?.destroy();
  currentPdfDoc = null;
  pdfLoadInProgress = true;
  pdfContainer.classList.add('hidden');
  noFileEl.style.display = 'none';
  pdfLoading.classList.remove('hidden');

  currentIndex = index;
  const file = session.files[index];
  currentFilename.textContent = file.name;
  updateScoreButtons(file.score ?? null);
  noteInput.value = file.note ?? '';

  document.querySelectorAll('.file-item').forEach((li, i) =>
    li.classList.toggle('active', i === index));
  fileListEl.querySelector('.file-item.active')?.scrollIntoView({ block: 'nearest' });

  // Restore per-file view state, or use explicit defaults for files never seen before
  const saved = fileViewState.get(file.name);
  currentScale = saved ? saved.scale : DEFAULT_SCALE;
  updateZoomLabel();

  // Always set scroll explicitly — never inherit the previous file's position
  await loadPdf(file.name, currentScale, saved ? saved.scrollTop : 0, gen);
}

// ── Scoring ────────────────────────────────────────────────────────────────────
let scoreInFlight = false;

async function applyScore(score) {
  // Only score the file actually on screen, and one score at a time
  if (currentIndex === null || pdfLoadInProgress || scoreInFlight) return;
  scoreInFlight = true;
  try {
    const file = session.files[currentIndex];
    let updated;
    try {
      updated = await invoke('set_score', { filename: file.name, score });
    } catch (e) {
      showError(`Could not save the score for ${file.name}`, e);
      return;
    }
    renderSession(updated);
    currentIndex = updated.files.findIndex(f => f.name === file.name);

    const nextUnscored = findNextUnscored(currentIndex);
    if (nextUnscored === null) { showDone(updated); return; }
    scoreInFlight = false;  // openFile sets pdfLoadInProgress, which now blocks scoring
    await openFile(nextUnscored);
  } finally {
    scoreInFlight = false;
  }
}

function findNextUnscored(fromIndex) {
  const files = session.files;
  for (let i = fromIndex + 1; i < files.length; i++) if (!files[i].score) return i;
  for (let i = 0; i < fromIndex; i++) if (!files[i].score) return i;
  return null;
}

// ── Done overlay ───────────────────────────────────────────────────────────────
function showDone(s) {
  const counts = { green: 0, amber: 0, red: 0 };
  s.files.forEach(f => { if (f.score) counts[f.score]++; });
  doneSummary.textContent =
    `${s.files.length} files scored — ${counts.green} green, ${counts.amber} amber, ${counts.red} red.`;
  doneOverlay.classList.remove('hidden');
}

// ── Note saving ────────────────────────────────────────────────────────────────
let noteOriginalValue = '';

noteInput.addEventListener('focus', () => {
  noteOriginalValue = noteInput.value;
});

noteInput.addEventListener('blur', async () => {
  if (currentIndex === null) return;
  // Capture the name now: blur fires on mousedown, and the click that follows may change
  // currentIndex (and even replace session) before the save completes
  const { name, note: oldNote } = session.files[currentIndex];
  const note = noteInput.value;
  if (note === (oldNote ?? '')) return;
  try {
    await invoke('set_note', { filename: name, note });
    const file = session.files.find(f => f.name === name);
    if (file) file.note = note || null;
  } catch (e) {
    showError(`Could not save the note for ${name}`, e);
  }
});

// ── File click ─────────────────────────────────────────────────────────────────
async function onFileClick(i) {
  await openFile(i);
}

// ── Export ─────────────────────────────────────────────────────────────────────
async function doExport() {
  try { await invoke('export_csv'); }
  catch (e) { if (e !== 'cancelled') showError('Could not export the CSV', e); }
}

// ── Session startup ────────────────────────────────────────────────────────────
async function startSession(s) {
  // Abandon any load or zoom still running from the previous session
  ++viewGen;
  currentPdfDoc?.destroy();
  currentPdfDoc = null;
  pdfLoadInProgress = false;
  pdfLoading.classList.add('hidden');
  currentIndex = null;
  currentScale = DEFAULT_SCALE;
  fileViewState.clear();
  hideError();
  if (s.warning) showError(s.warning);
  renderSession(s);
  welcomeEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  doneOverlay.classList.add('hidden');
  noFileEl.style.display = 'flex';
  noFileEl.textContent = 'Select a file from the list';
  pdfContainer.classList.add('hidden');
  noteInput.value = '';

  const first = s.files.findIndex(f => !f.score);
  if (first !== -1) await openFile(first);
  else if (s.files.length > 0) showDone(s);
}

// ── Folder selection ───────────────────────────────────────────────────────────
async function openFolder() {
  try {
    const s = await invoke('select_folder');
    await startSession(s);
  } catch (e) {
    if (e !== 'cancelled') showError('Could not open the folder', e);
  }
}

// ── Shortcuts overlay ──────────────────────────────────────────────────────────
function toggleShortcuts() { shortcutsOverlay.classList.toggle('hidden'); }
function closeShortcuts()  { shortcutsOverlay.classList.add('hidden'); }

document.getElementById('shortcuts-btn').addEventListener('click', toggleShortcuts);
document.getElementById('welcome-shortcuts-btn').addEventListener('click', toggleShortcuts);
document.getElementById('shortcuts-close-btn').addEventListener('click', closeShortcuts);
shortcutsOverlay.addEventListener('click', e => { if (e.target === shortcutsOverlay) closeShortcuts(); });

// ── Keyboard shortcuts ─────────────────────────────────────────────────────────
document.addEventListener('keydown', async (e) => {
  const key = e.key.toLowerCase();

  // If focus is in the note textarea, handle Escape (cancel) and Cmd+Enter (save)
  if (e.target === noteInput) {
    if (key === 'escape') {
      e.preventDefault();
      noteInput.value = noteOriginalValue; // revert
      noteInput.blur();
    } else if (key === 'enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      noteInput.blur(); // triggers save via blur handler
    }
    return;
  }

  // Global shortcuts — always active
  if (e.metaKey || e.ctrlKey) {
    if (key === 'o') { e.preventDefault(); openFolder(); return; }
    if (key === 'e') { e.preventDefault(); doExport(); return; }
    // Leave every other Cmd/Ctrl combination (Cmd+R, Cmd+A, …) alone, except zoom
    if (!['+', '=', '-', '0'].includes(key)) return;
  }
  if (e.key === '?') { e.preventDefault(); toggleShortcuts(); return; }
  if (key === 'escape') {
    hideError();
    closeShortcuts();
    doneOverlay.classList.add('hidden');
    return;
  }

  // Everything below requires no overlay open and a file selected
  if (!shortcutsOverlay.classList.contains('hidden')) return;
  if (currentIndex === null) return;

  // Scoring (never on key repeat, so holding a key cannot score a run of unseen files)
  if (e.repeat && ['1', '2', '3', 'g', 'a', 'r'].includes(key)) { e.preventDefault(); return; }
  if      (key === '1' || key === 'g') { e.preventDefault(); await applyScore('green'); }
  else if (key === '2' || key === 'a') { e.preventDefault(); await applyScore('amber'); }
  else if (key === '3' || key === 'r') { e.preventDefault(); await applyScore('red'); }

  // Note
  else if (key === 'n') { e.preventDefault(); noteInput.focus(); }

  // File navigation — left/right
  else if (key === 'arrowleft') {
    e.preventDefault();
    await openFile((currentIndex - 1 + session.files.length) % session.files.length);
  }
  else if (key === 'arrowright') {
    e.preventDefault();
    await openFile((currentIndex + 1) % session.files.length);
  }

  // PDF scroll — up/down
  else if (key === 'arrowup')   { e.preventDefault(); pdfContainer.scrollBy({ top: -200, behavior: 'smooth' }); }
  else if (key === 'arrowdown') { e.preventDefault(); pdfContainer.scrollBy({ top:  200, behavior: 'smooth' }); }

  // Zoom — +/- /0
  else if (key === '+' || key === '=') { e.preventDefault(); await zoomBy(+1); }
  else if (key === '-')                { e.preventDefault(); await zoomBy(-1); }
  else if (key === '0')                { e.preventDefault(); await zoomReset(); }
});

// ── Wire up static buttons ─────────────────────────────────────────────────────
document.getElementById('open-folder-btn').addEventListener('click', openFolder);
document.getElementById('change-folder-btn').addEventListener('click', openFolder);
document.getElementById('export-btn').addEventListener('click', doExport);
document.getElementById('done-export-btn').addEventListener('click', doExport);
document.getElementById('prev-btn').addEventListener('click', async () => {
  if (currentIndex === null) return;
  await openFile((currentIndex - 1 + session.files.length) % session.files.length);
});
document.getElementById('next-btn').addEventListener('click', async () => {
  if (currentIndex === null) return;
  await openFile((currentIndex + 1) % session.files.length);
});
document.getElementById('error-close-btn').addEventListener('click', hideError);
document.getElementById('done-review-btn').addEventListener('click', () => doneOverlay.classList.add('hidden'));
document.getElementById('zoom-in-btn').addEventListener('click',    () => zoomBy(+1));
document.getElementById('zoom-out-btn').addEventListener('click',   () => zoomBy(-1));
document.getElementById('zoom-reset-btn').addEventListener('click', () => zoomReset());
document.querySelectorAll('.score-btn[data-score]').forEach(btn =>
  btn.addEventListener('click', () => applyScore(btn.dataset.score)));
document.getElementById('clear-btn').addEventListener('click', async () => {
  if (currentIndex === null) return;
  const file = session.files[currentIndex];
  let updated;
  try {
    updated = await invoke('set_score', { filename: file.name, score: null });
  } catch (e) {
    showError(`Could not clear the score for ${file.name}`, e);
    return;
  }
  renderSession(updated);
  currentIndex = updated.files.findIndex(f => f.name === file.name);
  updateScoreButtons(null);
});

// ── CLI startup ────────────────────────────────────────────────────────────────
(async () => {
  try {
    const s = await invoke('get_cli_session');
    if (!s) return;
    await startSession(s);
  } catch (e) {
    showError('Could not open the files given on the command line', e);
  }
})();
