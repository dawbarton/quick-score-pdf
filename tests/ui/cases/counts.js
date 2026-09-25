// The score buttons show how many files have each colour, kept up to date.
// query: preset=3
async () => {
  const counts = () => [...document.querySelectorAll('.score-btn[data-score]')].map(b => b.textContent.trim().replace(/\s+/g, ' '));
  const start = counts();
  t.key('a');
  await t.settle();
  const afterAmber = counts();
  t.row(0).click();
  await t.settle();
  t.key('r');
  await t.settle();
  const afterRescore = counts();
  return {
    ok: start.join() === 'Green (3),Amber (0),Red (0)' && afterAmber.join() === 'Green (3),Amber (1),Red (0)'
        && afterRescore.join() === 'Green (2),Amber (1),Red (1)',
    start, afterAmber, afterRescore,
  };
}
