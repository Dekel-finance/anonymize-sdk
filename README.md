# anonymize-sdk

Send prompts to AI vendors **without sending the people in them**.

```
you write:    העובד דנה כהן, ת"ז 012345678
vendor sees:  העובד [PII:PERSON:a1b2c3], ת"ז [PII:ID:9f04d1]
vendor says:  "…the row for [PII:PERSON:a1b2c3]…"
you get:      "…the row for דנה כהן…"
```

The mapping back lives only in memory, in your process, for one request. The vendor never sees a name, an ID, an email or a phone number — and your app never notices the difference, because the reply comes back re-hydrated.

Works on **text**, **whole JSON request bodies**, **streamed responses**, **PDFs** (read locally, only text leaves) and **screenshots** (identifying words painted over, picture forwarded).

Extracted from a production on-prem AI gateway for payroll bureaus, where employee data may never leave the building.

## Install

```sh
npm install anonymize-sdk
```

Zero runtime dependencies. PDFs and images need system tools (optional — skip them if you only do text):

```sh
brew install poppler tesseract imagemagick                                      # macOS
apt-get install poppler-utils tesseract-ocr imagemagick fonts-dejavu-core       # Debian/Ubuntu
```

## 30 seconds — text

```ts
import { pseudonymize, rehydrate } from "anonymize-sdk";

const { text, vault } = pseudonymize("Contact dana@acme.co.il, id 012345678");
// → "Contact [PII:EMAIL:1], id [PII:ID:1]"

const reply = await callModel(text);     // your call, any vendor
const answer = rehydrate(reply, vault);  // real values restored
```

## 60 seconds — a whole request body

`protect()` takes the exact JSON you were about to send (Anthropic or OpenAI shape), makes it safe, and hands you the vault for the reply:

```ts
import { protect, rehydrateDeep } from "anonymize-sdk";

const outcome = await protect(requestBody);
if (!outcome.ok) throw new Error(outcome.refused); // an attachment couldn't be made safe

const res = await fetch(vendorUrl, { method: "POST", body: JSON.stringify(outcome.body) });
const answer = rehydrateDeep(await res.json(), outcome.vault);
```

It also handles attachments: PDFs are read **locally** and replaced with their (pseudonymized) text; with `{ vision: true }`, screenshots are forwarded with the identifying words painted over. Anything that can't be made safe blocks the request by default — never a silent pass-through.

## Do I need a database? No.

Out of the box, the SDK catches everything **with a shape**: IDs, emails, phones (and amounts, if you opt in). No database, no setup.

What patterns can't catch is **names** — `דנה כהן` is just two words. If you want names hidden too, hand the SDK the names you know, from wherever you keep them:

```ts
pseudonymize(text, { terms: [{ value: "Dana Cohen", kind: "person" }] });
```

For a live lookup against your own DB, wrap it in a `TermsCache` — one async function, any database:

```ts
import { TermsCache } from "anonymize-sdk";

const names = new TermsCache(async (tenantId) => {
  const rows = await db.query("SELECT name FROM employees WHERE tenant = $1", [tenantId]);
  return rows.map((r) => ({ value: r.name, kind: "person" as const }));
});

const outcome = await protect(body, { terms: await names.forScope(tenantId) });
```

And to switch the DB lookup off explicitly:

```ts
new TermsCache(provider, { enabled: false }); // always returns [], never queries
```

⚠️ Disabled means names go to the vendor in clear (IDs/emails/phones are still caught). It's a constructor flag rather than an env var on purpose — a previous life of this code had an env switch, and it silently unprotected every name while the health page still said otherwise. If you disable it, show that on your status surface (`cache.enabled` is readable).

`TermsCache` fails **safe**, not open: results are cached (5 min), a DB outage serves the last known list, and if there's no list at all it throws so you can refuse the request instead of leaking.

## Stable tokens (optional)

Pass a `key` and the same person gets the same token in **every** request — traces stay correlatable without being identifying:

```ts
pseudonymize(text, { key: process.env.PSEUDONYM_KEY });
```

Tokens are HMAC-based: not reversible without the key. No key → simple per-request counters (never an unkeyed hash, which would be brute-forceable).

## Not in Israel?

The default detectors are tuned for Israeli documents (ת.ז., +972 phones, ₪). Swap any of them:

```ts
pseudonymize(text, { patterns: { id: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/ } }); // US SSN
```

OCR language (`languages: "heb+eng"`) and the document caveat text are options too.

---

## Details, for when you need them

**API surface**

| You want to… | Use |
|---|---|
| Hide PII in a string | `pseudonymize` / `rehydrate` |
| Hide PII in any JSON body | `pseudonymizeDeep` / `rehydrateDeep` |
| Re-hydrate a streamed reply | `StreamingRehydrator` (handles tokens split across chunks) |
| Read a PDF/scan locally | `readDocument` (pdftotext → tesseract fallback) |
| Redact a screenshot | `redactImage` (word boxes → black boxes, labeled) |
| Find spans without rewriting | `detectSpans` |
| The whole pipeline at once | `protect` |
| Names from your DB, cached | `TermsCache` |

**Design choices that aren't obvious**

- *Reversible, not redaction*: extraction flows need the model's answer to reference real people. Redaction would return a list of blanks.
- *Placeholders are `[PII:KIND:x]`* — pure ASCII, no markdown meaning, self-describing, regex-recoverable. Models leave them alone.
- *Single-pass replacement*: spans are collected and resolved before any rewriting, so a second pattern can never match inside a placeholder the first one wrote.
- *Person terms match their individual words too* (registers store `אורי לוי`; screens show `לוי , אורי`). Org terms don't split — `Ltd` ends half the register.
- *Email pattern tolerates OCR spaces* (`dana@ acme.co.il`) — a real leak from a real scanned document.
- *Images fail closed*: an image OCR can barely read is refused, not passed as clean. Boxes, not blur, by default — blurred digits of a known font are recoverable.
- *Redacted images stay images*, same slot, same wire shape, always PNG, with the placeholder painted into the box from the same vault as the text — so "click the row for `[PII:PERSON:x]`" re-hydrates.
- *The vault is in-memory only, on purpose.* Persisting it would be a second copy of your register. `vault.clear()` when the request ends.

**Deployment pattern**: this SDK is the engine, not the enforcement. In the gateway it came from, app containers have no route to the internet and the pipeline runs in the only container that does. If call sites are merely *asked* to anonymize, one of them eventually won't.

**Tests**: `npm test` — 70+ checks. The image suite proves redaction by OCR-ing the produced PNG and asserting the number is gone. Suites needing system binaries skip loudly when absent; CI installs the real ones.

## License

MIT © Dekel Finance
