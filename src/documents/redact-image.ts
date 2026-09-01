/**
 * Covering the identifying pixels, so a screenshot can leave the way text does.
 *
 * `./ocr.ts` answers "what does this document say" and sends the words instead
 * of the bytes. That is the right answer for a scanned payslip and the wrong
 * one for a screenshot a vision model must *see* — a picture of a screen,
 * asked "where has the run got to, what do I click". OCR'd text with no
 * coordinates does not degrade that flow, it breaks it. Refusing the image
 * loses the automation its eyes; forwarding it sends the screen, names and
 * all, to a vendor.
 *
 * This module is the third answer, and it is the image version of what the
 * pseudonymizer already does to prose. Tesseract is asked for word boxes
 * rather than a wall of text; every box whose text `detectSpans` recognises as
 * identifying is painted over; the picture — same size, same layout, same
 * buttons, same everything a vision model needs — goes out with the names and
 * the identity numbers gone.
 *
 * ## The detectors are not re-implemented here, deliberately
 *
 * `detectSpans` is the same function `pseudonymize` uses, called on the same
 * term list. Two sets of rules — one for strings and one for pictures — is
 * precisely how a number ends up masked in the prompt and legible in the
 * screenshot attached to it, and nobody would notice for months.
 *
 * ## Where this is weaker than the text path, said plainly
 *
 * When OCR fails on a document, no text comes out and nothing leaks. When OCR
 * fails on a *region of an image*, the pixels are still there and they still
 * leave. The failure modes are not symmetric and no amount of care here makes
 * them so, which is why:
 *
 *  • A word tesseract did not read is a word this cannot cover.
 *    Low-confidence words are still assembled into the line and still matched
 *    — a garbled read that trips a pattern gets painted over, because a
 *    spurious black box costs a pixel and a missed identity number costs a
 *    customer.
 *  • An image OCR could barely read at all (`minWords`) is not redacted and
 *    not approved for forwarding. "Tesseract found nothing" and "there is
 *    nothing to find" look identical from here, so the safe reading is the
 *    pessimistic one and the caller's attachment policy decides.
 *  • A face, a signature or a handwritten name is not text and is not
 *    covered.
 *
 * ## Solid boxes rather than a blur, by default
 *
 * Blurring is what everyone asks for and it is the weaker of the two: blurred
 * text of a known font, at a known size, over a nine-digit alphabet, is a
 * search over a small space, and there are published recoveries of exactly
 * this on redacted documents. A filled rectangle destroys the information
 * rather than smearing it. `style: "blur"` exists for the operator who wants
 * the screenshot to still *read* as a screenshot, and this note says what it
 * costs.
 *
 * ## The label is what keeps the round trip
 *
 * Each box carries its placeholder — `[PII:PERSON:a1b2c3]` — painted in the
 * same ASCII shape the text pseudonymizer uses, minted from the SAME vault. So
 * a model looking at the picture can say "click the row for
 * [PII:PERSON:a1b2c3]" and `rehydrateDeep` turns that back into the real name
 * on the way home, which is the property that makes a covered screenshot
 * still useful rather than just safe. Labels are dropped silently if the
 * machine has no font to draw them with.
 */
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSpans, type PseudonymKind, type Term, type Vault } from "../pseudonymize.js";
import { run, toolPresent } from "./spawn.js";

export interface ImageRedactionOptions {
  /** Off means images fall to the caller's attachment policy untouched. */
  enabled: boolean;
  /** `box` destroys the pixels; `blur` only smears them. See the module note. */
  style: "box" | "blur";
  /** Paint the placeholder into the box, so the model's reply can name it. */
  labels: boolean;
  /** Tesseract languages, e.g. `heb+eng`. Match the OCR reader's. */
  languages: string;
  /** Refuse anything larger, before spending CPU on it. */
  maxBytes: number;
  /** Ceiling for the whole read-and-paint, across every subprocess. */
  timeoutMs: number;
  /**
   * Below this many recognised words the image is treated as unread rather
   * than as clean. See "weaker than the text path" above — this is the guard
   * that stops a photo tesseract could not resolve from sailing through with
   * zero boxes and a clean-looking audit row.
   */
  minWords: number;
}

