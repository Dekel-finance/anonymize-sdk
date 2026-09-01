/**
 * What the engine is allowed to let out, asserted rather than assumed.
 *
 * Run: `npx tsx test/pseudonymize.test.ts`
 *
 * The cases here are the ones that were wrong in a draft of the engine before
 * they were written down — overlapping spans, a second pass matching inside
 * the placeholders the first one wrote, and a token split across two
 * streaming chunks. Each of those produces a *plausible* string, which is why
 * they need a test rather than a read-through.
 */
import { strict as assert } from "node:assert";
import {
  MAX_TOKEN_LENGTH,
  StreamingRehydrator,
  Vault,
  pseudonymize,
  pseudonymizeDeep,
  rehydrate,
  rehydrateDeep,
} from "../src/pseudonymize.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`\n✗ ${name}\n  ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

// ── The round trip ───────────────────────────────────────────────────────────

test("an identity number is hidden and comes back exactly as written", () => {
  const src = "העובד 012345678 סיים את החודש";
  const { text, vault } = pseudonymize(src);
  assert.ok(!text.includes("012345678"), "the identity number survived into the outbound text");
  assert.equal(text, "העובד [PII:ID:1] סיים את החודש");
  assert.equal(rehydrate(text, vault), src);
});

test("the same value gets the same placeholder, so the model can correlate", () => {
  const { text } = pseudonymize("012345678 ו-012345678 ו-087654321");
  assert.equal(text, "[PII:ID:1] ו-[PII:ID:1] ו-[PII:ID:2]");
});

test("a repeat spelled differently still maps to one placeholder", () => {
  // Arabic-Indic digits and ASCII digits are the same number; two placeholders
  // would tell the vendor there are two employees where there is one.
  const { text } = pseudonymize("050-1234567 ו-٠٥٠-١٢٣٤٥٦٧");
  assert.equal(text, "[PII:PHONE:1] ו-[PII:PHONE:1]");
});

test("re-hydration restores the original spelling, not a normalised one", () => {
  const src = "צרו קשר: ٠٥٠-١٢٣٤٥٦٧";
  const { text, vault } = pseudonymize(src);
  assert.equal(rehydrate(text, vault), src);
});

test("an email is hidden", () => {
  const { text, vault } = pseudonymize("שלחו ל-dana@acme.co.il בבקשה");
  assert.equal(text, "שלחו ל-[PII:EMAIL:1] בבקשה");
  assert.equal(rehydrate(text, vault), "שלחו ל-dana@acme.co.il בבקשה");
});

// ── The failures that motivated the single-pass design ───────────────────────

