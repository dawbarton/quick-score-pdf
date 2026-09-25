// Only pages near the view are drawn; scrolling draws the pages that come into range and
// drops those that leave it, and zooming redraws what is in view.
async () => {
  const c = document.getElementById('pdf-container');
  for (let i = 0; i < 7; i++) t.key('ArrowRight');  // f8.pdf: 8 pages, each taller than the view
  await t.settle();
  const top = t.shown();
  c.scrollTop = c.scrollHeight;
  await t.waitFor(() => t.shown().drawn.includes(8) && !t.shown().drawn.includes(1));
  const bottom = t.shown();
  t.key('+');
  await t.waitFor(() => t.shown().pixelWidths.length > 0
                        && t.shown().pixelWidths.every(w => w === Math.floor(612 * 1.75)));
  const zoomed = t.shown();
  c.scrollTop = c.querySelectorAll('.pdf-page')[7].offsetTop - 12;  // top of page 8, for the screenshot
  await t.sleep(300);
  return {
    ok: top.header === 'f8.pdf' && top.drawn.includes(1) && top.drawn.length <= 3
        && bottom.drawn.includes(8) && bottom.drawn.length <= 3 && zoomed.drawn.includes(8),
    top: top.drawn, bottom: bottom.drawn, zoomed: zoomed.drawn,
  };
}
