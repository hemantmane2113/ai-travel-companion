import type { LlmProvider } from './llm-provider';

/**
 * Domain-agnostic contract a caller supplies to ground one structured LLM
 * response (V2 architecture Phase 1: extracted from AiOrchestrationService
 * so any future agent - not just itinerary generation - can reuse the same
 * "call model -> parse -> validate against supplied facts" mechanism
 * without this module knowing anything about itineraries, hotels, or any
 * other domain shape).
 */
export interface StructuredGenerationConfig<TParsed, TItem> {
  /** Top-level shape check (e.g. "has a summary string and a days array of well-formed days"). */
  isWellFormedOutput(value: unknown): value is TParsed;
  /**
   * Per-item shape check. An item that fails this never carried a
   * factual claim to begin with, so it is silently dropped rather than
   * treated as a grounding failure - it never appears in `rejectedItems`.
   */
  isWellFormedItem(value: unknown): value is TItem;
  /** Flattens whatever nested structure the domain uses (e.g. days -> items) into one list to grounding-check. */
  extractItems(parsed: TParsed): unknown[];
  /**
   * The id(s) a well-formed item claims to be grounded in - fact_version
   * ids for itinerary generation, offer ids for comparison narration
   * (V2 architecture Phase 4), or whatever id space a future caller's
   * domain uses. This primitive only ever checks membership; it has no
   * idea what kind of id it's checking.
   */
  getReferencedIds(item: TItem): string[];
}

export interface StructuredGenerationResult<TParsed, TItem> {
  /** The full parsed, shape-validated response - the caller reassembles its own domain structure from this. */
  parsed: TParsed;
  /**
   * Well-formed items whose every cited fact_version id was actually
   * supplied in `allowedIds`. Membership only - a caller with
   * additional domain-specific grounding rules (e.g. "must cite its own
   * fact, not just any supplied one") applies those on top of this set.
   */
  groundedItems: Set<TItem>;
  /** Well-formed items that cited at least one fact_version id never supplied - the system's core hallucination guard. */
  rejectedItems: TItem[];
}

/**
 * The only generic mechanism every future agent's "ask the model for
 * structured output, then trust nothing it didn't earn" step needs:
 * call the model, parse JSON, validate the caller's declared shape, and
 * check every item's cited fact_version ids against the exact set that
 * was actually supplied in context. Contains no domain-specific prompt,
 * schema, or business rule - those stay with the caller (e.g. itinerary
 * day-count enforcement, or a "place must cite its own fact" rule).
 */
export async function generateValidatedStructuredOutput<TParsed, TItem>(
  provider: LlmProvider,
  systemPrompt: string,
  userPrompt: string,
  allowedIds: Set<string>,
  config: StructuredGenerationConfig<TParsed, TItem>,
): Promise<StructuredGenerationResult<TParsed, TItem>> {
  const { text } = await provider.generate(systemPrompt, userPrompt);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new Error('LLM response was not valid JSON');
  }

  if (!config.isWellFormedOutput(parsedJson)) {
    throw new Error('LLM response did not match the expected schema');
  }
  const parsed = parsedJson;

  const groundedItems = new Set<TItem>();
  const rejectedItems: TItem[] = [];

  for (const rawItem of config.extractItems(parsed)) {
    if (!config.isWellFormedItem(rawItem)) {
      // Structurally invalid - never carried a factual claim to catch
      // in the first place, so it's dropped, not "rejected".
      continue;
    }

    const referencesExist = config.getReferencedIds(rawItem).every((id) => allowedIds.has(id));
    if (referencesExist) {
      groundedItems.add(rawItem);
    } else {
      rejectedItems.push(rawItem);
    }
  }

  return { parsed, groundedItems, rejectedItems };
}
