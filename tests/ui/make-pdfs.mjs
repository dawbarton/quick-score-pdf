// Writes tests/ui/pdfs/f1.pdf … f8.pdf: file fN has N pages, each labelled "fN.pdf page P",
// so the number of pages on screen identifies which file is displayed.
import { mkdirSync, writeFileSync } from 'node:fs';

export function makePdfs(dir, count = 8) {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= count; n++) {
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null,
                  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const kids = [];
    for (let p = 1; p <= n; p++) {
      const s = `BT /F1 48 Tf 72 700 Td (f${n}.pdf page ${p}) Tj ET`;
      objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length} 0 R ` +
                `/Resources << /Font << /F1 3 0 R >> >> >>`);
      kids.push(objs.length);
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${n} >>`;
    let out = '%PDF-1.4\n';
    const offsets = objs.map((o, i) => {
      const at = out.length;
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
      return at;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    writeFileSync(`${dir}/f${n}.pdf`, out, 'latin1');
  }
}
