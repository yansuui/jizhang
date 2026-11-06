/**
 * Tolerant recovery of a provider's JSON envelope.
 *
 * Chat Completions is asked for `response_format: {type: "json_object"}`, but a model (or the
 * gateway in front of it) can still wrap the object in a Markdown fence, prepend a sentence
 * of prose, or emit the object inside a larger text block. The strict incremental tokenizer
 * fails at the very first unexpected character, so before this module existed one such
 * reply threw away the whole generation — the user saw "本次回复未能完成" and the tool call
 * the model had already decided on was lost.
 *
 * Recovery is deliberately narrow and safe:
 *   * only the *shape* of the envelope is repaired; no field is invented or reinterpreted;
 *   * the last `JSON.parse` for an object still goes through the normal
 *     `normalizeAssistantProviderTurn` validation, so an object without a `message` string
 *     is still rejected;
 *   * plain prose is only accepted when it is the entire reply and carries no braces, so a
 *     half-written object can never be presented to the user as an answer.
 *
 * This module performs no I/O and holds no state, which keeps it cheap to unit-test.
 */

/** Fence markers a model may use around a JSON payload. */
const FENCE_PATTERN = /```[ \t]*(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/;

export interface RecoveredEnvelope {
  /** The parsed object, when the reply could be read as one. */
  readonly object?: unknown;
  /** Plain-text reply, when the model answered without any JSON object at all. */
  readonly text?: string;
  /** True when recovery had to strip a fence or surrounding prose. */
  readonly repaired: boolean;
}

/** Removes one surrounding Markdown fence, keeping the inner text verbatim. */
export function stripEnvelopeFence(text: string): string {
  const match = FENCE_PATTERN.exec(text);
  if (match === null || match[1] === undefined) return text;
  const inner = match[1].trim();
  return inner === '' ? text : inner;
}

/**
 * Extracts the outermost balanced `{...}` region from `text`.
 *
 * String literals and escapes are tracked so a `}` inside a quoted value cannot close the
 * object early. Returns null when the braces never balance (a truncated reply).
 */
export function extractBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseObject(candidate: string): unknown {
  const trimmed = candidate.trim();
  if (trimmed === '' || trimmed[0] !== '{') return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when `text` parses as JSON but is not an object (`[1,2]`, `"text"`, `42`, `true`).
 *
 * Such a reply must not be shown as prose: the model was asked for an object, so a bare JSON
 * array or scalar is a protocol failure and displaying it would misrepresent the answer.
 * Non-JSON text returns false, which is the ordinary prose case.
 */
function looksLikeJsonValue(text: string): boolean {
  const first = text[0];
  if (first === undefined) return false;
  if (first !== '[' && first !== '"' && first !== '-' && !(first >= '0' && first <= '9') &&
      first !== 't' && first !== 'f' && first !== 'n') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    // A quoted sentence is still prose; only a *complete* JSON value is refused above.
    return first === '[' && text.endsWith(']');
  }
}

/**
 * Recovers an envelope from raw provider text.
 *
 * Order of attempts, cheapest and safest first:
 *   1. the text exactly as received;
 *   2. the text with one Markdown fence removed;
 *   3. the outermost balanced object inside the text (prose before/after it);
 *   4. plain prose, only when the reply contains no braces at all.
 *
 * Returns `null` when nothing usable was found; the caller then keeps its existing
 * malformed-envelope behaviour rather than inventing a reply.
 */
export function recoverProviderEnvelope(raw: string): RecoveredEnvelope | null {
  const direct = parseObject(raw);
  if (direct !== undefined) return { object: direct, repaired: false };

  const unfenced = stripEnvelopeFence(raw);
  const fromFence = unfenced !== raw ? parseObject(unfenced) : undefined;
  if (fromFence !== undefined) return { object: fromFence, repaired: true };

  for (const candidate of unfenced === raw ? [raw] : [unfenced, raw]) {
    const balanced = extractBalancedObject(candidate);
    const fromSlice = balanced === null ? undefined : parseObject(balanced);
    if (fromSlice !== undefined) return { object: fromSlice, repaired: true };
  }

  // Plain prose: a reply with no braces at all cannot be a truncated object, so it is safe
  // to surface as the answer. Anything containing `{` or `}` is treated as a broken
  // envelope instead, because presenting half an object as prose would mislead the user.
  // A reply that merely *looks* like JSON (`[...]`, `"..."`, numbers) is also refused: the
  // model was asked for an object, so a different JSON shape is a protocol failure, not an
  // answer.
  const prose = unfenced.trim();
  if (prose !== '' && !/[{}]/.test(prose) && !looksLikeJsonValue(prose)) return { text: prose, repaired: true };
  return null;
}
