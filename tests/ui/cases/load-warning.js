// A warning from loading the session is shown when it opens.
// query: warn=Saved%20scores%20moved%20aside
async () => ({ ok: t.error() === 'Saved scores moved aside' && t.shown().header === 'f1.pdf', error: t.error() })
