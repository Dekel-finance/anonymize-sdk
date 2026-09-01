/**
 * One request body's journey out of the building — the reference orchestrator.
 *
 * The order of operations is the security property, so it is written as a
 * straight line with no early exit that forwards: make the attachments safe
 * (read a document to text, paint over a screenshot), apply the attachment
 * policy to whatever could not be made safe, then pseudonymize the text.
 * There is no branch in which a body is approved because a later step failed
 * — a failure at any point produces a refusal, not a passthrough.
 *
 * This module decides nothing about HTTP. It takes a JSON body and returns
 * either a protected body plus the vault to re-hydrate the reply with, or a
 * refusal the caller turns into its own error shape. A proxy wraps this in a
 * server; an SDK caller invokes it inline before its own `fetch`.
 *
 * Documents are read BEFORE pseudonymization, deliberately. By the time
 * `pseudonymizeDeep` sees the body there is no document left in it — only
 * text, which it already knows how to protect. The other way round would mean
 * a second pseudonymization pass over the OCR output and two places for a
 * name to be missed.
 */
import {
  pseudonymizeDeep,
  Vault,
  type PseudonymKind,
  type PseudonymizeOptions,
  type Term,
} from "./pseudonymize.js";
import { countAttachments, replaceAttachments, DEFAULT_SKIP_KEYS } from "./wire.js";
import { DEFAULT_OCR, readDocument, type OcrOptions } from "./documents/ocr.js";
import {
  DEFAULT_IMAGE_REDACTION,
  redactImage,
  wasRedacted,
  type ImageRedactionOptions,
} from "./documents/redact-image.js";

export interface ProtectOptions extends Pick<PseudonymizeOptions, "kinds" | "terms" | "key" | "patterns" | "vault"> {
  /** Keys never rewritten, at any depth. Defaults to `DEFAULT_SKIP_KEYS`. */
  skip?: readonly string[];
  /** Local document reading. `false` disables it; partial options override `DEFAULT_OCR`. */
  ocr?: Partial<OcrOptions> | false;
  /** Image redaction. `false` disables it; partial options override `DEFAULT_IMAGE_REDACTION`. */
  imageRedaction?: Partial<ImageRedactionOptions> | false;
  /**
   * What happens to an attachment that could not be made safe locally.
   * `block` (the default) refuses the whole request; `allow` forwards it
   * whole, and the stats say so. The default is the safe one on purpose.
   */
  attachments?: "block" | "allow";
  /**
   * The caller genuinely needs the model to *see* the images rather than
   * *read* them — a screenshot flow. Images are then covered (redacted in
   * place) instead of OCR'd to text.
   */
  vision?: boolean;
  /**
   * The caveat prepended to text recovered from a document, so the model can
   * calibrate — visually-read text may contain errors. Override to localise.
   */
  ocrCaveat?: (read: { method: "text-layer" | "ocr"; pages: number; truncated: boolean }) => string;
}

export interface ProtectStats {
  /** Distinct values hidden, by kind. Safe to log. */
  counts: Partial<Record<PseudonymKind, number>>;
  /** Total replacements made in the text, including repeats. */
  replaced: number;
  /** Attachments read locally and replaced with their text. */
  documentsRead: number;
  /** Images redacted in place (pixels covered, picture forwarded). */
  imagesRedacted: number;
  /** Regions painted over across all redacted images. */
  regionsCovered: number;
  /** Attachments forwarded whole, unprotected (only under `attachments: "allow"`). */
  documentsForwarded: number;
}

export type ProtectOutcome =
  | ({ ok: true; body: unknown; vault: Vault } & ProtectStats)
  | ({ ok: false; refused: "attachments-blocked"; vault: Vault } & ProtectStats);

const DEFAULT_CAVEAT: NonNullable<ProtectOptions["ocrCaveat"]> = (read) => {
  if (read.method === "ocr") {
    const cut = read.truncated ? " The document was cut off — not every page was read." : "";
    return `[Attached document content — recovered by optical character recognition (${read.pages} pages); may contain errors.${cut}]`;
  }
  return "[Attached document content]";
};

/**
 * Make one request body safe to send to a model vendor.
 *
 * Returns the protected body and the `Vault` that re-hydrates the reply —
 * pass the model's answer through `rehydrateDeep(answer, vault)` (or
 * `StreamingRehydrator` for a stream). The vault is returned even on refusal
 * so partial work is inspectable; it should not outlive the request.
 */