test("a second kind does not match inside the first kind's placeholder", () => {
  // `[PII:PHONE:1]` contains a digit run. A naive per-pattern `String.replace`
  // chain lets the ID pass match the `1` — or worse, the digits of a longer
  // index — and produces `[PII:PHONE:[PII:ID:1]]`, which re-hydrates to
  // garbage.
  const { text, vault } = pseudonymize("050-1234567 and 012345678 and 18,400.00", {
    kinds: ["phone", "id", "money"],
  });
  assert.ok(!/\[PII:[A-Z]+:\[/.test(text), `nested placeholder produced: ${text}`);
  assert.equal(rehydrate(text, vault), "050-1234567 and 012345678 and 18,400.00");
});

test("overlapping matches are resolved, never double-replaced", () => {
  const src = "טל' 050-1234567 ת.ז. 012345678";
  const { text, vault } = pseudonymize(src, { kinds: ["phone", "id"] });
  assert.equal(rehydrate(text, vault), src, `lossy round trip: ${text}`);
  assert.ok(!text.includes("1234567"), `raw digits leaked: ${text}`);
});

test("a name is only replaced when the caller supplies it", () => {
  const withoutTerms = pseudonymize("דנה כהן קיבלה תלוש");
  assert.equal(withoutTerms.text, "דנה כהן קיבלה תלוש", "a name was invented as PII without a term list");

  const withTerms = pseudonymize("דנה כהן קיבלה תלוש", { terms: [{ value: "דנה כהן" }] });
  assert.equal(withTerms.text, "[PII:PERSON:1] קיבלה תלוש");
});

test("the longest name wins, so a name is never half-replaced", () => {
  const { text } = pseudonymize("דנה כהן לוי חתמה", {
    terms: [{ value: "דנה כהן" }, { value: "דנה כהן לוי" }],
  });
  assert.equal(text, "[PII:PERSON:1] חתמה");
});

test("a person is caught when the screen reorders their name", () => {
  // The real failure, from a real screenshot: one payroll UI writes
  // `surname , given name` while the register stores `given surname`. The
  // literal full name matched nothing, so the identity number beside it was
  // hidden and the person was not.
  const { text } = pseudonymize('שם העובד: לוי , אורי ת"ז: 311200000', {
    terms: [{ value: "אורי לוי", kind: "person" }],
  });
  assert.ok(!text.includes("לוי"), `the surname survived: ${text}`);
  assert.ok(!text.includes("אורי"), `the given name survived: ${text}`);
  assert.ok(!text.includes("311200000"), `the identity number survived: ${text}`);
});

test("the whole name still wins over its parts", () => {
  // Parts are additive, not a replacement: where the full name appears it is
  // one placeholder, not two stuck together.
  const { text } = pseudonymize("דנה כהן חתמה", { terms: [{ value: "דנה כהן", kind: "person" }] });
  assert.equal(text, "[PII:PERSON:1] חתמה");
});

test("an organisation's words are NOT matched on their own", () => {
  // `בע"מ` and `הנדסה` end and fill half the company names in a register.
  // Splitting an org would black out the prose rather than the identity.
  const { text } = pseudonymize("חברת הנדסה אחרת בע\"מ", {
    terms: [{ value: 'טכנולוגיין הנדסה בע"מ', kind: "org" }],
  });
  assert.equal(text, "חברת הנדסה אחרת בע\"מ");
});

test("a name containing regex metacharacters is matched literally", () => {
  const { text, vault } = pseudonymize("חברת A.B. (2019) בע\"מ שילמה", {
    terms: [{ value: "A.B. (2019) בע\"מ", kind: "org" }],
  });
  assert.equal(text, "חברת [PII:ORG:1] שילמה");
  assert.equal(rehydrate(text, vault), "חברת A.B. (2019) בע\"מ שילמה");
});

test("case-insensitive term matching does not shift offsets", () => {
  // `İ`.toLowerCase() is two code points. Lower-casing the haystack to search
  // it would move every span after this character by one and paste
  // placeholders into the middle of neighbouring words.
  const src = "İnci Bar wrote to dana@acme.co.il";
  const { text, vault } = pseudonymize(src, { terms: [{ value: "İnci Bar" }] });
  assert.equal(rehydrate(text, vault), src, `offsets drifted: ${text}`);
  assert.ok(text.includes("[PII:PERSON:1]"), `name not matched: ${text}`);
  assert.ok(!text.includes("dana@acme.co.il"), `email leaked: ${text}`);
});

// ── Defaults ─────────────────────────────────────────────────────────────────

test("an address broken by OCR whitespace is still caught", () => {
  // Tesseract reading a scanned payslip emitted `dana@ acme.co.il`. The
  // strict pattern missed it and the address crossed to the vendor while the
  // identity number beside it was replaced — a partially-pseudonymized
  // request that the audit row reported as pseudonymized.
  for (const spelling of ["dana@ acme.co.il", "dana @acme.co.il", "dana @ acme.co.il", "dana@acme. co.il"]) {
    const { text, vault } = pseudonymize(`צרו קשר ${spelling} תודה`);
    assert.ok(!text.includes("acme"), `the address survived as "${spelling}": ${text}`);
    assert.equal(rehydrate(text, vault), `צרו קשר ${spelling} תודה`, "round trip lost the original spacing");
  }
});

test("the whitespace tolerance does not swallow ordinary text", () => {
  // The tolerance is bounded and anchored on `@` precisely so it cannot start
  // eating prose or arithmetic.
  const cases = ["5 @ 3.00 NIS", "שעות @ תעריף", "דוח @ סוף החודש"];
  for (const src of cases) {
    const { text } = pseudonymize(src, { kinds: ["email"] });
    assert.equal(text, src, `over-matched: ${src} → ${text}`);
  }
});

test("money is left alone by default, so extraction still works", () => {
  const { text } = pseudonymize("שכר ברוטו 18,400.00 ש\"ח");
  assert.ok(text.includes("18,400.00"), "an amount the extractor needs was hidden by default");
});

test("money is hidden when asked for", () => {
  const { text } = pseudonymize("שכר ברוטו 18,400.00", { kinds: ["money"] });
  assert.equal(text, "שכר ברוטו [PII:MONEY:1]");
});

test("text with nothing sensitive is returned untouched", () => {
  const src = "הרצת השכר הסתיימה בהצלחה";
  const { text, replaced } = pseudonymize(src);
  assert.equal(text, src);
  assert.equal(replaced, 0);
});

// ── Pluggable patterns ───────────────────────────────────────────────────────

test("a supplied pattern replaces the default for its kind", () => {
  // A caller in another locale supplies the shape of its own identifiers:
  // here, a US SSN. The Israeli default would not have claimed it as one span.
  const ssn = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;
  const { text, vault } = pseudonymize("SSN 123-45-6789 on file", { kinds: ["id"], patterns: { id: ssn } });
  assert.equal(text, "SSN [PII:ID:1] on file");
  assert.equal(rehydrate(text, vault), "SSN 123-45-6789 on file");
});

// ── The vault ────────────────────────────────────────────────────────────────

test("a shared vault keeps numbering stable across turns", () => {
  const vault = new Vault();
  const first = pseudonymize("012345678 התחיל", { vault });
  const second = pseudonymize("012345678 סיים", { vault });
  assert.equal(first.text, "[PII:ID:1] התחיל");
  assert.equal(second.text, "[PII:ID:1] סיים", "the same person changed identity between turns");
});

test("counts report shape without reporting values", () => {
  const { counts, vault } = pseudonymize("012345678 dana@acme.co.il 087654321");
  assert.deepEqual(counts, { id: 2, email: 1 });
  assert.equal(vault.size, 3);
});

test("clear() forgets everything", () => {
  const { vault } = pseudonymize("012345678");
  vault.clear();
  assert.equal(vault.size, 0);
  assert.equal(vault.valueFor("[PII:ID:1]"), undefined);
});

test("an unknown placeholder is left visible, not silently blanked", () => {
  // If the model invents an employee, the reader has to be able to see that
  // it did. A blank would turn a hallucination into a missing row.
  assert.equal(rehydrate("שלום [PII:PERSON:9]", new Vault()), "שלום [PII:PERSON:9]");
});

// ── Streaming ────────────────────────────────────────────────────────────────

test("a placeholder split across chunks is still re-hydrated", () => {
  const { text, vault } = pseudonymize("שלום 012345678 שלום");
  const r = new StreamingRehydrator(vault);
  let out = "";
  // Byte-at-a-time is the worst case, and it is the one that broke the first
  // draft: every chunk boundary falls inside the placeholder.
  for (const ch of text) out += r.push(ch);
  out += r.end();
  assert.equal(out, "שלום 012345678 שלום");
});

test("streaming and batch re-hydration agree, at every chunk size", () => {
  const { text, vault } = pseudonymize("א 012345678 ב dana@acme.co.il ג 050-1234567 ד");
  const expected = rehydrate(text, vault);
  for (let size = 1; size <= MAX_TOKEN_LENGTH + 8; size++) {
    const r = new StreamingRehydrator(vault);
    let out = "";
    for (let i = 0; i < text.length; i += size) out += r.push(text.slice(i, i + size));
    out += r.end();
    assert.equal(out, expected, `chunk size ${size} disagreed with batch`);
  }
});

test("the stream holds nothing back once end() is called", () => {
  const r = new StreamingRehydrator(new Vault());
  const out = r.push("trailing [PII") + r.end();
  assert.equal(out, "trailing [PII", "text was swallowed by the hold-back buffer");
});

// ── Deep walk, the shape wire formats actually arrive in ─────────────────────

test("a nested request body is pseudonymized throughout", () => {
  const body = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ type: "text", text: "ת.ז. 012345678" }] }],
  };
  const { value, vault } = pseudonymizeDeep(body, { skip: ["model"] });
  assert.equal(value.messages[0].content[0].text, "ת.ז. [PII:ID:1]");
  assert.equal(value.model, "claude-sonnet-4-6", "the model name was rewritten");
  assert.deepEqual(rehydrateDeep(value, vault), body);
});

