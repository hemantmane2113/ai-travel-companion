import { describe, expect, it } from 'vitest';
import { narrateKnowledge } from '../src/ai/knowledge-narration';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import type { KnowledgeDocumentMatch } from '../src/knowledge/retrieve-knowledge';

function makeDocument(overrides: Partial<KnowledgeDocumentMatch> = {}): KnowledgeDocumentMatch {
  return {
    id: 'doc-default',
    category: 'visa',
    destinationSlug: 'delhi',
    title: 'Default document',
    content: 'Default document content.',
    sourceName: 'Test Source',
    sourceUrl: null,
    retrievedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('narrateKnowledge', () => {
  it('accepts a valid citation of a retrieved document and returns the LLM answer as-is', async () => {
    const doc = makeDocument({ id: 'doc-1', content: 'You need a visa to enter.' });
    const llm = new FakeLlmProvider(
      JSON.stringify({ answer: 'You need a visa to enter.', citations: [{ documentId: 'doc-1', note: 'Visa requirement.' }] }),
    );

    const result = await narrateKnowledge(llm, [doc], 'Do I need a visa?');
    expect(result.fellBackToDeterministic).toBe(false);
    expect(result.answer).toBe('You need a visa to enter.');
  });

  it('falls back to the deterministic top document when a citation names a fabricated document id', async () => {
    const doc = makeDocument({ id: 'doc-1', content: 'You need a visa to enter.', sourceName: 'Official Source' });
    const llm = new FakeLlmProvider(
      JSON.stringify({ answer: 'This cites something that was never retrieved.', citations: [{ documentId: 'fabricated-id', note: 'Fabricated.' }] }),
    );

    const result = await narrateKnowledge(llm, [doc], 'Do I need a visa?');
    expect(result.fellBackToDeterministic).toBe(true);
    expect(result.answer).not.toMatch(/never retrieved/);
    expect(result.answer).toContain('You need a visa to enter.');
    expect(result.answer).toContain('Official Source');
  });

  it('falls back to deterministic output when the LLM returns invalid JSON', async () => {
    const doc = makeDocument({ id: 'doc-1', content: 'You need a visa to enter.' });
    const llm = new FakeLlmProvider('not valid json at all');

    const result = await narrateKnowledge(llm, [doc], 'Do I need a visa?');
    expect(result.fellBackToDeterministic).toBe(true);
    expect(result.answer).toContain('You need a visa to enter.');
  });

  it('falls back to deterministic output when the LLM response does not match the expected schema', async () => {
    const doc = makeDocument({ id: 'doc-1', content: 'You need a visa to enter.' });
    const llm = new FakeLlmProvider(JSON.stringify({ somethingElse: true }));

    const result = await narrateKnowledge(llm, [doc], 'Do I need a visa?');
    expect(result.fellBackToDeterministic).toBe(true);
  });

  it('throws when called with no retrieved documents - callers must handle the no-results case themselves', async () => {
    const llm = new FakeLlmProvider('THIS MUST NEVER BE CALLED');
    await expect(narrateKnowledge(llm, [], 'anything')).rejects.toThrow(/requires at least one retrieved document/);
  });

  it('never presents unsupported knowledge as fact - the deterministic fallback only ever contains the retrieved document\'s own text', async () => {
    const doc = makeDocument({ id: 'doc-1', content: 'Only this exact sentence is verified.', sourceName: 'Verified Source' });
    const llm = new FakeLlmProvider(
      JSON.stringify({ answer: 'An entirely invented claim not grounded in anything.', citations: [{ documentId: 'made-up', note: 'x' }] }),
    );

    const result = await narrateKnowledge(llm, [doc], 'question');
    expect(result.answer).not.toMatch(/invented claim/);
    expect(result.answer).toBe('Only this exact sentence is verified. (Source: Verified Source)');
  });
});
