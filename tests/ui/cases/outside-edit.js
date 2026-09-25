// Edits made to the state file while the app is open appear when the window is refocused,
// including the note of the file on screen.
async () => {
  stubState.files[3].score = 'red';
  stubState.files[0].note = 'from the agent';
  stubState.editedOutside = true;
  window.dispatchEvent(new Event('focus'));
  await t.settle();
  return {
    ok: t.row(3).classList.contains('score-red')
        && document.getElementById('progress-text').textContent === '1 / 8'
        && document.getElementById('note-input').value === 'from the agent'
        && t.shown().header === 'f1.pdf',
    row3: t.row(3).className, progress: document.getElementById('progress-text').textContent,
    note: document.getElementById('note-input').value,
  };
}
