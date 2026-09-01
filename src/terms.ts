/**
 * The names, which are the part no pattern can find.
 *
 * `pseudonymize` catches anything with a shape — an identity number, a phone,
 * an address. A name has no shape. `דנה כהן` is two ordinary words, and any
 * heuristic broad enough to catch it also catches half of the surrounding
 * prose, which would hand the vendor a prompt with the verbs replaced.
 *
 * So the names are looked up instead of guessed. If your own database sits on
 * the same machine as your egress path, it already knows every employee and
 * every client by name, and that list is exactly the term list `pseudonymize`
 * takes. This is the thing an on-prem deployment can do that a hosted one
 * cannot, and it is the difference between hiding *identifiers* and hiding
 * *identities*.
 *
 * The SDK does not know your database. You supply a `TermsProvider` — one
 * async function from a scope id to a list of names — and `TermsCache` wraps
 * it with the operational behaviour that took a production incident each to
 * learn:
 *
 *  • **Cache with a TTL.** Names change slowly and a prompt is on someone's
 *    critical path; the TTL is the window in which a brand-new employee's
 *    name is not yet protected. Five minutes closes on its own and keeps a
 *    month-end burst from being four hundred identical queries.
 *  • **Serve stale rather than empty.** A database that cannot be read must
 *    not silently downgrade protection — the names in an expired entry are
 *    still names.
 *  • **Throw when there is nothing at all.** The caller decides; the safe
 *    behaviour in an enforcing gateway is to refuse the request rather than
 *    send names unprotected. There is deliberately no "off" switch here: the
 *    predecessor of this module had one, and setting it silently sent every
 *    name in clear while the health endpoint still reported names as hidden.
 *
 * ## Scope, and why it should be wide
 *
 * Load the list per tenant/agency, not per end-client: a prompt about one
 * client routinely mentions another — a forwarded email, a shared contact, a
 * bookkeeper who works across three companies — and the run does not always
 * know which client it is about until after the model has read the document.
 *
 * ## What a provider deliberately should NOT do
 *
 * Do not decrypt identity-number columns to build the list. The pattern
 * matcher catches identity numbers wherever they appear in the text, so there
 * is nothing for a lookup to add — and a process that decrypts the register
 * to build a lookup table is a second copy of the register.
 */
import { MAX_TERMS, type Term } from "./pseudonymize.js";

export type { Term };

/**
 * Your side of the contract: the names for one scope (a tenant, an agency, a
 * workspace). Called on cache misses; may throw, and `TermsCache` decides what
 * that means. See `normalizeTerms` for the clean-up applied to the result.
 */
export type TermsProvider = (scopeId: string) => Promise<readonly Term[]>;

interface CacheEntry {
  terms: Term[];
  loadedAt: number;
}

export interface TermsCacheOptions {
  /** How long a loaded list stays fresh. Default: 5 minutes. */
  ttlMs?: number;
  /** Where errors go. Default: `console.error`. */
  onError?: (scopeId: string, err: Error) => void;
  /**
   * Set `false` to turn the lookup off: `forScope` returns an empty list and
   * the provider is never called. Names then go out unprotected — pattern
   * kinds (ids, emails, phones) are still caught, identities are not.
   *
   * This exists as an explicit, in-code choice precisely because the
   * dangerous version of it is an environment variable: the predecessor of
   * this class had one, and setting it silently sent every name in clear
   * while the health endpoint still reported names as hidden. If you disable
   * this, say so on whatever status surface you expose.
   */
  enabled?: boolean;
}

export class TermsCache {
  private readonly byScope = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly onError: (scopeId: string, err: Error) => void;
  /** Whether the lookup runs at all. Report this on your status surface. */
  readonly enabled: boolean;

  constructor(
    private readonly provider: TermsProvider,
    opts: TermsCacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.enabled = opts.enabled ?? true;
    this.onError =
      opts.onError ??
      ((scopeId, err) => console.error(`[anonymize-sdk] could not load names for ${scopeId}:`, err.message));
  }

  /**
   * The (normalized) term list for one scope.
   *
   * An undefined scope returns an empty list — there is nothing to look up.
   * A provider failure serves the stale entry if one exists; with no entry at
   * all it re-throws, and the caller must decide whether to refuse. Failing
   * open here — returning `[]` on error — is the one behaviour this class
   * exists to prevent.
   */
  async forScope(scopeId: string | undefined): Promise<Term[]> {
    if (!this.enabled || !scopeId) return [];
    const hit = this.byScope.get(scopeId);
    if (hit && Date.now() - hit.loadedAt < this.ttlMs) return hit.terms;

    try {
      const terms = normalizeTerms(await this.provider(scopeId));
      this.byScope.set(scopeId, { terms, loadedAt: Date.now() });
      return terms;
    } catch (err) {
      this.onError(scopeId, err as Error);
      if (hit) return hit.terms;
      throw err;
    }
  }

  /** Drop everything, so a rename is picked up without a restart. */
  clear(): void {
    this.byScope.clear();
  }
}

/**
 * Clean a raw name list into the shape `pseudonymize` wants.
 *
 * Deduped case-insensitively; entries under two characters dropped (the floor
 * `pseudonymize` applies anyway — a one-letter "name" would turn every
 * instance of that letter into a placeholder); sorted longest-first and capped
 * at `MAX_TERMS`, so if a register exceeds the cap the names that survive are
 * the specific ones rather than an arbitrary slice.
 */
export function normalizeTerms(raw: readonly Term[]): Term[] {
  const terms: Term[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const value = typeof t.value === "string" ? t.value.trim() : "";
    if (value.length < 2) continue;
    const kind = t.kind ?? "person";
    const key = `${kind} ${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({ value, kind });
  }
  return terms.sort((a, b) => b.value.length - a.value.length).slice(0, MAX_TERMS);
}
