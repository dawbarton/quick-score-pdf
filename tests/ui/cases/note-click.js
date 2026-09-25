// With the note being edited, a real click on another file opens it (the note save that the
// mousedown triggers must not replace the row before the click lands) and the note is saved.
async () => {
  const note = document.getElementById('note-input');
  await t.click(note);
  note.value = 'note for f1';
  await t.click(t.row(3), 150);
  await t.settle();
  const s = t.shown();
  const saved = calls.filter(c => c[0] === 'set_note').map(c => c[1]);
  return { ok: s.header === 'f4.pdf' && saved.length === 1 && saved[0].filename === 'f1.pdf',
           header: s.header, saved };
}
