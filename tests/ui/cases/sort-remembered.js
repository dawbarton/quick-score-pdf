// The sort order is remembered, and a session opens at the first unscored file as listed.
// query: preset=2&store=quick-score-pdf.sort:colour
async () => {
  const rows = t.rowNames().join();
  const s = t.shown();
  const label = document.getElementById('sort-btn').textContent;
  return { ok: rows === 'f3,f4,f5,f6,f7,f8,f1,f2' && s.header === 'f3.pdf' && s.active === 'f3.pdf' && label === 'Sort: colour',
           rows, header: s.header, label };
}
