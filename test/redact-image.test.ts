/**
 * Covering the identifying words in an image — the check that it actually
 * happened, made by reading the picture back.
 *
 * Run: `npx tsx test/redact-image.test.ts`
 *
 * The assertion that matters is not "boxes were drawn". It is that the
 * redacted PNG, put through OCR a second time, no longer says the identity
 * number — which is the only form of the claim a customer would accept, and
 * the only one that stays true if the drawing code is later changed to
 * something clever.
 *
 * Images are generated here with the same ImageMagick the module uses, in
 * English, rather than committed as fixtures: a real screenshot of a payroll
 * screen is exactly the thing that must not sit in a repo or in a CI failure
 * log, and an English fixture exercises the same code path as a Hebrew one.
 *
 * Skips itself loudly when tesseract or ImageMagick are absent, because a
 * silent pass on a machine without them is how "screenshots are covered"
 * becomes untrue.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, rehydrate } from "../src/pseudonymize.js";
import {
  DEFAULT_IMAGE_REDACTION,
  labelFont,
  redactImage,
  redactionAvailable,
  wasRedacted,
} from "../src/documents/redact-image.js";
import { DEFAULT_OCR, readDocument } from "../src/documents/ocr.js";
import { replaceAttachments } from "../src/wire.js";
import { protect } from "../src/pipeline.js";
import { run, toolPresent } from "../src/documents/spawn.js";

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

const available = await redactionAvailable();
if (!available.tesseract || !available.imagemagick) {
  console.error(
    `\n⚠ redact-image tests SKIPPED — missing: ${Object.entries(available)
      .filter(([, ok]) => !ok)
      .map(([k]) => k)
      .join(", ")}\n  Install tesseract + imagemagick to run this suite.\n`,
  );
  process.exit(0);
}

const magick = (await toolPresent("magick", ["-version"])) ? "magick" : "convert";

// The fixtures are drawn with the same font lookup the module uses for its
// labels. With no font on the box there is no way to draw a picture of text,
// so there is nothing here to assert against.
const found = await labelFont();
if (!found) {
  console.error("\n⚠ redact-image tests SKIPPED — no usable font on this machine to draw a test image with.\n");
  process.exit(0);
}
const font: string = found;

/** A picture of a few lines of text — the shape of a payroll screen, in ASCII. */
async function screenshot(lines: string[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "anon-redact-test-"));
  try {
    const out = join(dir, "shot.png");
    const draw = lines.map((l, i) => `text 20,${60 + i * 50} '${l}'`).join(" ");
    await run(magick, ["-size", "900x260", "xc:white", "-font", font, "-fill", "black", "-pointsize", "30", "-draw", draw, out], {
      timeoutMs: 30_000,
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const OPTS = { ...DEFAULT_IMAGE_REDACTION, languages: "eng" };
/** Reading the picture back. English-only, and one page, because that is what these are. */
const OCR = { ...DEFAULT_OCR, languages: "eng", maxPages: 1, minTextChars: 1 };

// ── The claim, checked by reading the picture back ──────────────────────────

await test("an identity number in an image is gone from the image afterwards", async () => {
  const before = await screenshot(["Payroll run June 2026", "Employee id 012345678", "Status approved"]);

  // The premise: OCR can read it at all. Without this the next assertion
  // would pass on an image nobody could read in the first place.
  const check = await readDocument(before, "image/png", OCR);
  assert.ok(check.text.includes("012345678"), `the generated image is not legible: ${check.text.slice(0, 120)}`);

  const vault = new Vault();
  const out = await redactImage(before, OPTS, { kinds: ["id", "email", "person"], vault });
  assert.ok(wasRedacted(out), `redaction refused: ${JSON.stringify(out)}`);
  assert.ok(out.covered >= 1, "nothing was covered");
  assert.equal(out.mime, "image/png");

  const after = await readDocument(out.bytes, "image/png", OCR);
  assert.ok(!after.text.includes("012345678"), `the number survived the paint: ${after.text.slice(0, 200)}`);
  // The rest of the screen has to survive, or this is a black rectangle
  // rather than a redaction and the vision flow it exists for is dead anyway.
  assert.ok(/Payroll|June|approved/i.test(after.text), `the whole screen was destroyed: ${after.text.slice(0, 200)}`);
});

await test("a name from the caller's own register is covered too", async () => {
  const before = await screenshot(["Employee list", "Dana Cohen 42 hours", "Total 3 employees"]);
  const vault = new Vault();
  const out = await redactImage(before, OPTS, {
    kinds: ["id", "person"],
    terms: [{ value: "Dana Cohen", kind: "person" }],
    vault,
  });
  assert.ok(wasRedacted(out), `redaction refused: ${JSON.stringify(out)}`);
  const after = await readDocument(out.bytes, "image/png", OCR);
  assert.ok(!/Dana/i.test(after.text), `the name survived the paint: ${after.text.slice(0, 200)}`);
});

await test("the vault is shared, so the model's answer re-hydrates", async () => {
  const before = await screenshot(["Payroll run June 2026", "Employee id 012345678", "Status approved"]);
  const vault = new Vault();
  const out = await redactImage(before, OPTS, { kinds: ["id"], vault });
  assert.ok(wasRedacted(out));
  // Whatever placeholder was painted into the box is a placeholder the reply
  // can use — this is the property that makes a covered screenshot useful.
  const token = vault.tokenFor("id", "012345678");
  assert.equal(rehydrate(`open the row for ${token}`, vault), "open the row for 012345678");
});

// ── The guards, which are the part that fails closed ────────────────────────

await test("an image OCR could not read is refused rather than passed as clean", async () => {
  const blank = await screenshot([" "]);
  const out = await redactImage(blank, OPTS, { kinds: ["id"], vault: new Vault() });
  assert.equal(wasRedacted(out), false, "a blank image was reported as successfully redacted");
  assert.equal((out as { refused: string }).refused, "unreadable");
});

await test("an oversized image is refused before any CPU is spent", async () => {
  const shot = await screenshot(["Employee id 012345678"]);
  const out = await redactImage(shot, { ...OPTS, maxBytes: 10 }, { kinds: ["id"], vault: new Vault() });
  assert.equal(wasRedacted(out), false);
  assert.equal((out as { refused: string }).refused, "too-large");
});

// ── Back into the request body it came from ─────────────────────────────────

await test("a covered image goes back into the body as an image, not as text", async () => {
  const shot = await screenshot(["Payroll run June 2026", "Employee id 012345678", "Status approved"]);
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is on screen?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: shot.toString("base64") } },
        ],
      },
    ],
  };

  const vault = new Vault();
  const { body: out, redacted, replaced } = await replaceAttachments(body, async (found) => {
    const r = await redactImage(found.bytes, OPTS, { kinds: ["id"], vault });
    return wasRedacted(r) ? { kind: "bytes" as const, bytes: r.bytes, mime: r.mime } : null;
  });

  assert.equal(redacted, 1, "the image was not replaced");
  assert.equal(replaced, 0, "the image was turned into text, which breaks the vision flow");
  const block = (out as any).messages[0].content[1];
  assert.equal(block.type, "image", "the block stopped being an image");
  assert.equal(block.source.media_type, "image/png");
  const carried = Buffer.from(block.source.data, "base64");
  const after = await readDocument(carried, "image/png", OCR);
  assert.ok(!after.text.includes("012345678"), `the number reached the outbound body: ${after.text.slice(0, 200)}`);
});

