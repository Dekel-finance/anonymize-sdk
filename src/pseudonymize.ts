/**
 * Reversible pseudonymization — what leaves the building, and what comes back.
 *
 * This module finds identifying values in text, replaces each one with a
 * stable placeholder, keeps the map on the caller's own hardware, and puts the
 * real values back into the model's reply.
 *
 * ## Why reversible, and not redaction
 *
 * Redaction is stronger and many callers cannot use it: when a model's whole
 * job is to read a document and return the people in it, stripping the names
 * turns the answer into a list of blanks. A one-way redactor would not protect
 * that flow, it would delete it.
 *
 * The bargain is therefore explicit: the vendor sees structure without
 * identity, and the mapping from `[PII:PERSON:…]` back to a person exists only
 * in the process that made it. Nothing is written anywhere and nothing crosses
 * the boundary. A vault that outlived the request it was made for would be a
 * second copy of the register it protects, so it should not outlive it.
 *
 * ## The placeholder
 *
 *     [PII:PERSON:a1b2c3]   [PII:ID:1]   [PII:EMAIL:2]
 *
 * Four properties, each of which ruled out an alternative:
 *
 *  • **Pure ASCII.** Guillemets and `⟦⟧` read better and lose — in an RTL
 *    paragraph, a placeholder made of unusual code points is one the model
 *    reorders, drops or "corrects".
 *  • **No markdown meaning.** `__ID_1__` is bold in every renderer the model
 *    has been trained on, and a model that bolds it hands back `**ID_1**`,
 *    which no longer matches. `[x]` is inert unless followed by `(`.
 *  • **Self-describing.** The model is told nothing about the scheme, and
 *    still leaves `[PII:PERSON:1]` alone, because it reads as a placeholder.
 *    Opaque hashes get "helpfully" rewritten.
 *  • **Recoverable by regex.** One shape, anchored, so re-hydration is a scan
 *    rather than a search for anything that might have been a token.
 *
 * With a key configured, the suffix is a keyed digest of the value, so the
 * same person is the same token everywhere they appear — including across
 * requests. The model can still reason that two rows are the same employee,
 * and a trace can be followed across a month without anybody holding the
 * traces being able to work out whose month it was.
 *
 * ## What is NOT pseudonymized by default, and why
 *
 * `money` is off unless asked for. An amount is worth flagging in an audit
 * line, but this module feeds document extraction, and an extractor that
 * receives `[PII:MONEY:7]` where the payslip said `18,400.00` cannot do the
 * one thing it was called for. Amounts are also not identifying once the name
 * and the identity number are gone — a salary with no one attached to it is a
 * number. Callers that want it can turn it on.
 *
 * Import-free of any database, framework or environment variable, so the same
 * rules run in a gateway, in an app and in a plain `tsx` test.
 */
import { createHmac } from "node:crypto";
import { foldDigits } from "./fold-digits.js";
import { DEFAULT_PATTERNS, type PatternKind } from "./patterns.js";

/**
 * The classes of value this module knows how to hide.
 *
 * `person` and `org` have no pattern — a name is not a shape, it is a fact
 * about a particular register. They are matched from a caller-supplied term
 * list instead; see `terms` on `PseudonymizeOptions`.
 */
export type PseudonymKind = "id" | "email" | "phone" | "money" | "person" | "org";

/** The label that appears inside the placeholder, per kind. */
const LABEL: Record<PseudonymKind, string> = {
  id: "ID",
  email: "EMAIL",
  phone: "PHONE",
  money: "MONEY",
  person: "PERSON",
  org: "ORG",
};

/**
 * Detection order, and it is load-bearing rather than alphabetical.
 *
 * Email first: an address is the only one of these with an unambiguous shape,
 * and its local part can contain anything the others match.
 *
 * **Then `id` before `phone`, which is the non-obvious one.** A nine-digit
 * Israeli identity number written without separators — `012345678` — is *also*
 * a well-formed Israeli phone number under the default `phone` pattern, which
 * reads it as `01-234-5678`. The two shapes genuinely collide and no ordering
 * makes both labels right. `id` wins because it is the likelier reading by a
 * wide margin in the corpus these defaults grew up in: phone numbers almost
 * always carry their separator (`050-1234567`), whose digit runs match no ID
 * pattern at all.
 *
 * Worth being precise about the stakes: **both orderings hide the value**, and
 * the round trip is exact either way. What the order decides is the *label*
 * the vendor sees, which matters only because a model told "this is a phone
 * number" reasons about it as one. A correctness-of-meaning choice, not a
 * leak-or-not choice.
 *
 * Money last: it is the loosest pattern of the four and would otherwise claim
 * digit runs belonging to the others.
 */
