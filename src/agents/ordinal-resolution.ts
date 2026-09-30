export type OrdinalParseResult =
  | { kind: 'resolved'; index: number }
  | { kind: 'none' }
  | { kind: 'ambiguous' };

const ORDINAL_TOKENS: Array<{ pattern: RegExp; index: number }> = [
  { pattern: /\bfirst\b|\b1st\b|#1\b/i, index: 0 },
  { pattern: /\bsecond\b|\b2nd\b|#2\b/i, index: 1 },
  { pattern: /\bthird\b|\b3rd\b|#3\b/i, index: 2 },
];

/**
 * The minimal deterministic ordinal parser (V2 architecture Phase 4
 * §J) - intentionally NOT the full entity/reference-resolution system
 * §C describes for later phases. Recognizes exactly "first"/"1st"/"#1",
 * "second"/"2nd"/"#2", "third"/"3rd"/"#3" (case-insensitive) and nothing
 * fuzzier - no semantic matching, no LLM. A message naming more than one
 * of these is ambiguous and must never be guessed at (plan §C's
 * clarify-don't-guess rule, applied at the smallest possible scope).
 */
export function parseOrdinal(message: string): OrdinalParseResult {
  const matchedIndexes = ORDINAL_TOKENS.filter(({ pattern }) => pattern.test(message)).map((t) => t.index);

  if (matchedIndexes.length === 0) return { kind: 'none' };
  if (matchedIndexes.length > 1) return { kind: 'ambiguous' };
  return { kind: 'resolved', index: matchedIndexes[0] };
}
