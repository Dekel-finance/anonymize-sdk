/**
 * The shapes a model request arrives in, and what is text in each.
 *
 * A proxy in front of two vendors faces two different JSON schemas. Rather
 * than two proxies, there is one pipeline and this file, which answers three
 * questions per wire format: which keys must never be rewritten, does this
 * body carry a document, and where in a streamed event is the text.
 *
 * Adding a third vendor is a new entry in `WIRES`, not a third code path.
 */

/** Which vendor wire a request is on. */
export type WireName = "anthropic" | "openai";

/**
 * Keys whose values are passed through untouched — kept as short as it can be.
 *
 * The instinct is to list every protocol field, and that instinct is wrong: a
 * skip list is a hole in the protection, so a key earns its place only if
 * rewriting it would actually break something. The default patterns are
 * specific — an identity number, a phone, an email, an amount — and none of
 * them match `assistant`, `text`, `content_block_delta` or `toolu_01A…`. So
 * `type`, `role`, `stop_reason` and the tool-id keys need no entry here; they
 * are already safe by construction, and listing them would only create places
 * for PII to hide behind a key name.
 *
 * `id` and `name` are the two that were once on this list and have been
 * deliberately taken off. They are the *most* likely keys in any schema to
 * hold a person — `{"name": "דנה כהן"}`, `{"id": "012345678"}` — and skipping
 * them to protect a vendor's `tool_use.id` would have traded a real leak for
 * a hypothetical break. Tool ids and tool names match no pattern, so they
 * survive anyway.
 *
 * What remains is the two things that genuinely must not be touched:
 *
 *  • **Payload bytes.** `file_data`, `source`, `data`, `url`, `b64_json`
 *    carry base64 documents and data URIs. A placeholder written into base64
 *    does not produce a redacted PDF, it produces a corrupt one, and the
 *    vendor's error will not say so. These are handled by the attachment
 *    machinery below instead.
 *  • **`model`.** A vendor model id is matched against a fixed list upstream;
 *    any rewrite turns a working request into a 404.
 */
const SKIP_KEYS: readonly string[] = ["model", "file_data", "data", "url", "b64_json", "source"];

/** The default skip list, exported for callers that walk bodies themselves. */
export const DEFAULT_SKIP_KEYS: readonly string[] = SKIP_KEYS;

export interface Wire {
  readonly name: WireName;
  /** Keys never rewritten, at any depth. */
  readonly skipKeys: readonly string[];
  /**
   * Pull the assistant's text out of one streamed event, and put it back.
   * Returns `null` when the event carries no text (ping, usage, start, stop).
   */
  readText(event: unknown): string | null;
  writeText(event: unknown, text: string): unknown;
  /** A synthetic event carrying `text`, used to flush the re-hydrator's tail. */
  flushEvent(text: string): { event?: string; data: unknown };
}

/**
 * Anthropic Messages: text arrives as `content_block_delta` with
 * `delta.type === "text_delta"`. Everything else in the stream is structure.
 */
const anthropic: Wire = {
  name: "anthropic",
  skipKeys: SKIP_KEYS,
  readText(event) {
    const e = event as { type?: string; delta?: { type?: string; text?: string } };
    if (e?.type !== "content_block_delta") return null;
    if (e.delta?.type !== "text_delta") return null;
    return e.delta.text ?? "";
  },
  writeText(event, text) {
    const e = event as { delta?: { text?: string } };
    return { ...(e as object), delta: { ...(e.delta as object), text } };
  },
  flushEvent(text) {
    return {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    };
  },
};

/**
 * OpenAI chat completions. Text arrives as `choices[].delta.content`.
 */
const openai: Wire = {
  name: "openai",
  skipKeys: SKIP_KEYS,
  readText(event) {
    const e = event as { choices?: { delta?: { content?: unknown } }[] };
    const content = e?.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : null;
  },
  writeText(event, text) {
    const e = event as { choices?: { delta?: Record<string, unknown> }[] };
    const choices = (e.choices ?? []).map((c, i) =>
      i === 0 ? { ...c, delta: { ...(c.delta ?? {}), content: text } } : c,
    );
    return { ...(e as object), choices };
  },
  flushEvent(text) {
    return { data: { object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] } };
  },
};