// ── The whole way through the pipeline ──────────────────────────────────────

await test("a screenshot a caller must SEE is approved, with the names covered", async () => {
  // The case image redaction exists for: a strict attachment policy used to
  // mean a vision flow lost its eyes on every deployment. It now gets its
  // picture — minus the identities.
  const shot = await screenshot(["Payroll run June 2026", "Employee id 012345678", "Status approved"]);

  const outcome = await protect(
    {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is on screen?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: shot.toString("base64") } },
          ],
        },
      ],
    },
    { kinds: ["id"], vision: true, imageRedaction: { languages: "eng" } },
  );

  assert.equal(outcome.ok, true, `the screenshot was refused: ${JSON.stringify(outcome.ok === false && outcome.refused)}`);
  if (!outcome.ok) return;
  assert.equal(outcome.imagesRedacted, 1);
  const block = (outcome.body as any)?.messages?.[0]?.content?.[1];
  assert.equal(block?.type, "image", "the outbound body lost its image");
  const crossed = Buffer.from(block.source.data, "base64");
  assert.equal(crossed.equals(shot), false, "the ORIGINAL screenshot crossed the boundary");
  const after = await readDocument(crossed, "image/png", OCR);
  assert.ok(!after.text.includes("012345678"), `the number crossed the boundary: ${after.text.slice(0, 200)}`);
});

if (failures.length) {
  console.error(`\n✗ redact-image — ${failures.length} failed\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
} else {
  console.log(`\n✓ redact-image — ${passed} checks passed\n`);
}
