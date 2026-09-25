// Changing a score while files remain unscored moves to the next unscored file, no dialogue.
// query: preset=7
async () => {
  t.row(2).click();
  await t.settle();
  t.key('r');
  await t.settle();
  const s = t.shown();
  return { ok: s.header === 'f8.pdf' && !t.doneShown() && t.scores().join() === 'f3.pdf:red',
           header: s.header, done: t.doneShown(), scores: t.scores() };
}
