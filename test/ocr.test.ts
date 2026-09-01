/**
 * Reading documents locally — the thing that lets a strict attachment policy
 * be affordable rather than a feature amputation.
 *
 * Run: `npx tsx test/ocr.test.ts`
 *
 * The PDFs are generated here rather than committed: a real payslip fixture
 * would put real PII in the failure output of a test that runs in CI. A
 * hand-built PDF says exactly what the assertion needs and nothing else.
 *
 * Skips itself with a loud message when poppler/tesseract are absent, because
 * a silent pass on a machine without them is how "OCR works" becomes untrue.
 */
import { strict as assert } from "node:assert";
import { DEFAULT_OCR, ocrAvailable, readDocument } from "../src/documents/ocr.js";
import { countAttachments, replaceAttachments } from "../src/wire.js";
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

const available = await ocrAvailable();
if (!available.pdftotext || !available.pdftoppm || !available.tesseract) {
  console.error(
    `\n⚠ ocr tests SKIPPED — missing: ${Object.entries(available)
      .filter(([, ok]) => !ok)
      .map(([k]) => k)
      .join(", ")}\n  Install poppler + tesseract to run this suite.\n`,
  );
  process.exit(0);
}

// ── The text-layer path: exact, and the common case ─────────────────────────

const SENTENCE =
  "Employee payslip for the month of June. Identity number 012345678 and contact dana@acme.co.il for questions.";

await test("a PDF with a text layer is read exactly, without OCR", async () => {
  const r = await readDocument(makePdf(SENTENCE), "application/pdf");
  assert.equal(r.method, "text-layer", `expected the cheap path, got ${r.method}`);
  assert.ok(r.text.includes("012345678"), `text not recovered: ${r.text.slice(0, 120)}`);
  assert.ok(r.text.includes("dana@acme.co.il"));
});

await test("a short PDF falls through to OCR rather than being called text", async () => {
  // Under minTextChars a PDF is treated as a scan.
  const r = await readDocument(makePdf("Hi"), "application/pdf");
  assert.notEqual(r.method, "text-layer");
});

// ── The OCR path ────────────────────────────────────────────────────────────

await test("an image is OCR'd", async () => {
  // Rasterise the generated PDF to get a genuine image with no text layer.
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ocr-fixture-"));
  try {
    const src = join(dir, "in.pdf");
    writeFileSync(src, makePdf("Identity 012345678"));
    spawnSync("pdftoppm", ["-q", "-r", "200", "-png", src, join(dir, "p")]);
    const png = readdirSync(dir).find((f) => f.endsWith(".png"));
    assert.ok(png, "pdftoppm produced no page");
    const r = await readDocument(readFileSync(join(dir, png!)), "image/png");
    assert.equal(r.method, "ocr");
    // Tesseract on a clean 200dpi render of Helvetica is reliable for digits;
    // asserting the number rather than "some text" is what makes this a test
    // of OCR rather than of the subprocess plumbing.
    assert.ok(r.text.replace(/\s/g, "").includes("012345678"), `OCR missed the number: ${JSON.stringify(r.text)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Refusals are answers, never throws ──────────────────────────────────────

await test("a file over the size cap is reported, not read", async () => {
  const huge = Buffer.alloc(DEFAULT_OCR.maxBytes + 1, 0x41);
  const r = await readDocument(huge, "application/pdf");
  assert.equal(r.method, "too-large");
  assert.equal(r.text, "");
});

await test("a non-document is unsupported, not a crash", async () => {
  const r = await readDocument(Buffer.from("this is not a document"), "application/zip");
  assert.equal(r.method, "unsupported");
});

await test("corrupt PDF bytes yield 'unreadable' rather than throwing", async () => {
  const r = await readDocument(Buffer.concat([Buffer.from("%PDF"), Buffer.alloc(2048, 0)]), "application/pdf");
  assert.ok(["unreadable", "ocr"].includes(r.method), `unexpected method ${r.method}`);
  assert.equal(typeof r.text, "string");
});

// ── Replacing attachments in a request body ─────────────────────────────────

const openaiBody = {
  model: "some-model",
  messages: [
    {
      role: "user",
      content: [
        { type: "file", file: { filename: "c.pdf", file_data: `data:application/pdf;base64,${"J".repeat(400)}` } },
        { type: "text", text: "מה כתוב?" },
      ],
    },
  ],
};

const anthropicBody = {
  model: "claude-sonnet-4-6",
  messages: [
    {
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "J".repeat(400) } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "Q".repeat(400) } },
      ],
    },
  ],
};

await test("attachments are counted, not just detected", () => {
  assert.equal(countAttachments(openaiBody), 1);
  assert.equal(countAttachments(anthropicBody), 2, "each document must count once");
  assert.equal(countAttachments({ messages: [{ role: "user", content: "text only" }] }), 0);
});

await test("an OpenAI-style file part becomes a text part", async () => {
  const { body, replaced } = await replaceAttachments(openaiBody, async () => "READ");
  assert.equal(replaced, 1);
  const content = (body as any).messages[0].content;
  assert.deepEqual(content[0], { type: "text", text: "READ" });
  assert.deepEqual(content[1], { type: "text", text: "מה כתוב?" }, "the sibling text part was disturbed");
  assert.equal(countAttachments(body), 0, "a document survived the replacement");
});

await test("Anthropic document and image blocks both become text", async () => {
  const { body, replaced } = await replaceAttachments(anthropicBody, async () => "READ");
  assert.equal(replaced, 2);
  assert.equal(countAttachments(body), 0);
});

await test("returning null leaves the attachment exactly as it was", async () => {
  // This is the vision path: a screenshot flow needs the image itself, so the
  // reader declines and the attachment policy decides.
  const { body, replaced, skipped } = await replaceAttachments(anthropicBody, async (f) =>
    f.kind === "image" ? null : "READ",
  );
  assert.equal(replaced, 1);
  assert.equal(skipped, 1);
  assert.equal(countAttachments(body), 1, "the image should still be there");
  const content = (body as any).messages[0].content;
  assert.deepEqual(content[1], anthropicBody.messages[0].content[1], "the image was mutated");
});

await test("the decoded bytes reach the reader intact", async () => {
  const pdf = makePdf(SENTENCE);
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "file", file: { filename: "c.pdf", file_data: `data:application/pdf;base64,${pdf.toString("base64")}` } },
        ],
      },
    ],
  };
  let seen: Buffer | undefined;
  await replaceAttachments(body, async (f) => {
    seen = f.bytes;
    return "x";
  });
  assert.ok(seen, "the reader was never called");
  assert.equal(seen!.equals(pdf), true, "the bytes were corrupted in transit to the reader");
});

await test("a real PDF round-trips through replacement as its own text", async () => {
  const pdf = makePdf(SENTENCE);
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "file", file: { filename: "c.pdf", file_data: `data:application/pdf;base64,${pdf.toString("base64")}` } },
        ],
      },
    ],
  };
  const { body: out } = await replaceAttachments(body, async (f) => {
    const r = await readDocument(f.bytes, f.mime);
    return r.text || null;
  });
  const text = (out as any).messages[0].content[0].text as string;
  assert.ok(text.includes("012345678"), `document text not carried through: ${text.slice(0, 120)}`);
  assert.equal(countAttachments(out), 0);
});

if (failures.length) {
  console.error(`\n✗ ocr — ${failures.length} failed\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
} else {
  console.log(`\n✓ ocr — ${passed} checks passed\n`);
}