const PATTERN_ORDER: readonly PatternKind[] = ["email", "id", "phone", "money"];

/** The placeholder shape, as written and as read back. */
const TOKEN = /\[PII:([A-Z]+):([0-9a-f]+)\]/g;

/**
 * The longest a placeholder can be, used by the streaming re-hydrator to know
 * how much tail it must hold back. `[PII:` + label + `:` + suffix + `]`; the
 * longest label is `PERSON` and the suffix is at most 16 hex characters (see
 * `digestFor`, whose ladder stops there), so 32 still holds with room to spare.
 */
export const MAX_TOKEN_LENGTH = 32;

/**
 * How many caller-supplied terms are honoured.
 *
 * A register with 4,000 people would otherwise turn every prompt into 4,000
 * substring scans. The cap is on the *supplied* list rather than on matches,
 * so the caller decides which names matter instead of the module silently
 * dropping the tail of theirs.
 */
export const MAX_TERMS = 2_000;

/** A name to hide: a person (whose words are also matched alone) or an org. */
export interface Term {
  value: string;
  kind?: "person" | "org";
}

export interface PseudonymizeOptions {
  /**
   * Which kinds to replace. Defaults to everything except `money` — see the
   * module note. `person`/`org` do nothing without `terms`.
   */
  kinds?: readonly PseudonymKind[];
  /**
   * Literal strings to treat as names: employees, clients, contacts. This is
   * how names with no detectable shape are caught, and there is no heuristic
   * alternative worth shipping — "looks like a name" also describes most
   * prose, and a detector that mangles the prompt is worse than one that
   * misses.
   *
   * Longest first internally, so `דנה כהן לוי` is not left as
   * `[PII:PERSON:1] לוי` by an earlier match on `דנה כהן`.
   *
   * **A person's term also matches each of its words on its own.** A register
   * stores one string per person and no screen agrees with it — one real
   * payroll UI writes `לוי , אורי` (surname, comma, given name), so the stored
   * `אורי לוי` matched nothing there and the identity number beside it was
   * hidden while the name stayed in the clear. Matching the parts covers the
   * reordered spelling, the surname alone in a table column, and the given
   * name alone in a greeting. See `expandTerms`.
   */
  terms?: readonly Term[];
  /**
   * A vault to extend rather than start fresh. Passing the vault from an
   * earlier turn keeps `[PII:PERSON:1]` pointing at the same person across a
   * whole conversation, which is what makes a multi-turn exchange coherent.
   * When a vault is supplied, its key wins and `key` is ignored.
   */
  vault?: Vault;
  /**
   * Key material for stable tokens — see the `Vault` note. With no key the
   * placeholder falls back to a per-request counter: less useful, never
   * weaker, and deliberately never an *unkeyed* digest.
   */
  key?: string;
  /**
   * Override one or more of the shape detectors. The defaults are tuned for
   * Israeli payroll (`DEFAULT_PATTERNS`); a caller in another locale supplies
   * the shapes of its own identifiers here. Unnamed kinds keep their defaults.
   */
  patterns?: Partial<Record<PatternKind, RegExp>>;
}

/**
 * Six hex characters of HMAC — 16 million values, and a collision inside one
 * request would point two different people at one token and re-hydrate the
 * wrong one. So a collision lengthens the token rather than being tolerated;
 * `tokenFor` walks out to the full digest if it has to, which it will not.
 */
function digestFor(kind: PseudonymKind, key: string, folded: string): string[] {
  const full = createHmac("sha256", key).update(`${kind}:${folded}`).digest("hex");
  return [6, 8, 12, 16].map((n) => full.slice(0, n));
}

/**
 * The map from placeholder to real value.
 *
 * Deliberately a plain in-memory object with no serializer and no store. It is
 * the most concentrated PII in the system — a direct index from a token to a
 * person — and the only safe lifetime for it is the request that created it.
 * If a caller needs it to persist, that is a decision to take on purpose, with
 * encryption and a retention rule, not by calling `JSON.stringify` on this.
 *
 * ## The key, and why it matters
 *
 * A keyed vault mints the same token for the same value in every request; an
 * unkeyed one falls back to a per-request counter. The digest must be KEYED:
 * an Israeli identity number is nine digits — a billion candidates, a minute
 * of laptop time against a published hash — and an email is worse, because
 * the guesser already has the list. A stable token that anybody holding the
 * traces can reverse is a leak with an extra step. Never bake the key into
 * source: published images would share it across every install.
 */
