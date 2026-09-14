export interface FactVersionCandidate {
  id: string;
  sourcePriority: number;
  confidence: number;
  retrievedAt: Date;
}

/**
 * Deterministic conflict-resolution rule from plan §5: when two sources
 * disagree on the same fact, the higher-priority source's version becomes
 * `facts.current_version_id`. Ties are broken by the most recent retrieval.
 * Equal-priority conflicts are the caller's cue to cap confidence and treat
 * the fact as "unconfirmed" - this function only picks the winner, it does
 * not adjust confidence.
 */
export function resolveCurrentVersion(
  candidates: FactVersionCandidate[],
): FactVersionCandidate {
  if (candidates.length === 0) {
    throw new Error('resolveCurrentVersion requires at least one candidate');
  }

  return [...candidates].sort((a, b) => {
    if (b.sourcePriority !== a.sourcePriority) {
      return b.sourcePriority - a.sourcePriority;
    }
    return b.retrievedAt.getTime() - a.retrievedAt.getTime();
  })[0];
}
