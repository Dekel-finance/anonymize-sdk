# anonymize-sdk

Reversible PII pseudonymization for AI egress — text, JSON request bodies, documents and images.

Your prompt goes to a model vendor. The names, identity numbers, emails and phone numbers in it don't have to. This SDK finds them, replaces each with a stable placeholder, and puts the real values back into the model's reply:

```
in:   העובד דנה כהן, ת"ז 012345678
out:  העובד [PII:PERSON:a1b2c3], ת"ז [PII:ID:9f04d1]     → vendor
back: "…the row for [PII:PERSON:a1b2c3]…"                ← vendor
you:  "…the row for דנה כהן…"
```

It was extracted from a production on-prem AI gateway for Israeli payroll bureaus, where the constraint was hard: employee registers may never leave the building, but the AI features must keep working. Every non-obvious rule in this codebase — the OCR-whitespace email pattern, the reordered-name matching, the fail-closed image handling — exists because a real document leaked past a simpler version of it.

## Why reversible, not redaction

Redaction is stronger and many callers cannot use it: when the model's whole job is to read a document and return the people in it, stripping the names turns the answer into a list of blanks. Pseudonymization sends structure without identity, and the mapping back exists only in the process that made it — an in-memory `Vault` that should die with the request.

## What it covers

| Surface | Module | How |
|---|---|---|
| Text | `pseudonymize` / `rehydrate` | pattern + term-list detection, single-pass replacement |
| JSON bodies | `pseudonymizeDeep` / `rehydrateDeep` | walks any wire shape, skip-list for payload keys |
| Streams | `StreamingRehydrator` | re-hydrates placeholders split across chunk boundaries |
| PDFs / scans | `readDocument` | local `pdftotext`, falling back to `pdftoppm` + `tesseract` |
| Screenshots | `redactImage` | tesseract word boxes → ImageMagick paints over identifying words |
| Names | `TermsCache` + your `TermsProvider` | your own register is the detector no pattern can be |
| Everything at once | `protect` | the reference pipeline, in the order that is the security property |

## Install

```sh
npm install anonymize-sdk
```

The core has **zero runtime dependencies**. The document/image modules shell out to system binaries (never through a shell — argv arrays only):

```sh
# Debian/Ubuntu
apt-get install poppler-utils tesseract-ocr tesseract-ocr-heb imagemagick fonts-dejavu-core
# macOS
brew install poppler tesseract imagemagick
```

`ocrAvailable()` and `redactionAvailable()` report what is present; a missing binary is a refusal, never a silent pass-through.

## Quickstart — text

```ts
import { pseudonymize, rehydrate } from "anonymize-sdk";

const { text, vault } = pseudonymize(
  'העובד דנה כהן, ת"ז 012345678, dana@acme.co.il',
  {
    terms: [{ value: "דנה כהן", kind: "person" }],
    key: process.env.PSEUDONYM_KEY, // stable tokens across requests; omit → per-request counters
  },
);
// text: העובד [PII:PERSON:…], ת"ז [PII:ID:…], [PII:EMAIL:…]

const reply = await callModel(text);
const answer = rehydrate(reply, vault);
vault.clear(); // the vault must not outlive the request
```

## Quickstart — a whole request body

```ts
import { protect, rehydrateDeep } from "anonymize-sdk";

const outcome = await protect(anthropicOrOpenAIBody, {
  terms: await termsCache.forScope(tenantId),
  key: process.env.PSEUDONYM_KEY,
});

if (!outcome.ok) {
  // "attachments-blocked": something arrived that could not be made safe
  // locally. Refuse the request — do not forward it.
  throw new Error(outcome.refused);
}

const response = await fetch(vendorUrl, { method: "POST", body: JSON.stringify(outcome.body) });
const answer = rehydrateDeep(await response.json(), outcome.vault);
```

`protect` runs the pipeline in the order that *is* the security property:

1. **Attachments first.** PDFs are read locally (`pdftotext`, then OCR) and replaced with their text; with `vision: true`, images are redacted in place — same picture, identifying words painted over, each box labeled with its placeholder from the same vault.
2. **Policy.** Anything that could not be made safe blocks the request (default) or is forwarded whole (`attachments: "allow"` — the stats then say so honestly).
3. **Pseudonymize.** By now the body is only text, which the engine knows how to protect.

There is no branch in which a body is approved because a later step failed.