export class Vault {
  /** placeholder → the original text, exactly as it was written. */
  private readonly byToken = new Map<string, string>();
  /** normalised original → placeholder, so a repeat gets the same number. */
  private readonly byValue = new Map<string, string>();
  /** Next index, per kind. */
  private readonly next = new Map<PseudonymKind, number>();

  constructor(private readonly key?: string) {}

  /** Whether a placeholder minted here will mean the same person tomorrow. */
  get stable(): boolean {
    return Boolean(this.key);
  }

  /** The placeholder for `value`, minting one if this is the first sighting. */
  tokenFor(kind: PseudonymKind, value: string): string {
    // Fold digits and case so `٠٥٠-١٢٣٤٥٦٧`, `050-1234567` and `Dana@Acme.co.il`
    // do not each mint a placeholder of their own. The vault still stores the
    // value as it was actually written, so re-hydration restores the spelling
    // the document used rather than a normalised version of it.
    const key = `${kind} ${foldDigits(value).toLowerCase()}`;
    const existing = this.byValue.get(key);
    if (existing) return existing;

    // Counted either way, because `counts()` is what an egress log reports and
    // it must not depend on whether a key happens to be configured.
    this.next.set(kind, (this.next.get(kind) ?? 0) + 1);

    const token = this.mint(kind, key, value);
    this.byValue.set(key, token);
    this.byToken.set(token, value);
    return token;
  }

  /**
   * The token itself: a keyed digest of the value, or the counter when there
   * is no key to digest it with.
   */
  private mint(kind: PseudonymKind, foldedKey: string, value: string): string {
    if (!this.key) return `[PII:${LABEL[kind]}:${this.next.get(kind)}]`;

    const folded = foldedKey.slice(kind.length + 1);
    for (const digest of digestFor(kind, this.key, folded)) {
      const candidate = `[PII:${LABEL[kind]}:${digest}]`;
      const taken = this.byToken.get(candidate);
      // Free, or already ours: the same value folding to the same token is the
      // whole point. Only a DIFFERENT value on the same token is a collision.
      if (taken === undefined || taken === value) return candidate;
    }
    // Unreachable with a full SHA-256 unless the same value is not the same
    // value, but a silent wrong answer here re-hydrates one person's salary
    // onto another's name.
    throw new Error("pseudonymize: could not mint a distinct placeholder");
  }

  /** The original behind a placeholder, or `undefined` if we never minted it. */
  valueFor(token: string): string | undefined {
    return this.byToken.get(token);
  }

  /** How many distinct values are hidden, for an egress log. Never the values. */
  get size(): number {
    return this.byToken.size;
  }

  /** Counts by kind — the only thing about a vault that is safe to report. */
  counts(): Partial<Record<PseudonymKind, number>> {
    return Object.fromEntries(this.next) as Partial<Record<PseudonymKind, number>>;
  }

  /**
   * Forget everything. Call when a request ends, so a vault cannot outlive
   * the exchange it was built for.
   */
  clear(): void {
    this.byToken.clear();
    this.byValue.clear();
    this.next.clear();
  }
}

export interface PseudonymizeResult {
  /** The text with every match replaced by its placeholder. */
  text: string;
  /** The map back. Lives and dies with the request. */
  vault: Vault;
  /** How many distinct values were hidden, by kind. Safe to log. */
  counts: Partial<Record<PseudonymKind, number>>;
  /** How many replacements were made in total, including repeats. */
  replaced: number;
}

/**
 * One claimed region of the input.
 *
 * Exported because a caller can have a second thing to do with a region
 * besides rewriting it: an image redactor needs to know *where* an identity
 * number sits in a line of OCR'd text so it can paint over the pixels that
 * produced it. That caller must use these exact rules — a second set of
 * detectors, one for strings and one for images, is how a number ends up
 * hidden in the prompt and legible in the screenshot attached to it.
 */
export interface SensitiveSpan {
  start: number;
  end: number;
  kind: PseudonymKind;
}

/** A caller's term is literal text, not a pattern — `.` in a name is a dot. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DEFAULT_KINDS: readonly PseudonymKind[] = ["email", "phone", "id", "person", "org"];

/**
 * Replace every identifying value in `text` with a stable placeholder.
 *
 * Single-pass by construction: all candidate spans are collected first and
 * overlaps are resolved before anything is rewritten. The obvious alternative
 * — `String.replace` once per pattern — is wrong in a way that is easy to
 * miss, because the second pass sees the placeholders the first one wrote and
 * happily matches inside them.
 */
