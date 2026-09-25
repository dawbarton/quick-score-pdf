// Changing a score never shows "All files scored!": with files still unscored it moves to
// the next unscored one, and with none left it moves to the next file. Opening a fully
// scored folder starts at the top without the dialogue.
// query: preset=8
async () => {
  const start = { header: t.shown().header, done: t.doneShown() };
  t.key('r');
  await t.settle();
  const rescored = { header: t.shown().header, done: t.doneShown(), scores: t.scores() };
  t.row(7).click();
  await t.settle();
  t.key('a');
  await t.settle();
  const wrapped = { header: t.shown().header, done: t.doneShown() };
  return {
    ok: start.header === 'f1.pdf' && !start.done
        && rescored.header === 'f2.pdf' && !rescored.done && rescored.scores.join() === 'f1.pdf:red'
        && wrapped.header === 'f1.pdf' && !wrapped.done,
    start, rescored, wrapped,
  };
}
