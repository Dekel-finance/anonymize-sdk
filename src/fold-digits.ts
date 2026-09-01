/**
 * Digits that are not ASCII digits but mean the same thing.
 *
 * `\d` in a JavaScript regex is ASCII-only, so any detector that
 * pattern-matches for an identity number has to fold first or it passes
 * `٠١٢٣٤٥٦٧٨` straight through. One character in, one character out, so match
 * offsets survive the fold — which is what lets the engine detect against the
 * folded text while replacing spans of the original.
 */
export function foldDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹０-９]/g, (ch) => {
    const c = ch.codePointAt(0)!;
    const base = c >= 0xff10 ? 0xff10 : c >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(c - base);
  });
}
