import type { KnowledgeDocumentMatch } from '../knowledge/retrieve-knowledge';
import type { LlmProvider } from './llm-provider';
import {
  generateValidatedStructuredOutput,
  type StructuredGenerationConfig,
} from './generate-validated-structured-output';

export interface KnowledgeNarrationResult {
  answer: string;
  /** true when the LLM was skipped/failed/produced ungrounded output and this is the deterministic-only fallback instead (same posture as comparison-narration.ts). */
  fellBackToDeterministic: boolean;
}

interface KnowledgeCitation {
  documentId: string;
  note: string;
}

interface KnowledgeNarrationOutput {
  answer: string;
  citations: KnowledgeCitation[];
}

const SYSTEM_PROMPT = `You are a travel information assistant. You will be given a list of
already-retrieved knowledge documents (visa/advisory/other factual travel information) -
each identified by a documentId. Using ONLY that supplied information, produce an answer
as JSON matching exactly this shape:
{
  "answer": string,
  "citations": [
    { "documentId": string, "note": string }
  ]
}
Rules:
- Every "documentId" in "citations" MUST be copied exactly, character-for-character,
  from the supplied document list. Never invent a documentId.
- Do not state anything as fact that is not present in the supplied document content.
  If the documents don't fully answer the question, say so honestly rather than filling
  the gap yourself.
- Respond with JSON only, no other text.`;

function isWellFormedCitation(value: unknown): value is KnowledgeCitation {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as KnowledgeCitation;
  return typeof item.documentId === 'string' && typeof item.note === 'string';
}

function isWellFormedOutput(value: unknown): value is KnowledgeNarrationOutput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as KnowledgeNarrationOutput;
  return typeof candidate.answer === 'string' && Array.isArray(candidate.citations);
}

const NARRATION_CONFIG: StructuredGenerationConfig<KnowledgeNarrationOutput, KnowledgeCitation> = {
  isWellFormedOutput,
  isWellFormedItem: isWellFormedCitation,
  extractItems: (parsed) => parsed.citations,
  getReferencedIds: (item) => [item.documentId],
};

function buildUserPrompt(documents: KnowledgeDocumentMatch[], question: string): string {
  const docLines = documents.map(
    (d) => `- documentId=${d.id} category=${d.category} title="${d.title}" content="${d.content}" source="${d.sourceName}"`,
  );
  return [`Question: ${question}`, `Retrieved documents (${documents.length}):`, docLines.join('\n')].join('\n\n');
}

/** Deterministic-only answer - no LLM involved, always available regardless of model health. Presents the top-ranked retrieved document's own content verbatim, with its source, rather than any paraphrase. */
function deterministicFallback(documents: KnowledgeDocumentMatch[]): string {
  const top = documents[0];
  const sourceSuffix = top.sourceUrl ? `, ${top.sourceUrl}` : '';
  return `${top.content} (Source: ${top.sourceName}${sourceSuffix})`;
}

/**
 * The RAG grounding step (V2 architecture Phase 6 §4): reuses the exact
 * same generic grounded-generation primitive comparison narration uses
 * (Phase 1) - documentId-membership checked the same way offerId/
 * fact_version ids are, not a second grounding implementation. The LLM
 * is never authoritative for what a document says: this function's
 * output is prose only, and any citation naming a documentId outside
 * the supplied retrieved set - or any failure at all (bad JSON, wrong
 * shape, provider error/timeout) - discards the ENTIRE answer in favor
 * of the deterministic-only fallback (the top retrieved document's own
 * text, verbatim), never a partially-trusted result.
 */
export async function narrateKnowledge(
  provider: LlmProvider,
  documents: KnowledgeDocumentMatch[],
  question: string,
): Promise<KnowledgeNarrationResult> {
  if (documents.length === 0) {
    throw new Error('narrateKnowledge requires at least one retrieved document - callers must handle the no-results case themselves.');
  }

  const allowedDocumentIds = new Set(documents.map((d) => d.id));

  try {
    const { parsed, rejectedItems } = await generateValidatedStructuredOutput(
      provider,
      SYSTEM_PROMPT,
      buildUserPrompt(documents, question),
      allowedDocumentIds,
      NARRATION_CONFIG,
    );

    if (rejectedItems.length > 0) {
      return { answer: deterministicFallback(documents), fellBackToDeterministic: true };
    }

    return { answer: parsed.answer, fellBackToDeterministic: false };
  } catch {
    return { answer: deterministicFallback(documents), fellBackToDeterministic: true };
  }
}
