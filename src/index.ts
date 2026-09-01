/**
 * anonymize-sdk — reversible PII pseudonymization for text, JSON bodies,
 * documents and images.
 *
 * The core (`pseudonymize`, `Vault`, `rehydrate`) has zero dependencies. The
 * document modules (`readDocument`, `redactImage`) shell out to system
 * binaries: poppler (`pdftotext`, `pdftoppm`), `tesseract`, and ImageMagick.
 */

export { foldDigits } from "./fold-digits.js";
export { DEFAULT_PATTERNS, type PatternKind } from "./patterns.js";

export {
  MAX_TERMS,
  MAX_TOKEN_LENGTH,
  StreamingRehydrator,
  Vault,
  detectSpans,
  pseudonymize,
  pseudonymizeDeep,
  rehydrate,
  rehydrateDeep,
  type PseudonymKind,
  type PseudonymizeOptions,
  type PseudonymizeResult,
  type SensitiveSpan,
  type Term,
} from "./pseudonymize.js";

export { TermsCache, normalizeTerms, type TermsCacheOptions, type TermsProvider } from "./terms.js";

export {
  DEFAULT_SKIP_KEYS,
  WIRES,
  carriesAttachment,
  countAttachments,
  replaceAttachments,
  wantsStream,
  type AttachmentReplacement,
  type FoundAttachment,
  type Wire,
  type WireName,
} from "./wire.js";

export {
  DEFAULT_OCR,
  ocrAvailable,
  readDocument,
  type OcrMethod,
  type OcrOptions,
  type OcrResult,
} from "./documents/ocr.js";

export {
  DEFAULT_IMAGE_REDACTION,
  labelFont,
  redactImage,
  redactionAvailable,
  wasRedacted,
  type ImageRedactionOptions,
  type RedactionOutcome,
  type RedactionRefusal,
  type RedactionResult,
} from "./documents/redact-image.js";

export { run, toolPresent, type RunResult } from "./documents/spawn.js";

export { protect, type ProtectOptions, type ProtectOutcome, type ProtectStats } from "./pipeline.js";
