/**
 * A minimal, valid, single-page PDF with a real text layer — for tests only.
 *
 * Generated rather than committed: a real payslip is exactly the thing that
 * must not sit in a repo or in a CI failure log, and a hand-built PDF says
 * exactly what the assertion needs and nothing else.
 */
export function makeTextPdf(text: string): Buffer {
  // Wrapped to fit the 612pt page. Text drawn past the MediaBox is not
  // clipped by the format but *is* dropped by pdftotext, which cost a
  // confusing failure — the identity number was recovered and the email
  // address, sitting further along the same over-long line, silently was not.
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (lines.length && `${lines[lines.length - 1]} ${word}`.length <= 60) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  const drawn = lines
    .map((l, i) => `BT /F1 14 Tf 40 ${720 - i * 20} Td (${l.replace(/([\\()])/g, "\\$1")}) Tj ET`)
    .join("\n");
  const stream = drawn;
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
