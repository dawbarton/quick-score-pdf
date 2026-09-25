// Each file remembers its own scroll position; a file never inherits another's.
async () => {
  const c = document.getElementById('pdf-container');
  for (let i = 0; i < 5; i++) { t.key('ArrowRight'); await t.sleep(5); }
  await t.settle();
  c.scrollTop = 1500;
  const set = c.scrollTop;
  t.key('ArrowRight'); await t.sleep(3); t.key('ArrowRight');
  await t.settle();
  const other = c.scrollTop;
  t.key('ArrowLeft'); t.key('ArrowLeft');
  await t.settle();
  const s = t.shown();
  return { ok: s.header === 'f6.pdf' && set === 1500 && c.scrollTop === set && other === 0,
           file: s.header, set, restored: c.scrollTop, other };
}
