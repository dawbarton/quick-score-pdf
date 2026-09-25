// Clicking another file while a note is being saved must not reassign rows to other files.
async () => {
  window.NOTEDELAY = 300;
  const note = document.getElementById('note-input');
  note.dispatchEvent(new FocusEvent('focus'));
  note.value = 'note for f1';
  note.dispatchEvent(new FocusEvent('blur'));  // mousedown on the row blurs the note …
  t.row(2).click();                            // … and the click lands before the save returns
  await t.settle();
  t.row(5).click(); await t.settle();
  t.row(2).click(); await t.settle();
  const onF3 = { ...t.shown(), note: note.value };
  t.row(0).click(); await t.settle();
  const saved = calls.filter(c => c[0] === 'set_note').map(c => c[1]);
  return {
    ok: onF3.header === 'f3.pdf' && onF3.pages === 3 && onF3.note === '' && note.value === 'note for f1'
        && saved.length === 1 && saved[0].filename === 'f1.pdf',
    onF3, noteOnF1: note.value, saved,
  };
}
