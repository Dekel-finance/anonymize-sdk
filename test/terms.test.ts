/**
 * The name list machinery: cache, staleness, and the refusal to fail open.
 *
 * Run: `npx tsx test/terms.test.ts`
 */
import { strict as assert } from "node:assert";
import { MAX_TERMS } from "../src/pseudonymize.js";
import { TermsCache, normalizeTerms } from "../src/terms.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}\n  ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

const silent = () => {};

// ── normalizeTerms ──────────────────────────────────────────────────────────

await test("names are deduped case-insensitively and short ones dropped", () => {
  const terms = normalizeTerms([
    { value: "Dana Cohen", kind: "person" },
    { value: "dana cohen", kind: "person" },
    { value: "A", kind: "person" },
    { value: "  ", kind: "person" },
    { value: "Acme Ltd", kind: "org" },
  ]);
  assert.deepEqual(
    terms.map((t) => `${t.kind}:${t.value}`),
    ["person:Dana Cohen", "org:Acme Ltd"],
  );
});

await test("the same string can be both a person and an org", () => {
  const terms = normalizeTerms([
    { value: "Levi", kind: "person" },
    { value: "Levi", kind: "org" },
  ]);
  assert.equal(terms.length, 2);
});

await test("over the cap, the longest (most specific) names survive", () => {
  const raw = Array.from({ length: MAX_TERMS + 10 }, (_, i) => ({
    value: `name-${String(i).padStart(6, "0")}${"x".repeat(i % 7)}`,
    kind: "person" as const,
  }));
  const terms = normalizeTerms(raw);
  assert.equal(terms.length, MAX_TERMS);
  for (let i = 1; i < terms.length; i++) {
    assert.ok(terms[i - 1].value.length >= terms[i].value.length, "not sorted longest-first");
  }
});

// ── TermsCache ──────────────────────────────────────────────────────────────

await test("a scope's names are loaded once inside the TTL", async () => {
  let calls = 0;
  const cache = new TermsCache(async () => {
    calls++;
    return [{ value: "Dana Cohen", kind: "person" as const }];
  }, { ttlMs: 60_000 });
  await cache.forScope("a1");
  const again = await cache.forScope("a1");
  assert.equal(calls, 1, "the provider was called for a fresh entry");
  assert.equal(again[0].value, "Dana Cohen");
});

await test("an undefined scope returns an empty list without calling the provider", async () => {
  let calls = 0;
  const cache = new TermsCache(async () => {
    calls++;
    return [];
  });
  assert.deepEqual(await cache.forScope(undefined), []);
  assert.equal(calls, 0);
});

await test("a provider failure serves the stale list rather than none", async () => {
  // The names in an expired entry are still names; an empty list is a silent
  // downgrade of protection.
  let fail = false;
  const cache = new TermsCache(
    async () => {
      if (fail) throw new Error("db down");
      return [{ value: "Dana Cohen", kind: "person" as const }];
    },
    { ttlMs: 0, onError: silent },
  );
  await cache.forScope("a1");
  fail = true;
  const stale = await cache.forScope("a1");
  assert.equal(stale[0]?.value, "Dana Cohen", "the stale entry was not served");
});

await test("with no entry at all, the failure is the caller's decision", async () => {
  // Failing open here — returning [] on error — is the one behaviour this
  // class exists to prevent. An enforcing caller refuses the request instead.
  const cache = new TermsCache(async () => {
    throw new Error("db down");
  }, { onError: silent });
  await assert.rejects(() => cache.forScope("a1"), /db down/);
});

await test("enabled: false turns the lookup off explicitly", async () => {
  let calls = 0;
  const cache = new TermsCache(async () => {
    calls++;
    return [{ value: "Dana Cohen", kind: "person" as const }];
  }, { enabled: false });
  assert.deepEqual(await cache.forScope("a1"), []);
  assert.equal(calls, 0, "the provider was called while disabled");
  assert.equal(cache.enabled, false, "the flag is not readable for a status surface");
});

await test("clear() drops the cache so a rename is picked up", async () => {
  let name = "Old Name";
  const cache = new TermsCache(async () => [{ value: name, kind: "person" as const }], { ttlMs: 60_000 });
  await cache.forScope("a1");
  name = "New Name";
  cache.clear();
  const terms = await cache.forScope("a1");
  assert.equal(terms[0].value, "New Name");
});

if (failures.length) {
  console.error(`\n✗ terms — ${failures.length} failed\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
} else {
  console.log(`\n✓ terms — ${passed} checks passed\n`);
}