export const DEFAULT_IMAGE_REDACTION: ImageRedactionOptions = {
  enabled: true,
  style: "box",
  labels: true,
  languages: "heb+eng",
  // Smaller than the OCR reader's 25MB: this path rasterises nothing, so a
  // file this big is a photograph rather than a screen, and a screen is what
  // vision flows send.
  maxBytes: 12 * 1024 * 1024,
  // One tesseract pass plus one convert. A screenshot is ~3s; the ceiling is
  // for the pathological case, not the normal one.
  timeoutMs: 60_000,
  minWords: 4,
};

/** What a caller needs to know about one redacted image. */
export interface RedactionResult {
  bytes: Buffer;
  /** Always PNG: lossless, so a box has no JPEG halo to hint at its edges. */
  mime: string;
  /** How many regions were painted over. */
  covered: number;
  /** How many words tesseract read, for the "did we actually see it" check. */
  words: number;
}

/** Why an image was not redacted. Every one of these means "do not forward". */
export type RedactionRefusal = "too-large" | "unreadable" | "tools-missing" | "failed";

export type RedactionOutcome = RedactionResult | { refused: RedactionRefusal };

export function wasRedacted(o: RedactionOutcome): o is RedactionResult {
  return !("refused" in o);
}

/** One word, where tesseract found it. */
interface Word {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  line: string;
}

interface Page {
  width: number;
  height: number;
  words: Word[];
}

/**
 * Parse tesseract's TSV.
 *
 * Columns are fixed: `level page block par line word left top width height
 * conf text`. Level 1 is the page — which is where the image's dimensions
 * come from, so this module never has to shell out to `identify` for them —
 * and level 5 is a word.
 *
 * Words are grouped into lines because the patterns need the line: `050-123
 * 4567` can arrive as two words, and a name is two words nearly always. Each
 * word keeps its own box, so painting is still per-word and a matched line
 * does not black out the whole row.
 */
function parseTsv(tsv: string): Page {
  const page: Page = { width: 0, height: 0, words: [] };

  for (const row of tsv.split("\n")) {
    const c = row.split("\t");
    if (c.length < 12) continue;
    const level = Number(c[0]);
    if (!Number.isFinite(level)) continue;
    const [left, top, width, height] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])];
    if (level === 1) {
      page.width = width;
      page.height = height;
      continue;
    }
    if (level !== 5) continue;
    const text = c.slice(11).join("\t").trim();
    if (!text) continue;
    // page/block/par/line, which is the only grouping tesseract guarantees is
    // in reading order — including for RTL, where the words come out in
    // logical order and so join into a line that reads the way the pattern
    // expects.
    const key = `${c[1]}/${c[2]}/${c[3]}/${c[4]}`;
    page.words.push({ text, left, top, width, height, line: key });
  }
  return page;
}

/** A region to paint, in image coordinates. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

/**
 * Which words in this page are identifying, and what to write over them.
 *
 * The line is assembled with single spaces and each word's character range is
 * remembered, so a span found in the line maps straight back to the boxes
 * that produced it. A word is claimed when it overlaps a span at all, rather
 * than when it is contained in one — half of a phone number is a phone
 * number.
 */