test("skipped keys are passed through byte-for-byte", () => {
  // A base64 PDF is not text and a placeholder inside it corrupts the
  // document.
  const body = { file_data: "data:application/pdf;base64,JVBERi0xLjQK012345678", note: "ת.ז. 012345678" };
  const { value } = pseudonymizeDeep(body, { skip: ["file_data"] });
  assert.equal(value.file_data, body.file_data);
  assert.equal(value.note, "ת.ז. [PII:ID:1]");
});

test("non-string leaves are preserved with their types", () => {
  const body = { temperature: 0, stream: true, stop: null, n: 1 };
  const { value } = pseudonymizeDeep(body);
  assert.deepEqual(value, body);
  assert.equal(typeof value.temperature, "number");
  assert.equal(value.stop, null);
});

/* ───────────────── the token: stable, and not reversible ───────────────── */

/**
 * A placeholder without a key is a per-request counter, so the same employee
 * is `[PII:PERSON:1]` in one request and `[PII:PERSON:3]` in the next.
 * Nothing reading the traces can tell that two months were about the same
 * person — which is most of what anybody wants from a trace. With a key, the
 * token is a keyed digest: stable everywhere, reversible nowhere.
 */

const TERMS = [{ value: "דנה כהן", kind: "person" as const }];
const LINE = 'דנה כהן, dana@acme.co.il, 012345678';