export async function protect(body: unknown, opts: ProtectOptions = {}): Promise<ProtectOutcome> {
  // One vault for the whole request, shared by the image redactor and the
  // text pseudonymizer. That sharing is what makes a covered screenshot
  // useful: the box painted over a name carries the same placeholder the
  // prompt uses, so a model that answers "click the row for
  // [PII:PERSON:a1b2c3]" is re-hydrated into the real name on the way home.
  const vault = opts.vault ?? new Vault(opts.key);
  const terms: readonly Term[] = opts.terms ?? [];
  const caveat = opts.ocrCaveat ?? DEFAULT_CAVEAT;

  const ocrEnabled = opts.ocr !== false;
  const ocrOpts: OcrOptions = { ...DEFAULT_OCR, ...(opts.ocr === false ? {} : opts.ocr) };
  const redactEnabled = opts.imageRedaction !== false && (opts.imageRedaction?.enabled ?? true);
  const redactOpts: ImageRedactionOptions = {
    ...DEFAULT_IMAGE_REDACTION,
    ...(opts.imageRedaction === false ? {} : opts.imageRedaction),
  };

  let workingBody = body;
  let documentsRead = 0;
  let imagesRedacted = 0;
  let regionsCovered = 0;
  const attachmentsIn = countAttachments(body);
  let documentsForwarded = attachmentsIn;

  if (attachmentsIn > 0 && (ocrEnabled || redactEnabled)) {
    const cover = async (found: { bytes: Buffer }) => {
      if (!redactEnabled) return null;
      const covered = await redactImage(found.bytes, redactOpts, {
        kinds: opts.kinds,
        terms,
        vault,
      });
      // Every refusal — too big, unreadable, no ImageMagick — means the
      // picture was NOT made safe, so it falls to the attachment policy below
      // rather than going out as it arrived.
      if (!wasRedacted(covered)) return null;
      regionsCovered += covered.covered;
      return { kind: "bytes" as const, bytes: covered.bytes, mime: covered.mime };
    };

    const result = await replaceAttachments(workingBody, async (found) => {
      if (found.kind === "image" && opts.vision) return cover(found);
      if (ocrEnabled) {
        const read = await readDocument(found.bytes, found.mime, ocrOpts);
        if (read.text) {
          const header = caveat({ method: read.method as "text-layer" | "ocr", pages: read.pages, truncated: read.truncated });
          return `${header}\n\n${read.text}`;
        }
      }
      // Nothing legible came out of it. A picture can still be made safe as a
      // picture; a PDF that would not read cannot, and falls to the policy.
      return found.kind === "image" ? cover(found) : null;
    });

    workingBody = result.body;
    documentsRead = result.replaced;
    imagesRedacted = result.redacted;
    // Recomputed against the rewritten body rather than assumed: what matters
    // to the policy below is what is STILL an unprotected attachment. A
    // redacted image is still base64 and is still counted by
    // `countAttachments`, so it is subtracted back out — it crossed, but not
    // carrying anything we could read.
    documentsForwarded = Math.max(0, countAttachments(workingBody) - imagesRedacted);
  }

  const baseStats = { documentsRead, imagesRedacted, regionsCovered, documentsForwarded };

  // ── Whatever could not be read is a policy decision ───────────────────────
  //
  // Refusing here, rather than approving a body with a clean-looking
  // `replaced: 0`, is the point: an unreadable attachment forwarded whole is
  // the densest PII in the system crossing with the audit trail asserting
  // nothing left.
  if (documentsForwarded > 0 && (opts.attachments ?? "block") === "block") {
    return { ok: false, refused: "attachments-blocked", vault, counts: vault.counts(), replaced: 0, ...baseStats, documentsForwarded: 0 };
  }

  // ── Pseudonymize ──────────────────────────────────────────────────────────
  const result = pseudonymizeDeep(workingBody, {
    kinds: opts.kinds,
    terms,
    patterns: opts.patterns,
    skip: opts.skip ?? DEFAULT_SKIP_KEYS,
    vault,
  });

  return {
    ok: true,
    body: result.value,
    vault,
    counts: result.counts,
    replaced: result.replaced,
    ...baseStats,
  };
}
