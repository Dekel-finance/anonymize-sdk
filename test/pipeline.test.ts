/**
 * The reference orchestrator: order of operations, and the fail-closed policy.
 *
 * Run: `npx tsx test/pipeline.test.ts`
 *
 * Needs poppler + tesseract for the document cases; skips those loudly when
 * absent, and still runs the policy cases that need no binaries.
 */
import { strict as assert } from "node:assert";
import { rehydrateDeep } from "../src/pseudonymize.js";
import { ocrAvailable } from "../src/documents/ocr.js";
import { protect } from "../src/pipeline.js";
import { makeTextPdf as makePdf } from "./test-pdf.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}\n  ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// ── Text-only bodies: pure pseudonymization ─────────────────────────────────

await test("a text body is pseudonymized and the reply re-hydrates", async () => {
  const body = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: 'העובד דנה כהן, ת"ז 012345678, dana@acme.co.il' }],
  };
  const outcome = await protect(body, { terms: [{ value: "דנה כהן", kind: "person" }] });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const sent = JSON.stringify(outcome.body);
  assert.ok(!sent.includes("012345678"), "the identity number crossed");
  assert.ok(!sent.includes("dana@acme.co.il"), "the email crossed");
  assert.ok(!sent.includes("דנה"), "the name crossed");
  assert.ok(sent.includes("claude-sonnet-4-6"), "the model name was rewritten");
  assert.deepEqual(rehydrateDeep(outcome.body, outcome.vault), body);
});

// ── The attachment policy: block is the default, and it fails closed ────────

const opaquePdf = {
  messages: [
    {
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "A".repeat(400) } },
      ],
    },
  ],
};

await test("an unreadable attachment is refused by default", async () => {
  // "A".repeat(400) decodes to bytes that are not a PDF — nothing legible can
  // come out of it, so under the default policy the whole request is refused
  // rather than forwarded with a clean-looking replaced:0.
  const outcome = await protect(opaquePdf, {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.refused, "attachments-blocked");
});

await test("with everything local disabled, an attachment still cannot slip through", async () => {
  const outcome = await protect(opaquePdf, { ocr: false, imageRedaction: false });
  assert.equal(outcome.ok, false);
});

await test("attachments: allow forwards it whole, and the stats say so", async () => {
  const outcome = await protect(opaquePdf, { attachments: "allow" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.documentsForwarded, 1, "the honest number");
});

// ── Documents, where the binaries exist ─────────────────────────────────────

const available = await ocrAvailable();
if (!available.pdftotext || !available.pdftoppm || !available.tesseract) {
  console.error("\n⚠ pipeline document cases SKIPPED — poppler/tesseract missing.\n");
} else {
  await test("a readable PDF crosses as pseudonymized text, never bytes", async () => {
    const pdf = makePdf("Employee identity number 012345678 contact dana@acme.co.il today.");
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
            { type: "text", text: "what does it say?" },
          ],
        },
      ],
    };
    const outcome = await protect(body, {});
    assert.equal(outcome.ok, true, `refused: ${JSON.stringify(outcome)}`);
    if (!outcome.ok) return;
    assert.equal(outcome.documentsRead, 1);
    assert.equal(outcome.documentsForwarded, 0);
    const sent = JSON.stringify(outcome.body);
    assert.ok(!sent.includes(pdf.toString("base64").slice(0, 64)), "the PDF bytes crossed");
    assert.ok(!sent.includes("012345678"), "the identity number crossed");
    assert.ok(sent.includes("[PII:ID:"), "the number was not pseudonymized into the text");
  });

  await test("the OCR caveat is injectable, for localisation", async () => {
    const pdf = makePdf("Employee identity number 012345678 contact dana@acme.co.il today.");
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } }],
        },
      ],
    };
    const outcome = await protect(body, { ocrCaveat: () => "[MY HEADER]" });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.ok(JSON.stringify(outcome.body).includes("[MY HEADER]"), "the caveat override was ignored");
  });
}

if (failures.length) {
  console.error(`\n✗ pipeline — ${failures.length} failed\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
} else {
  console.log(`\n✓ pipeline — ${passed} checks passed\n`);
}
