// Scoring the last unscored file shows "All files scored!".
// query: preset=7
async () => {
  const start = t.shown().header;
  t.key('g');
  await t.settle();
  return { ok: start === 'f8.pdf' && t.doneShown(), start, done: t.doneShown() };
}
