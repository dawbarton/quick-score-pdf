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

// ── PDF rendering ──────────────────────────────────────────────────────────────
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
const DEFAULT_SCALE = 1.5;

let currentScale = DEFAULT_SCALE;
let currentPdfDoc = null;
let renderingPdf = false;
let pendingPath = null;

function updateZoomLabel() {
  document.getElementById('zoom-level').textContent = Math.round(currentScale * 100) + '%';
}

async function renderPages(resetScroll = true) {
  if (!currentPdfDoc) return;

  const scrollRatio = resetScroll ? 0
    : pdfContainer.scrollTop / (pdfContainer.scrollHeight || 1);

  pdfContainer.innerHTML = '';
  for (let i = 1; i <= currentPdfDoc.numPages; i++) {
    const page = await currentPdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: currentScale });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pdfContainer.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }

  pdfContainer.scrollTop = resetScroll ? 0 : scrollRatio * pdfContainer.scrollHeight;
  updateZoomLabel();
}

async function zoomBy(delta) {
  if (!currentPdfDoc) return;
  const idx = ZOOM_STEPS.findIndex(s => s >= currentScale);
  const next = delta > 0
    ? ZOOM_STEPS[Math.min(idx + 1, ZOOM_STEPS.length - 1)]
    : ZOOM_STEPS[Math.max(idx - 1, 0)];
  if (next === currentScale) return;
  currentScale = next;
  await renderPages(false);
}

async function zoomReset() {
  if (!currentPdfDoc) return;
  currentScale = DEFAULT_SCALE;
  await renderPages(false);
}

async function renderPdf(filePath) {
  if (renderingPdf) { pendingPath = filePath; return; }
  renderingPdf = true;

  pdfContainer.classList.add('hidden');
  noFileEl.style.display = 'none';
  pdfLoading.classList.remove('hidden');
  currentPdfDoc = null;

  try {
    const url = convertFileSrc(filePath);
    const response = await fetch(url);
    const data = await response.arrayBuffer();
    currentPdfDoc = await pdfjsLib.getDocument({ data }).promise;
    await renderPages(true);
    pdfLoading.classList.add('hidden');
    pdfContainer.classList.remove('hidden');
  } catch (err) {
    console.error('PDF render error:', err);
    pdfLoading.classList.add('hidden');
    noFileEl.style.display = 'flex';
    noFileEl.textContent = 'Failed to load PDF';
  }

  renderingPdf = false;
  if (pendingPath) {
    const next = pendingPath;
    pendingPath = null;
    await renderPdf(next);
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
    li.innerHTML = `<span class="dot"></span><span class="fname" title="${file.name}">${file.name}</span>`;
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
  if (currentIndex === null || !session) return;
  const name = session.files[currentIndex].name;
  fileViewState.set(name, { scale: currentScale, scrollTop: pdfContainer.scrollTop });
}

async function openFile(index) {
  saveCurrentViewState();

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

  const filePath = await invoke('get_pdf_url', { filename: file.name });
  await renderPdf(filePath);

  // Always set scroll explicitly — never inherit the previous file's position
  pdfContainer.scrollTop = saved ? saved.scrollTop : 0;
}

// ── Scoring ────────────────────────────────────────────────────────────────────
async function applyScore(score) {
  if (currentIndex === null) return;
  const file = session.files[currentIndex];
  const updated = await invoke('set_score', { filename: file.name, score });
  renderSession(updated);
  currentIndex = updated.files.findIndex(f => f.name === file.name);

  const nextUnscored = findNextUnscored(currentIndex);
  if (nextUnscored !== null) await openFile(nextUnscored);
  else showDone(updated);
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
  const file = session.files[currentIndex];
  const note = noteInput.value;
  try {
    await invoke('set_note', { filename: file.name, note });
    session.files[currentIndex] = { ...file, note: note || null };
  } catch (e) {
    console.error('Failed to save note:', e);
  }
});

// ── File click ─────────────────────────────────────────────────────────────────
async function onFileClick(i) {
  await openFile(i);
}

// ── Export ─────────────────────────────────────────────────────────────────────
async function doExport() {
  try { await invoke('export_csv'); }
  catch (e) { if (e !== 'cancelled') console.error(e); }
}

// ── Folder selection ───────────────────────────────────────────────────────────
async function openFolder() {
  try {
    const s = await invoke('select_folder');
    currentIndex = null;
    currentScale = DEFAULT_SCALE;
    fileViewState.clear();
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
  } catch (e) {
    if (e !== 'cancelled') console.error(e);
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
  }
  if (e.key === '?') { e.preventDefault(); toggleShortcuts(); return; }
  if (key === 'escape') {
    closeShortcuts();
    doneOverlay.classList.add('hidden');
    return;
  }

  // Everything below requires no overlay open and a file selected
  if (!shortcutsOverlay.classList.contains('hidden')) return;
  if (currentIndex === null) return;

  // Scoring
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
document.getElementById('done-review-btn').addEventListener('click', () => doneOverlay.classList.add('hidden'));
document.getElementById('zoom-in-btn').addEventListener('click',    () => zoomBy(+1));
document.getElementById('zoom-out-btn').addEventListener('click',   () => zoomBy(-1));
document.getElementById('zoom-reset-btn').addEventListener('click', () => zoomReset());
document.querySelectorAll('.score-btn[data-score]').forEach(btn =>
  btn.addEventListener('click', () => applyScore(btn.dataset.score)));
document.getElementById('clear-btn').addEventListener('click', async () => {
  if (currentIndex === null) return;
  const file = session.files[currentIndex];
  const updated = await invoke('set_score', { filename: file.name, score: null });
  renderSession(updated);
  currentIndex = updated.files.findIndex(f => f.name === file.name);
  updateScoreButtons(null);
});

// ── CLI startup ────────────────────────────────────────────────────────────────
(async () => {
  try {
    const s = await invoke('get_cli_session');
    if (!s) return;
    currentIndex = null;
    currentScale = DEFAULT_SCALE;
    fileViewState.clear();
    renderSession(s);
    welcomeEl.classList.add('hidden');
    appEl.classList.remove('hidden');
    noFileEl.style.display = 'flex';
    noFileEl.textContent = 'Select a file from the list';
    pdfContainer.classList.add('hidden');
    noteInput.value = '';
    const first = s.files.findIndex(f => !f.score);
    if (first !== -1) await openFile(first);
    else if (s.files.length > 0) showDone(s);
  } catch (e) {
    console.error('CLI session error:', e);
  }
})();