export function pseudonymize(text: string, opts: PseudonymizeOptions = {}): PseudonymizeResult {
  const vault = opts.vault ?? new Vault(opts.key);
  if (!text) return { text, vault, counts: vault.counts(), replaced: 0 };

  const spans = detectSpans(text, opts);
  if (!spans.length) return { text, vault, counts: vault.counts(), replaced: 0 };

  let out = "";
  let cursor = 0;
  let replaced = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    out += vault.tokenFor(span.kind, text.slice(span.start, span.end));
    cursor = span.end;
    replaced++;
  }
  out += text.slice(cursor);

  return { text: out, vault, counts: vault.counts(), replaced };
}

/**
 * A term list, plus each person-term's individual words.
 *
 * A register holds one string per person, and the systems that display that
 * person do not agree with it — `לוי , אורי` on screen against a stored
 * `אורי לוי`. So a person's words are matched individually as well as
 * together. The whole name is still tried first (everything is sorted
 * longest-first), so `[PII:PERSON:…]` covers the full name where the full
 * name appears, and the parts only pick up what is left.
 *
 * **`org` is deliberately not split.** A company name's words are not the
 * company: `בע"מ` and `Ltd` end most of them, `הנדסה` and `Logistics` many,
 * and replacing those everywhere would black out the prose rather than the
 * identity. An org is either written out or it is not caught.
 *
 * Parts shorter than two characters are dropped — a one-letter prefix would
 * otherwise match inside half the words on the screen — and surrounding
 * punctuation is trimmed so a stored `Cohen,` and a displayed `Cohen` are one
 * term rather than two.
 */
function expandTerms(
  terms: readonly Term[],
  kinds: ReadonlySet<PseudonymKind>,
): { value: string; kind: PseudonymKind }[] {
  const out = new Map<string, { value: string; kind: PseudonymKind }>();
  const add = (raw: string, kind: PseudonymKind): void => {
    const value = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim();
    if (value.length < 2) return;
    const key = `${kind}\u0000${value.toLowerCase()}`;
    if (!out.has(key)) out.set(key, { value, kind });
  };

  for (const term of terms) {
    const kind = (term.kind ?? "person") as PseudonymKind;
    if (!kinds.has(kind)) continue;
    add(term.value, kind);
    if (kind !== "person") continue;
    const parts = term.value.split(/\s+/);
    if (parts.length > 1) for (const part of parts) add(part, kind);
  }

  return [...out.values()].sort((a, b) => b.value.length - a.value.length);
}

/**
 * Every identifying region of `text`, resolved and in order.
 *
 * The detection half of `pseudonymize`, split out so a caller that is not
 * rewriting a string can still ask the same question. Returned spans never
 * overlap and are sorted by `start`, so a caller can walk them in one pass.
 *
 * Offsets are into `text` as given, not into any normalised form — see the
 * `foldDigits` note below for why that holds.
 */
export function detectSpans(text: string, opts: PseudonymizeOptions = {}): SensitiveSpan[] {
  const kinds = new Set(opts.kinds ?? DEFAULT_KINDS);
  if (!text) return [];

  const patterns: Record<PatternKind, RegExp> = { ...DEFAULT_PATTERNS, ...opts.patterns };

  // Detection runs against digit-folded text so Arabic-Indic and full-width
  // numerals are caught. `foldDigits` maps one code point to one code point, so
  // offsets into `folded` are offsets into `text` — which is what lets the
  // vault store the original spelling while the patterns read the normalised
  // one.
  const folded = foldDigits(text);

  const spans: SensitiveSpan[] = [];
  for (const kind of PATTERN_ORDER) {
    if (!kinds.has(kind)) continue;
    const pattern = patterns[kind];
    // Cloned with /g rather than mutating a module-level object other callers
    // share — a supplied pattern may not be global, and matchAll requires it.
    const scanner = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    for (const m of folded.matchAll(scanner)) {
      if (m.index === undefined || !m[0]) continue;
      spans.push({ start: m.index, end: m.index + m[0].length, kind });
    }
  }

  // Names are literal strings, matched longest-first so a two-word name is not
  // half-replaced by a one-word one that shares its prefix.
  const wanted = expandTerms((opts.terms ?? []).slice(0, MAX_TERMS), kinds);
  for (const term of wanted) {
    // Matched with an /i regex rather than by lower-casing both sides and
    // calling `indexOf`. Case folding is not length-preserving for every
    // script — `İ`.toLowerCase() is two code points — and this function's
    // whole correctness rests on an offset into the scanned string being an
    // offset into `text`. A name with one such character would have shifted
    // every span after it and pasted placeholders into the middle of words.
    const scanner = new RegExp(escapeRegExp(foldDigits(term.value)), "gi");
    for (const m of folded.matchAll(scanner)) {
      if (m.index === undefined || !m[0]) continue;
      spans.push({ start: m.index, end: m.index + m[0].length, kind: term.kind });
    }
  }

  if (!spans.length) return [];

  // Earliest span wins; on a tie the longer one does. Everything overlapping
  // an already-claimed region is dropped, which is what stops an ID pattern
  // from eating the digits inside a phone number that was matched first.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const resolved: SensitiveSpan[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    resolved.push(span);
    cursor = span.end;
  }
  return resolved;
}

