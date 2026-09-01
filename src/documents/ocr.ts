/**
 * Reading a document on the caller's own hardware, so only text leaves.
 *
 * Without this, a request carrying a scanned payslip has two possible answers,
 * and both are bad: refuse it (and lose document extraction and every import
 * flow built on it), or forward the bytes whole (and hand a vendor the densest
 * PII in the system while the audit row says `replaced: 0`).
 *
 * With it there is a third answer. The document is read **here**, inside the
 * caller's network, and what crosses the boundary is the extracted text —
 * which goes through exactly the same pseudonymizer as any other prompt. A
 * scanned payslip stops being a special case and becomes a paragraph with the
 * names and numbers taken out of it.
 *
 * ## Two paths, and the cheap one is tried first
 *
 * Most business PDFs have a text layer. So:
 *
 *   1. `pdftotext` — exact, instant, no model, no guessing. If the PDF has a
 *      text layer this is the answer and OCR never runs.
 *   2. `pdftoppm` + `tesseract` — only for a genuine scan, or for an image.
 *
 * ## What this is honestly not good for
 *
 * OCR reproduces *what a document says*. It does not reproduce *what a screen
 * looks like*, and a vision flow needs the second: it sends a screenshot and
 * asks where things are and what to click. Handing that path a wall of OCR'd
 * text with no coordinates would not degrade it, it would break it.
 *
 * That case is `./redact-image.ts`, which uses the same tesseract read for
 * the opposite purpose: instead of taking the text OUT of the image, it uses
 * the word boxes to paint OVER the identifying ones and sends the picture on.
 * Two answers to two different questions — "what does this say" and "what
 * does this look like" — off one OCR pass.
 *
 * ## Why subprocesses rather than a library
 *
 * `pdftotext`, `pdftoppm` and `tesseract` are in every distro, take bytes on
 * stdin or a temp file, and need no native Node bindings — no node-gyp
 * dependency that fails on one architecture and takes the service down with
 * it. Nothing is passed through a shell: every call goes through `./spawn.ts`
 * — `spawn` with an argv array — so a filename can never become an argument.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, toolPresent } from "./spawn.js";

export interface OcrOptions {
  /** Refuse anything larger, before spending CPU on it. */
  maxBytes: number;
  /** Rasterise and OCR at most this many pages. */
  maxPages: number;
  /** Ceiling for the whole read, across every subprocess. */
  timeoutMs: number;
  /** Tesseract languages, e.g. `heb+eng`. */
  languages: string;
  /** Below this many characters a PDF is treated as a scan. */
  minTextChars: number;
}

export const DEFAULT_OCR: OcrOptions = {
  maxBytes: 25 * 1024 * 1024,
  // Ten pages of a scan is ~30s of tesseract. A contract or a payslip is one
  // to four pages; a caller sending eighty is sending a batch, and a batch
  // that silently OCR'd for four minutes would hit a timeout somewhere
  // upstream and look like the service hanging.
  maxPages: 10,
  timeoutMs: 120_000,
  languages: "heb+eng",
  minTextChars: 80,
};

export type OcrMethod = "text-layer" | "ocr" | "unreadable" | "too-large" | "unsupported";

export interface OcrResult {
  text: string;
  method: OcrMethod;
  /** Pages actually read. 0 for an image or an unreadable document. */
  pages: number;
  /** True when a multi-page document was cut off at `maxPages`. */
  truncated: boolean;
  ms: number;
}

const PDF_MAGIC = Buffer.from("%PDF");

function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).equals(PDF_MAGIC);
}

function isImage(mime: string): boolean {
  return /^image\/(png|jpe?g|webp|tiff?|gif|bmp)$/i.test(mime);
}

/**
 * Read a document to text, locally.
 *
 * Never throws for a bad document — an unreadable file is an answer
 * (`method: "unreadable"`), and the caller decides what to do with it. It
 * does throw when a binary is missing, because that is a broken machine
 * rather than a broken input and must not be silently swallowed into "this
 * PDF was empty".
 */
