/**
 * Safe string truncation.
 *
 * Truncating by code-unit count can land between the two halves of a UTF-16
 * surrogate pair (an emoji, or any astral-plane character). The lone surrogate
 * that remains is not valid text: `JSON.stringify` renders it as a `\ud83d`
 * escape and OpenAI-compatible upstreams reject the entire request with
 * 400 "failed to parse JSON". Every user-visible/tool-output truncation goes
 * through here so a cut can never produce an unpaired surrogate.
 */

/**
 * Replace unpaired surrogates with U+FFFD. Equivalent to `String#toWellFormed`
 * (ES2024) but available on the ES2023 lib target this package compiles against.
 */
export function toWellFormed(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += str[i]! + str[i + 1]!;
        i++;
      } else {
        out += '\uFFFD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += str[i]!;
    }
  }
  return out;
}

/** True when `str` ends on an unpaired high surrogate. */
function endsWithLoneHighSurrogate(str: string): boolean {
  const last = str.charCodeAt(str.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
}

/**
 * Truncate to at most `maxLength` code units without splitting a surrogate
 * pair. The result is one shorter than the limit when the cut would have
 * separated a pair, so no character is silently replaced.
 */
export function truncateSafely(str: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (str.length <= maxLength) return str;
  const cut = str.slice(0, maxLength);
  return endsWithLoneHighSurrogate(cut) ? cut.slice(0, -1) : cut;
}

/** Keep the first `headLength` and last `tailLength` code units, joined by
 *  `marker`, without splitting a surrogate pair at either cut. */
export function truncateMiddle(
  str: string,
  headLength: number,
  tailLength: number,
  marker: string,
): string {
  if (headLength <= 0 && tailLength <= 0) return '';
  const head = truncateSafely(str, headLength);
  if (str.length <= headLength + tailLength) return str;
  const start = Math.max(headLength, str.length - tailLength);
  // Drop a leading low surrogate left behind by the tail cut.
  let tail = str.slice(start);
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return head + marker + tail;
}

/** A serialised lone surrogate (`\ud800`–`\udfff`) — never valid on the wire. */
export const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/**
 * Rewrite every unpaired surrogate in a structured value to U+FFFD.
 *
 * A lone surrogate cannot be encoded as UTF-8; `JSON.stringify` escapes it as
 * `\ud83d`, which strict upstreams reject with 400 "failed to parse JSON" —
 * killing a whole turn over one truncated emoji. Truncation sites cut on pair
 * boundaries, but a request body can also arrive already broken (replayed from
 * an older session, produced by a third-party tool, or decoded off the wire),
 * so each provider normalises at the serialization boundary rather than
 * trusting every producer.
 */
export function normaliseSurrogates<T>(value: T): T {
  if (typeof value === 'string') return repairSurrogates(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => normaliseSurrogates(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[repairSurrogates(k)] = normaliseSurrogates(v);
    }
    return out as unknown as T;
  }
  return value;
}

function repairSurrogates(str: string): string {
  // Fast path: most strings contain no surrogates at all.
  if (!/[\uD800-\uDFFF]/.test(str)) return str;
  return toWellFormed(str);
}

/**
 * Serialise a request body for the wire, repairing lone surrogates only when
 * one is actually present. The common case is a single `JSON.stringify` with
 * no extra allocation — important for bodies carrying inline images, which can
 * reach tens of megabytes.
 */
export function stringifyForWire(value: unknown): string {
  const json = JSON.stringify(value);
  return LONE_SURROGATE_ESCAPE.test(json)
    ? JSON.stringify(normaliseSurrogates(value))
    : json;
}