## The names — your database is the detector

Patterns catch anything with a shape. A name has no shape: `דנה כהן` is two ordinary words, and any heuristic broad enough to catch it mangles the prose around it. So names are looked up, not guessed — you supply a `TermsProvider` over your own data:

```ts
import { TermsCache } from "anonymize-sdk";

const termsCache = new TermsCache(async (tenantId) => {
  const [employees, customers] = await Promise.all([
    db.collection("employees").find({ tenantId }, { projection: { name: 1 } }).toArray(),
    db.collection("customers").find({ tenantId }, { projection: { name: 1 } }).toArray(),
  ]);
  return [
    ...employees.map((e) => ({ value: e.name, kind: "person" as const })),
    ...customers.map((c) => ({ value: c.name, kind: "org" as const })),
  ];
});
```

`TermsCache` carries the operational behaviour that took a production incident each to learn:

- **TTL cache** (default 5 min) — names change slowly; a month-end burst is not four hundred identical queries.
- **Serve stale rather than empty** on provider failure — the names in an expired entry are still names.
- **Throw when there is nothing at all** — an enforcing caller refuses rather than sending names unprotected. There is deliberately no "off" switch: a predecessor had one, and it silently sent every name in clear while the health endpoint still reported names as hidden.

Person terms also match each of their words alone (registers store `אורי לוי`; screens render `לוי , אורי`). Org terms deliberately don't — `Ltd` and `בע"מ` end half the companies in any register, and splitting them would black out the prose.

Load terms per tenant, not per end-client: a prompt about one client routinely mentions another. And don't decrypt ID columns to build the list — the pattern matcher catches identity numbers wherever they appear.

## Images — cover the pixels, keep the picture

```ts
import { redactImage, wasRedacted, Vault, DEFAULT_IMAGE_REDACTION } from "anonymize-sdk";

const vault = new Vault(key);
const out = await redactImage(screenshotBytes, DEFAULT_IMAGE_REDACTION, {
  terms, vault,
});
if (!wasRedacted(out)) refuse(out.refused); // too-large | unreadable | tools-missing | failed
```

- Same `detectSpans` rules as the text path, on the same term list — one rule set, so a number can't be masked in the prompt and legible in the screenshot attached to it.
- Solid boxes by default; blur exists but is documented as recoverable for known-font digits.
- Output is always PNG (a JPEG halo would hint at box edges).
- Each box is labeled with its placeholder from the shared vault, so a model can answer "click the row for `[PII:PERSON:a1b2c3]`" and re-hydration restores the name.
- **Fail-closed everywhere**: an image OCR could barely read (`minWords`) is refused, not passed as clean — "tesseract found nothing" and "there is nothing to find" look identical, and the pessimistic reading wins.

Honest limits: a word tesseract did not read is a word this cannot cover; faces, signatures and handwriting are not text and are not covered.

## Stable tokens, and the key

With a `key`, a placeholder's suffix is an HMAC-SHA256 digest of the value: the same person is the same token in every request, so traces correlate without identifying anyone. Without a key it falls back to a per-request counter — less useful, never weaker. It is **never** an unkeyed digest: a nine-digit ID space is a minute of laptop time against a published hash. Don't bake the key into source; per-deployment secrets only.

## Localisation

The default patterns (`DEFAULT_PATTERNS`) are tuned for Israeli payroll: ת.ז. shapes, `+972`/`05x` phones, shekel amounts, digit folding for Arabic-Indic numerals. Every one is replaceable per call:

```ts
pseudonymize(text, { patterns: { id: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/ } }); // e.g. US SSN
```

The OCR caveat header and tesseract `languages` are options too (`ocrCaveat`, `languages: "heb+eng"`).

## Deployment pattern (from the original gateway)

This SDK is the engine, not the enforcement. In the system it was extracted from, the pipeline runs in a gateway container that is **the only door**: app containers sit on an internal Docker network with no route to the internet, and the gateway is the one container that can reach out. If call sites are merely *asked* to use the anonymizer, one of them eventually won't.

## Tests

```sh
npm test        # 70 checks across 5 suites
npm run typecheck
```

The image suite verifies redaction by **reading the produced PNG back through OCR** and asserting the number is gone — the only form of the claim a customer would accept. Suites that need system binaries skip loudly when they are absent.

## License

MIT © Dekel Finance
