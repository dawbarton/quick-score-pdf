// A command-line error is shown on the welcome screen.
// query: fail=get_cli_session
// allow-console-errors
async () => {
  const error = t.error();
  const welcome = !document.getElementById('welcome').classList.contains('hidden');
  return { ok: error === 'Could not open the files given on the command line: stub failure' && welcome, error, welcome };
}
