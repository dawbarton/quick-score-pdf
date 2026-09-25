// Stand-in for the Tauri bridge, loaded before main.js. Replies arrive after random delays
// (up to window.MAXDELAY ms), hence out of order, as they can from the real backend.
// Also installs small helpers on window.t for the test cases.
//
// Failures: set window.FAIL = { command: 'message' } to make a command reject, as Tauri does,
// with that string; get_pdf_url then returns a path that does not exist. At page load, use the
// query string instead: ?fail=command&warn=text (warn adds a load warning to the session).
(() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const state = {
    folder: '/test',
    files: Array.from({ length: 8 }, (_, i) => ({ name: `f${i + 1}.pdf`, score: null, note: null })),
  };
  const view = () => structuredClone(state);
  let inflight = 0;
  window.calls = [];
  const query = new URLSearchParams(location.search);
  window.FAIL = query.has('fail') ? { [query.get('fail')]: 'stub failure' } : {};

  window.__TAURI__ = { core: {
    convertFileSrc: p => p,
    async invoke(cmd, a = {}) {
      window.calls.push([cmd, a]);
      if (cmd === 'get_cli_session') {
        if (window.FAIL[cmd]) throw window.FAIL[cmd];
        return query.has('warn') ? { ...view(), warning: query.get('warn') } : view();
      }
      inflight++;
      try {
        await sleep(cmd === 'set_note' ? (window.NOTEDELAY ?? 0) : Math.random() * (window.MAXDELAY ?? 80));
        const f = a.filename && state.files.find(f => f.name === a.filename);
        if (cmd === 'get_pdf_url') return window.FAIL[cmd] ? 'pdfs/missing.pdf' : `pdfs/${a.filename}`;
        if (window.FAIL[cmd]) throw window.FAIL[cmd];
        if (cmd === 'set_score') { f.score = a.score; return view(); }
        if (cmd === 'set_note') { f.note = a.note || null; return; }
        throw new Error('stub: unknown command ' + cmd);
      } finally {
        inflight--;
      }
    },
  } };

  const $ = id => document.getElementById(id);
  window.t = {
    sleep,
    key: (key, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts })),
    row: i => document.querySelectorAll('.file-item')[i],
    scores: () => window.calls.filter(c => c[0] === 'set_score').map(c => `${c[1].filename}:${c[1].score}`),
    /** Wait until no replies are pending and no PDF is loading, and it stays so for 150 ms. */
    async settle(timeout = 5000) {
      const end = Date.now() + timeout;
      let quietSince = null;
      while (Date.now() < end) {
        const quiet = inflight === 0 && $('pdf-loading').classList.contains('hidden');
        quietSince = quiet ? (quietSince ?? Date.now()) : null;
        if (quietSince && Date.now() - quietSince >= 150) return;
        await sleep(20);
      }
      throw new Error('settle: timed out');
    },
    error: () => $('error-banner').classList.contains('hidden') ? null : $('error-text').textContent,
    /**
     * What is on screen: header, highlighted row, page placeholders (their number identifies
     * the file), and the canvases drawn so far with the file each was drawn from.
     */
    shown() {
      const pages = [...document.querySelectorAll('#pdf-container .pdf-page')];
      const canvases = [...document.querySelectorAll('#pdf-container canvas')];
      return {
        header: $('current-filename').textContent,
        active: document.querySelector('.file-item.active .fname')?.textContent ?? null,
        pages: pages.length,
        drawn: pages.map((p, i) => p.querySelector('canvas') ? i + 1 : 0).filter(Boolean),
        drawnFrom: [...new Set(canvases.map(c => c.dataset.file))],
        visible: !$('pdf-container').classList.contains('hidden') && !$('pdf-container').classList.contains('pending'),
        zoom: parseInt($('zoom-level').textContent) / 100,
        cssWidths: pages.map(p => parseFloat(p.style.width)),
        pixelWidths: canvases.map(c => c.width),
      };
    },
    /** Wait until `predicate()` is true. */
    async waitFor(predicate, timeout = 3000) {
      const end = Date.now() + timeout;
      while (!predicate()) {
        if (Date.now() > end) throw new Error('waitFor: timed out');
        await sleep(20);
      }
    },
  };
})();
