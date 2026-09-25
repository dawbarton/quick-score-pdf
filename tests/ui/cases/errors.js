// Failed saves and loads are reported in the banner, and a failed score does not advance.
// allow-console-errors
async () => {
  window.FAIL = { set_score: 'disk full' };
  t.key('g');
  await t.settle();
  const score = { error: t.error(), header: t.shown().header };
  t.key('Escape');
  const dismissed = t.error() === null;

  window.FAIL = { get_pdf_url: true };
  t.key('ArrowRight');
  await t.settle();
  const load = document.getElementById('no-file').textContent;

  window.FAIL = { set_note: 'read-only' };
  const note = document.getElementById('note-input');
  note.dispatchEvent(new FocusEvent('focus'));
  note.value = 'x';
  note.dispatchEvent(new FocusEvent('blur'));
  await t.settle();
  const noteError = t.error();
  return {
    ok: score.error === 'Could not save the score for f1.pdf: disk full' && score.header === 'f1.pdf'
        && dismissed && /^Failed to load PDF: HTTP 404/.test(load)
        && noteError === 'Could not save the note for f2.pdf: read-only',
    score, dismissed, load, noteError,
  };
}
