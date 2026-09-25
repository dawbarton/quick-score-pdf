// Scoring applies only to the file on screen: rapid presses score once, and modifier
// combinations and key repeat never score. Cmd+= still zooms.
async () => {
  t.key('g'); await t.sleep(5); t.key('r'); await t.sleep(5); t.key('g');
  await t.settle();
  const rapid = t.scores();
  t.key('r', { metaKey: true }); t.key('a', { ctrlKey: true }); t.key('g', { repeat: true });
  await t.settle();
  const guarded = t.scores();
  const z0 = t.shown().zoom;
  t.key('=', { metaKey: true });
  await t.settle();
  const z1 = t.shown().zoom;
  return {
    ok: rapid.join() === 'f1.pdf:green' && guarded.join() === 'f1.pdf:green' && z1 > z0,
    rapid, guarded, zoom: [z0, z1],
  };
}
