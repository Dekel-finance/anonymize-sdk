/**
 * The default detectors — written for Israeli payroll, and replaceable.
 *
 * These are *span* patterns: each one claims exactly the characters it means,
 * because the engine replaces the matched region and stores the original in a
 * vault. A predicate ("does this line contain a phone number?") can afford to
 * be loose; a span cannot, or the replacement swallows surrounding prose.
 *
 * The set ships tuned for the corpus it grew up in — Israeli identity numbers
 * (ת.ז.), Israeli phone shapes, shekel amounts — because that is where every
 * rule here was tested against real documents. A caller in another locale
 * passes their own `patterns` to `pseudonymize`/`detectSpans`; the contract is
 * just "a RegExp whose matches are the characters to hide".
 */

/** The kinds a regex can find. `person`/`org` are matched from a term list instead. */
export type PatternKind = "id" | "email" | "phone" | "money";

/**
 * Nine- and eight-digit runs — an Israeli ת.ז. with and without its leading
 * zero — and the 3-3-3 grouping people write it in. Deliberately *not* "digits
 * with any separators", which also matches `2026-07-28`: a rule that rejects
 * every date is a rule callers route around.
 */
const ISRAELI_ID =
  /(?<!\d)\d{3}[-. \u200e\u200f]\d{3}[-. \u200e\u200f]\d{3}(?!\d)|(?<!\d)\d{8,9}(?!\d)/;

/** Israeli and international phone shapes: +972…, 05x-xxxxxxx, 0x-xxxxxxx. */
const PHONE = /(?:\+\d{6,15})|(?:(?<!\d)0\d{1,2}[-\s]?\d{3}[-\s]?\d{4}(?!\d))/;

/**
 * An email address, span-shaped. The local part must begin and end
 * alphanumeric: a leading `-` or `.` is legal in an address and essentially
 * never used, while `ל-` and `מ-` are how Hebrew attaches a preposition to a
 * Latin word. Anchoring the start keeps `ל-dana@acme.co.il` from hiding the
 * preposition along with the address.
 *
 * **`\s{0,2}` around the `@` is not cosmetic — it closes a real leak.** Text
 * that has been through OCR is not clean text: reading a scanned document
 * through tesseract produced `dana@ acme.co.il`, with a space the document
 * does not contain, and a strict pattern did not match it. The address then
 * crossed to the vendor intact while the identity number beside it was
 * correctly replaced. Bounded at two spaces rather than `\s*` so the tolerance
 * cannot span a paragraph, and applied only around `@` and the dots — `5 @
 * 3.00 NIS` does not match, because what follows must still end in a dotted
 * alphabetic TLD.
 */
const EMAIL =
  /[A-Za-z0-9](?:[A-Za-z0-9._%+'-]*[A-Za-z0-9])?\s{0,2}@\s{0,2}[A-Za-z0-9-]+(?:\s{0,2}\.\s{0,2}[A-Za-z0-9-]+)*\s{0,2}\.\s{0,2}[A-Za-z]{2,}/g;

/**
 * An amount with its currency dressing. Requires the digits: replacing a lone
 * `₪` protects nothing and turns `18,400.00 ₪` into two placeholders. An
 * adjacent symbol or currency word is taken with the number.
 */
const MONEY =
  /(?:[₪$€]\s?)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2})(?:\s?(?:[₪$€]|nis|ils|shekel))?/gi;

/**
 * The default pattern set. Override per call with
 * `pseudonymize(text, { patterns: { id: MY_ID_SHAPE } })` — unnamed kinds keep
 * their defaults.
 */
export const DEFAULT_PATTERNS: Record<PatternKind, RegExp> = {
  id: ISRAELI_ID,
  phone: PHONE,
  email: EMAIL,
  money: MONEY,
};
