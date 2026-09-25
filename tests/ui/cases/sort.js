// Sorting by colour lists unscored files first, then green, amber, and red (by name within
// each). Prev/next follow the list as shown, and after scoring the app moves to the next
// unscored file after the one just scored, even though that file has moved in the list.
async () => {
  t.key('g'); await t.settle();                  // f1 green → f2
  t.key('r'); await t.settle();                  // f2 red → f3
  t.key('s');
  const sorted = t.rowNames().join();
  const stored = localStorage.getItem('quick-score-pdf.sort');
  const header0 = t.shown().header;
  t.key('ArrowLeft'); await t.settle();          // f3 is first, so wrap to the last row, f2
  const wrapped = t.shown().header;
  t.key('ArrowLeft'); await t.settle();          // → f1
  t.key('ArrowLeft'); await t.settle();          // → f8
  const back = t.shown().header;
  t.row(1).click(); await t.settle();            // f4
  t.key('a'); await t.settle();                  // f4 amber → f5, the next unscored after f4
  const afterScore = { header: t.shown().header, rows: t.rowNames().join(), active: t.shown().active };
  document.getElementById('sort-btn').click();
  const byName = t.rowNames().join();
  return {
    ok: sorted === 'f3,f4,f5,f6,f7,f8,f1,f2' && stored === 'colour' && header0 === 'f3.pdf'
        && wrapped === 'f2.pdf' && back === 'f8.pdf'
        && afterScore.header === 'f5.pdf' && afterScore.active === 'f5.pdf'
        && afterScore.rows === 'f3,f5,f6,f7,f8,f1,f4,f2'
        && byName === 'f1,f2,f3,f4,f5,f6,f7,f8',
    sorted, stored, header0, wrapped, back, afterScore, byName,
  };
}
