// Rapid navigation, with zooms mid-load and mid-render, must leave the highlighted file on
// screen at the zoom shown on the label.
async () => {
  const bad = [];
  for (let trial = 0; trial < 25; trial++) {
    const n = 2 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      t.key(Math.random() < 0.8 ? 'ArrowRight' : 'ArrowLeft');
      await t.sleep(Math.random() * 25);
    }
    if (Math.random() < 0.3) t.key('+');
    if (Math.random() < 0.3) { await t.sleep(120); t.key('+'); t.key('-'); t.key('ArrowRight'); }
    await t.settle();
    const s = t.shown();
    const expected = +s.header.match(/f(\d+)/)[1];
    const widthsOk = s.widths.every(w => Math.abs(w - Math.floor(612 * s.zoom)) <= 1);
    if (s.header !== s.active || s.pages !== expected || !s.visible || !widthsOk) bad.push({ trial, ...s });
  }
  return { ok: bad.length === 0, bad: bad.slice(0, 3) };
}