function boxesFor(
  page: Page,
  opts: { kinds?: readonly PseudonymKind[]; terms?: readonly Term[]; vault: Vault },
): Box[] {
  const byLine = new Map<string, Word[]>();
  for (const w of page.words) {
    const bucket = byLine.get(w.line);
    if (bucket) bucket.push(w);
    else byLine.set(w.line, [w]);
  }

  const boxes: Box[] = [];
  for (const words of byLine.values()) {
    let text = "";
    const ranges: { start: number; end: number; word: Word }[] = [];
    for (const w of words) {
      if (text) text += " ";
      ranges.push({ start: text.length, end: text.length + w.text.length, word: w });
      text += w.text;
    }

    for (const span of detectSpans(text, { kinds: opts.kinds, terms: opts.terms })) {
      // A word is claimed when it overlaps the span at all, rather than when
      // it is contained in it — half of a phone number is a phone number.
      const hit = ranges.filter((r) => r.end > span.start && r.start < span.end).map((r) => r.word);
      if (!hit.length) continue;

      // One box for the whole span, not one per word. `דנה כהן` is two words
      // with a gap between them, and two boxes leave that gap unpainted,
      // print the same placeholder twice on top of itself, and look like a
      // redaction that was not sure. The words of a span are contiguous on
      // the line by construction, so their bounding box is exactly the span.
      const left = Math.min(...hit.map((w) => w.left));
      const top = Math.min(...hit.map((w) => w.top));
      const right = Math.max(...hit.map((w) => w.left + w.width));
      const bottom = Math.max(...hit.map((w) => w.top + w.height));
      boxes.push({
        // A couple of pixels out on every side: tesseract's box is tight to
        // the glyphs and a tight box leaves the ascenders and descenders of
        // the first and last character peeking out from under the paint.
        x: left - 2,
        y: top - 2,
        w: right - left + 4,
        h: bottom - top + 4,
        label: opts.vault.tokenFor(span.kind, text.slice(span.start, span.end)),
      });
    }
  }
  return boxes;
}

/** Clamp a box into the image, so `-region` cannot be handed a bad geometry. */
function clamp(b: Box, page: Page): Box | null {
  const x = Math.max(0, Math.min(b.x, page.width - 1));
  const y = Math.max(0, Math.min(b.y, page.height - 1));
  const w = Math.min(b.w + Math.min(0, b.x), page.width - x);
  const h = Math.min(b.h + Math.min(0, b.y), page.height - y);
  return w > 0 && h > 0 ? { ...b, x, y, w, h } : null;
}

/** Labels are painted, so they are stripped to a shape a draw string cannot escape. */
function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9:_\[\]-]/g, "");
}

/**
 * Read an image locally, cover every identifying word in it, and hand back
 * the picture.
 *
 * Never throws. Every failure is a refusal the caller can act on, because the
 * one outcome that must be impossible here is "something went wrong, so the
 * original went out".
 */