test("the same value mints the same token in a DIFFERENT request", () => {
  const first = pseudonymize(LINE, { terms: TERMS, key: "a-secret" });
  const second = pseudonymize(LINE, { terms: TERMS, key: "a-secret" });
  assert.equal(first.text, second.text, "two requests about one person produced two different tokens");
  assert.ok(/\[PII:PERSON:[0-9a-f]{6}\]/.test(first.text), `not a digest: ${first.text}`);
});

test("and it still round-trips", () => {
  const { text, vault } = pseudonymize(LINE, { terms: TERMS, key: "a-secret" });
  assert.equal(rehydrate(text, vault), LINE);
});

/**
 * The property the whole thing rests on. A nine-digit identity number is a
 * billion candidates — a minute of laptop time against a published hash — so
 * a token anybody holding the traces can reverse would be a leak with an
 * extra step.
 */
test("a different key gives a different token for the same person", () => {
  const a = pseudonymize(LINE, { terms: TERMS, key: "secret-one" }).text;
  const b = pseudonymize(LINE, { terms: TERMS, key: "secret-two" }).text;
  assert.notEqual(a, b, "the token does not depend on the key — it can be brute-forced back to the value");
});

/**
 * No key, no digest — and emphatically not an unkeyed one. The counter is
 * less useful and never weaker.
 */
test("with no key it falls back to the counter, and still round-trips", () => {
  const { text, vault } = pseudonymize(LINE, { terms: TERMS });
  assert.ok(text.includes("[PII:PERSON:1]"), `expected the counter, got: ${text}`);
  assert.equal(rehydrate(text, vault), LINE);
});

test("two different people never share a token", () => {
  const { text } = pseudonymize("דנה כהן ו נועה בר", {
    key: "a-secret",
    terms: [{ value: "דנה כהן", kind: "person" }, { value: "נועה בר", kind: "person" }],
  });
  const tokens = text.match(/\[PII:PERSON:[0-9a-f]+\]/g) ?? [];
  assert.equal(tokens.length, 2, `expected two tokens, got ${JSON.stringify(text)}`);
  assert.notEqual(tokens[0], tokens[1], "two people collapsed onto one token — re-hydration would name the wrong one");
});

test("a vault says whether its tokens are stable", () => {
  assert.equal(new Vault("a-secret").stable, true);
  assert.equal(new Vault().stable, false);
});

test("a supplied vault's key wins over the option", () => {
  const vault = new Vault();
  const { text } = pseudonymize(LINE, { terms: TERMS, key: "a-secret", vault });
  assert.ok(text.includes("[PII:PERSON:1]"), `the unkeyed vault should mint counters: ${text}`);
});

console.log(`\n✓ pseudonymize — ${passed} checks passed\n`);
