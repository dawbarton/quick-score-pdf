// At a device pixel ratio of 2, pages are drawn at twice their CSS size, and zoom keeps that.
// dpr: 2
async () => {
  t.key('ArrowRight');
  await t.settle();
  const a = t.shown();
  t.key('+');
  await t.settle();
  const b = t.shown();
  const sharp = s => s.pixelWidths.length > 0 && s.pixelWidths.every(p => Math.abs(p - 2 * s.cssWidths[0]) <= 2);
  return { ok: devicePixelRatio === 2 && a.pages === 2 && sharp(a) && sharp(b) && b.cssWidths[0] > a.cssWidths[0],
           a: [a.cssWidths, a.pixelWidths], b: [b.cssWidths, b.pixelWidths] };
}