export async function readDocument(
  bytes: Buffer,
  mime: string,
  opts: OcrOptions = DEFAULT_OCR,
): Promise<OcrResult> {
  const started = Date.now();
  const done = (r: Omit<OcrResult, "ms">): OcrResult => ({ ...r, ms: Date.now() - started });

  if (bytes.byteLength > opts.maxBytes) {
    return done({ text: "", method: "too-large", pages: 0, truncated: false });
  }

  // ── An image: straight to OCR, there is no text layer to try ──────────────
  if (!isPdf(bytes)) {
    if (!isImage(mime)) return done({ text: "", method: "unsupported", pages: 0, truncated: false });
    const dir = await mkdtemp(join(tmpdir(), "anon-ocr-"));
    try {
      // Written to a file rather than piped: tesseract's stdin handling varies
      // between builds and a temp file is the path that behaves the same
      // everywhere.
      const src = join(dir, "input");
      await writeFile(src, bytes);
      const { stdout } = await run("tesseract", [src, "stdout", "-l", opts.languages], {
        timeoutMs: opts.timeoutMs,
      });
      const text = stdout.toString("utf8").trim();
      return done({
        text,
        method: text ? "ocr" : "unreadable",
        pages: text ? 1 : 0,
        truncated: false,
      });
    } catch {
      return done({ text: "", method: "unreadable", pages: 0, truncated: false });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ── A PDF: try the text layer first. Exact, and usually enough ────────────
  try {
    const { stdout } = await run("pdftotext", ["-layout", "-q", "-", "-"], {
      input: bytes,
      timeoutMs: Math.min(opts.timeoutMs, 30_000),
    });
    const text = stdout.toString("utf8").trim();
    if (text.length >= opts.minTextChars) {
      return done({ text, method: "text-layer", pages: 0, truncated: false });
    }
  } catch {
    // Fall through to OCR — a pdftotext failure is not a verdict on the file.
  }

  // ── A scan: rasterise, then OCR each page ─────────────────────────────────
  const dir = await mkdtemp(join(tmpdir(), "anon-ocr-"));
  try {
    const src = join(dir, "in.pdf");
    await writeFile(src, bytes);
    // 200 dpi: tesseract wants ~300 for small print, but 200 halves the
    // rasterisation time and reads a payslip's figures correctly, which is
    // what this is for. `-f/-l` bound the work before any of it happens.
    await run("pdftoppm", ["-q", "-r", "200", "-png", "-f", "1", "-l", String(opts.maxPages), src, join(dir, "page")], {
      timeoutMs: opts.timeoutMs,
    });

    const pages = (await readdir(dir)).filter((f) => f.startsWith("page") && f.endsWith(".png")).sort();
    if (!pages.length) return done({ text: "", method: "unreadable", pages: 0, truncated: false });

    const deadline = started + opts.timeoutMs;
    const parts: string[] = [];
    for (const page of pages) {
      const remaining = deadline - Date.now();
      // Out of time with pages left: return what was read rather than
      // nothing. A partial contract the reviewer can check beats a refusal,
      // and `truncated` tells them it is partial.
      if (remaining <= 1_000) {
        return done({ text: parts.join("\n\n").trim(), method: "ocr", pages: parts.length, truncated: true });
      }
      try {
        const { stdout } = await run("tesseract", [join(dir, page), "stdout", "-l", opts.languages], {
          timeoutMs: remaining,
        });
        parts.push(stdout.toString("utf8").trim());
      } catch {
        parts.push("");
      }
    }

    const text = parts.join("\n\n").trim();
    return done({
      text,
      method: text ? "ocr" : "unreadable",
      pages: parts.length,
      truncated: pages.length >= opts.maxPages,
    });
  } catch {
    return done({ text: "", method: "unreadable", pages: 0, truncated: false });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Are the binaries this module needs actually present? */
export async function ocrAvailable(): Promise<{ pdftotext: boolean; pdftoppm: boolean; tesseract: boolean }> {
  const [pdftotext, pdftoppm, tesseract] = await Promise.all([
    toolPresent("pdftotext", ["-v"]),
    toolPresent("pdftoppm", ["-v"]),
    toolPresent("tesseract", ["--version"]),
  ]);
  return { pdftotext, pdftoppm, tesseract };
}