export async function redactImage(
  bytes: Buffer,
  opts: ImageRedactionOptions,
  pii: {
    kinds?: readonly PseudonymKind[];
    terms?: readonly Term[];
    vault: Vault;
  },
): Promise<RedactionOutcome> {
  if (bytes.byteLength > opts.maxBytes) return { refused: "too-large" };

  const deadline = Date.now() + opts.timeoutMs;
  const dir = await mkdtemp(join(tmpdir(), "anon-redact-"));
  try {
    const src = join(dir, "input");
    await writeFile(src, bytes);

    // `tsv` is the same OCR pass `./ocr.ts` makes, asked for coordinates
    // instead of prose.
    let tsv: string;
    try {
      const { stdout } = await run("tesseract", [src, "stdout", "-l", opts.languages, "tsv"], {
        timeoutMs: Math.max(1_000, deadline - Date.now()),
      });
      tsv = stdout.toString("utf8");
    } catch (err) {
      // A missing binary is a broken machine, not a bad picture, and the two
      // are diagnosed very differently — but both mean this image must not
      // leave.
      return { refused: /not installed/.test((err as Error).message) ? "tools-missing" : "failed" };
    }

    const page = parseTsv(tsv);
    if (!page.width || !page.height) return { refused: "failed" };
    if (page.words.length < opts.minWords) return { refused: "unreadable" };

    const boxes = boxesFor(page, pii)
      .map((b) => clamp(b, page))
      .filter((b): b is Box => b !== null);

    const out = join(dir, "out.png");
    const args: string[] = [src];
    if (opts.style === "blur") {
      for (const b of boxes) {
        // Sigma 12 at typical screenshot text sizes leaves no legible stroke.
        // It is still a smear rather than a deletion — see the module note.
        args.push("-region", `${b.w}x${b.h}+${b.x}+${b.y}`, "-blur", "0x12", "+region");
      }
    } else if (boxes.length) {
      args.push("-fill", "black");
      args.push("-draw", boxes.map((b) => `rectangle ${b.x},${b.y} ${b.x + b.w},${b.y + b.h}`).join(" "));
    }

    const labelArgs: string[] = [];
    const font = opts.labels && boxes.length ? await labelFont() : undefined;
    if (font) {
      // White on a filled box, dark on a blurred one — a white placeholder
      // over a smear of light-grey text is invisible, which defeats the point
      // of painting it there.
      labelArgs.push("-font", font, "-fill", opts.style === "blur" ? "#202020" : "white");
      for (const b of boxes) {
        const label = safeLabel(b.label);
        // Sized to fit the box in both directions, and dropped rather than
        // shrunk past legibility. A placeholder spilling over the
        // neighbouring cells of a table makes the screenshot harder to read
        // than the black box it is annotating — and, worse, covers data the
        // model needs. 0.62em per character is DejaVu Sans Mono-ish and errs
        // narrow.
        const size = Math.min(Math.floor(b.h * 0.8), Math.floor(b.w / (0.62 * label.length)), 20);
        if (size < 7) continue;
        labelArgs.push("-pointsize", String(size));
        labelArgs.push("-draw", `text ${b.x + 2},${b.y + b.h - Math.max(2, Math.floor(b.h * 0.15))} '${label}'`);
      }
    }

    const convert = async (extra: string[]): Promise<boolean> => {
      const remaining = deadline - Date.now();
      if (remaining <= 500) return false;
      try {
        const r = await run(await magick(), [...args, ...extra, out], { timeoutMs: remaining });
        return r.code === 0;
      } catch {
        return false;
      }
    };

    // Labels first, then the same command without them. A machine with no
    // fontconfig makes `-draw text` fail, and losing the round-trip niceties
    // is an acceptable degradation; losing the redaction is not.
    let painted = await convert(labelArgs);
    if (!painted && labelArgs.length) painted = await convert([]);
    if (!painted) return { refused: "failed" };

    let redacted: Buffer;
    try {
      redacted = await readFile(out);
    } catch {
      return { refused: "failed" };
    }
    if (!redacted.byteLength) return { refused: "failed" };

    return { bytes: redacted, mime: "image/png", covered: boxes.length, words: page.words.length };
  } catch {
    return { refused: "failed" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A font to paint the placeholders with, or nothing.
 *
 * Named explicitly rather than left to ImageMagick's default, because that
 * default is fontconfig's, and a machine with no fontconfig database — a slim
 * container, a developer's Mac — fails the whole `convert` with "unable to
 * read font", which would take the redaction down with the labels. Probing
 * for a file we know common environments install turns that into "no labels
 * this time". On Debian, `fonts-dejavu-core` provides the first two.
 */
const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
];

let font: string | null | undefined;
export async function labelFont(): Promise<string | undefined> {
  if (font !== undefined) return font ?? undefined;
  for (const candidate of FONT_CANDIDATES) {
    try {
      await access(candidate);
      font = candidate;
      return font;
    } catch {
      // Next candidate. A missing font is a degradation, never a failure.
    }
  }
  font = null;
  return undefined;
}

/**
 * ImageMagick 7 renamed `convert` to `magick` and prints a deprecation on the
 * old name; Debian bookworm still ships 6, where only `convert` exists.
 * Resolved once and remembered, so this is not two probes per screenshot.
 */
let magickPath: string | undefined;
async function magick(): Promise<string> {
  if (magickPath) return magickPath;
  magickPath = (await toolPresent("magick", ["-version"])) ? "magick" : "convert";
  return magickPath;
}

/** Are the binaries this module needs present? */
export async function redactionAvailable(): Promise<{ tesseract: boolean; imagemagick: boolean }> {
  const [tesseract, im7, im6] = await Promise.all([
    toolPresent("tesseract", ["--version"]),
    toolPresent("magick", ["-version"]),
    toolPresent("convert", ["-version"]),
  ]);
  return { tesseract, imagemagick: im7 || im6 };
}