export const WIRES: Record<WireName, Wire> = { anthropic, openai };

/**
 * Does this request body carry a document rather than text?
 *
 * Looked for by structure, not by key name alone, because vendors express it
 * differently — Anthropic nests `{type:"image"|"document", source:{data}}`,
 * OpenAI-compatible wires use `{type:"file", file:{file_data}}` — and a
 * caller's SDK version may use either spelling. Any base64 data URI or any
 * `source.data` counts: the thing being detected is "bytes we cannot read",
 * and the cost of a false positive is a readable refusal while the cost of a
 * false negative is a payslip at a vendor.
 */
export function carriesAttachment(body: unknown): boolean {
  return countAttachments(body) > 0;
}

/**
 * How many documents this body carries.
 *
 * A count rather than a flag because an audit row wants how many documents
 * were read locally and how many were forwarded whole, and "true" cannot be
 * subtracted from "true". Counting the *outbound* body after local reading is
 * what makes "documents forwarded" an honest number instead of an inference.
 */
export function countAttachments(body: unknown): number {
  let found = 0;
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      // A data URI is unambiguous. The length floor keeps a short `data:`
      // string in prose from tripping it.
      if (node.length > 256 && /^data:[^;,]*;base64,/.test(node)) found++;
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (typeof node === "object") {
      const o = node as Record<string, unknown>;
      // Anthropic: {type:"image"|"document", source:{type:"base64", data}}
      if (o.source && typeof o.source === "object") {
        const s = o.source as Record<string, unknown>;
        if (typeof s.data === "string" && s.data.length > 256) {
          found++;
          // Do not descend: the data string would be counted a second time by
          // the string branch above.
          return;
        }
      }
      // OpenAI-compatible: {type:"file", file:{file_data}}
      if (o.file && typeof o.file === "object") {
        const f = o.file as Record<string, unknown>;
        if (typeof f.file_data === "string" && f.file_data.length > 256) {
          found++;
          return;
        }
      }
      // A plain attachment record: {filename, mimeType, data} with bare base64
      // and no `data:` prefix — the shape an internal broker or job queue is
      // likely to use. An attachment the walker cannot see is one no policy
      // can refuse. A `text` field on the same record is the entry after it
      // was read locally, and is deliberately NOT counted: it is no longer a
      // document.
      if (typeof o.mimeType === "string" && typeof o.data === "string" && o.data.length > 256) {
        found++;
        return;
      }
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(body);
  return found;
}

/** Is this body asking for a streamed response? */
export function wantsStream(body: unknown): boolean {
  return Boolean((body as { stream?: unknown } | null)?.stream);
}

/** One document found in a request body, decoded and ready to be read. */
export interface FoundAttachment {
  bytes: Buffer;
  mime: string;
  filename?: string;
  /** `image` blocks are screenshots as often as they are documents. */
  kind: "document" | "image";
}

/**
 * What a reader wants done with one attachment it was handed.
 *
 * Two answers, because there are two ways of making a document safe and they
 * produce different bodies. `text` is OCR reading a payslip and sending the
 * words — the attachment stops existing. `bytes` is the image redactor
 * painting over the identifying words in a screenshot — the attachment
 * survives, in the same slot and the same wire shape, carrying different
 * pixels. A bare string is the first case, kept because it is what most call
 * sites want to say.
 */
export type AttachmentReplacement =
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Buffer; mime: string };

function asReplacement(r: string | AttachmentReplacement | null): AttachmentReplacement | null {
  return typeof r === "string" ? { kind: "text", text: r } : r;
}

/** Pull the bytes out of a `data:` URI or a bare base64 string. */
function decode(raw: string, declaredMime?: string): { bytes: Buffer; mime: string } | null {
  const uri = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(raw);
  try {
    if (uri) {
      if (!uri[2]) return null; // percent-encoded data URIs are not something we send
      return { bytes: Buffer.from(uri[3], "base64"), mime: uri[1] || declaredMime || "application/octet-stream" };
    }
    return { bytes: Buffer.from(raw, "base64"), mime: declaredMime || "application/octet-stream" };
  } catch {
    return null;
  }
}