/**
 * Put the real values back.
 *
 * A placeholder the vault does not know is left exactly as it is, rather than
 * blanked. If the model invents `[PII:PERSON:9]` for a person it decided
 * should exist, the reader must see that it did — a silent deletion would
 * turn a hallucinated employee into a missing one, which is harder to notice
 * and worse.
 */
export function rehydrate(text: string, vault: Vault): string {
  if (!text) return text;
  return text.replace(TOKEN, (token) => vault.valueFor(token) ?? token);
}

/**
 * Re-hydration for a response that arrives in pieces.
 *
 * The streaming case is not the batch case with a loop around it. A
 * placeholder can straddle a chunk boundary — `[PII:PER` then `SON:1]` — and a
 * re-hydrator that ran `rehydrate` per chunk would emit the two halves
 * untouched and hand the reader a reply with `[PII:PERSON:1]` printed in it.
 * So the tail of each chunk is held back until it is known not to be the
 * start of a placeholder.
 *
 *     const r = new StreamingRehydrator(vault);
 *     for await (const chunk of upstream) yield r.push(chunk);
 *     yield r.end();
 *
 * `end()` is not optional — it releases whatever is still held.
 */
export class StreamingRehydrator {
  private held = "";

  constructor(private readonly vault: Vault) {}

  /** Feed a chunk; get back everything that is now safe to emit. */
  push(chunk: string): string {
    const buffer = this.held + chunk;
    // How far into the tail a placeholder could still be forming. `[` is the
    // only character one can start with, so the last `[` is the only candidate
    // — and only while the buffer is short enough for it to still complete.
    const open = buffer.lastIndexOf("[");
    const holdFrom =
      open !== -1 && buffer.length - open < MAX_TOKEN_LENGTH && !buffer.slice(open).includes("]")
        ? open
        : buffer.length;
    this.held = buffer.slice(holdFrom);
    return rehydrate(buffer.slice(0, holdFrom), this.vault);
  }

  /** Flush the tail. Anything still held is emitted, re-hydrated. */
  end(): string {
    const rest = rehydrate(this.held, this.vault);
    this.held = "";
    return rest;
  }
}

/**
 * Walk a JSON value and pseudonymize every string in it, in place of a caller
 * writing the recursion for each request shape.
 *
 * Model wire formats are nested JSON — Anthropic's `messages[].content[]`,
 * OpenAI's `messages[].content` — and the interesting text is at different
 * depths in each. Walking the whole body means a new field in either vendor's
 * schema is covered on the day it appears rather than the day someone notices.
 *
 * `skip` names the keys whose values must be left alone: base64 file
 * payloads, model names, and anything else where a placeholder would corrupt
 * the request rather than protect it.
 */
export function pseudonymizeDeep<T>(
  value: T,
  opts: PseudonymizeOptions & { skip?: readonly string[] } = {},
): { value: T; vault: Vault; counts: Partial<Record<PseudonymKind, number>>; replaced: number } {
  const vault = opts.vault ?? new Vault(opts.key);
  const skip = new Set(opts.skip ?? []);
  let replaced = 0;

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const r = pseudonymize(node, { ...opts, vault });
      replaced += r.replaced;
      return r.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = skip.has(k) ? v : walk(v);
      return out;
    }
    return node;
  };

  return { value: walk(value) as T, vault, counts: vault.counts(), replaced };
}

/** `pseudonymizeDeep`'s inverse: re-hydrate every string in a JSON value. */
export function rehydrateDeep<T>(value: T, vault: Vault): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return rehydrate(node, vault);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(value) as T;
}