/**
 * Find every document in a request body and hand each to `read`, replacing it
 * with whatever comes back — text, or a cleaned copy of itself.
 *
 * This is what lets a scanned payslip take the ordinary path: by the time
 * `pseudonymizeDeep` runs, there is no document left in the body — only text,
 * which it knows how to protect. The alternative shape, pseudonymizing first
 * and OCR'ing after, would have meant a second pseudonymization pass over the
 * OCR output and two places where a name could be missed.
 *
 * `read` returning `null` means "leave this one alone" — the caller uses that
 * for images it has decided are screenshots rather than documents, and for
 * the case where OCR produced nothing usable. Both then fall to the caller's
 * attachment policy, so an unreadable document is never silently forwarded as
 * if it had been handled.
 *
 * The traversal is structural rather than key-name-based, for the same reason
 * `carriesAttachment` is: vendors spell an attachment differently and a
 * caller's SDK version may use either.
 */
export async function replaceAttachments(
  body: unknown,
  read: (found: FoundAttachment) => Promise<string | AttachmentReplacement | null>,
): Promise<{ body: unknown; replaced: number; redacted: number; skipped: number }> {
  let replaced = 0;
  let redacted = 0;
  let skipped = 0;

  const walk = async (node: unknown): Promise<unknown> => {
    if (node === null || node === undefined || typeof node !== "object") return node;
    if (Array.isArray(node)) return Promise.all(node.map(walk));

    const o = node as Record<string, unknown>;

    // OpenAI-compatible: {type:"file", file:{filename, file_data}}
    if (o.type === "file" && o.file && typeof o.file === "object") {
      const f = o.file as Record<string, unknown>;
      if (typeof f.file_data === "string") {
        const decoded = decode(f.file_data);
        if (decoded) {
          const r = asReplacement(
            await read({
              ...decoded,
              filename: typeof f.filename === "string" ? f.filename : undefined,
              kind: "document",
            }),
          );
          if (r?.kind === "text") {
            replaced++;
            return { type: "text", text: r.text };
          }
          if (r?.kind === "bytes") {
            redacted++;
            return {
              ...o,
              file: { ...f, file_data: `data:${r.mime};base64,${r.bytes.toString("base64")}` },
            };
          }
          skipped++;
          return node;
        }
      }
    }

    // Anthropic: {type:"document"|"image", source:{type:"base64", media_type, data}}
    if ((o.type === "document" || o.type === "image") && o.source && typeof o.source === "object") {
      const s = o.source as Record<string, unknown>;
      if (s.type === "base64" && typeof s.data === "string") {
        const decoded = decode(s.data, typeof s.media_type === "string" ? s.media_type : undefined);
        if (decoded) {
          const r = asReplacement(await read({ ...decoded, kind: o.type === "image" ? "image" : "document" }));
          if (r?.kind === "text") {
            replaced++;
            return { type: "text", text: r.text };
          }
          if (r?.kind === "bytes") {
            redacted++;
            // Same block, same slot, new pixels: a vision request that arrived
            // as an `image` must still BE an `image` on the way out, or the
            // model is handed a document block it will not look at.
            return { ...o, source: { ...s, media_type: r.mime, data: r.bytes.toString("base64") } };
          }
          skipped++;
          return node;
        }
      }
    }

    // The plain attachment record. Replaced with the same entry carrying
    // `text` instead of `data`, rather than with a vendor content block: the
    // caller that uses this shape assembles the prompt itself, so what it
    // needs back is an attachment it can fold into the user turn.
    if (typeof o.mimeType === "string" && typeof o.data === "string") {
      const decoded = decode(o.data, o.mimeType);
      if (decoded) {
        const r = asReplacement(
          await read({
            ...decoded,
            filename: typeof o.filename === "string" ? o.filename : undefined,
            kind: decoded.mime.startsWith("image/") ? "image" : "document",
          }),
        );
        if (r?.kind === "text") {
          replaced++;
          return { filename: o.filename, mimeType: "text/plain", text: r.text };
        }
        if (r?.kind === "bytes") {
          redacted++;
          return { ...o, mimeType: r.mime, data: r.bytes.toString("base64") };
        }
        skipped++;
        return node;
      }
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = await walk(v);
    return out;
  };

  return { body: await walk(body), replaced, redacted, skipped };
}
