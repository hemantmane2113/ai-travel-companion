import { describe, expect, it } from 'vitest';
import { generateValidatedStructuredOutput, type StructuredGenerationConfig } from '../src/ai/generate-validated-structured-output';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';

// A deliberately non-itinerary shape - proves the primitive genuinely
// doesn't know about days/places/warnings, only "items with fact
// references" in whatever structure the caller declares.
interface TestItem {
  id: string;
  factReferences: string[];
}

interface TestOutput {
  items: TestItem[];
}

function isWellFormedOutput(value: unknown): value is TestOutput {
  return typeof value === 'object' && value !== null && Array.isArray((value as TestOutput).items);
}

function isWellFormedItem(value: unknown): value is TestItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as TestItem;
  return (
    typeof item.id === 'string' &&
    Array.isArray(item.factReferences) &&
    item.factReferences.every((f) => typeof f === 'string')
  );
}

const CONFIG: StructuredGenerationConfig<TestOutput, TestItem> = {
  isWellFormedOutput,
  isWellFormedItem,
  extractItems: (parsed) => parsed.items,
  getReferencedIds: (item) => item.factReferences,
};

describe('generateValidatedStructuredOutput', () => {
  it('grounds an item whose fact references were all supplied', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({ items: [{ id: 'a', factReferences: ['fv-1'] }] }),
    );

    const result = await generateValidatedStructuredOutput(
      provider,
      'system',
      'user',
      new Set(['fv-1', 'fv-2']),
      CONFIG,
    );

    expect(result.parsed.items).toHaveLength(1);
    expect(result.groundedItems.has(result.parsed.items[0])).toBe(true);
    expect(result.rejectedItems).toHaveLength(0);
  });

  it('rejects an item citing a fact_version id that was never supplied', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({ items: [{ id: 'a', factReferences: ['fv-fabricated'] }] }),
    );

    const result = await generateValidatedStructuredOutput(
      provider,
      'system',
      'user',
      new Set(['fv-1']),
      CONFIG,
    );

    expect(result.groundedItems.size).toBe(0);
    expect(result.rejectedItems).toEqual([{ id: 'a', factReferences: ['fv-fabricated'] }]);
  });

  it('partitions a mixed batch into grounded and rejected independently', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        items: [
          { id: 'grounded', factReferences: ['fv-1'] },
          { id: 'fabricated', factReferences: ['fv-does-not-exist'] },
          { id: 'also-grounded', factReferences: ['fv-1', 'fv-2'] },
        ],
      }),
    );

    const result = await generateValidatedStructuredOutput(
      provider,
      'system',
      'user',
      new Set(['fv-1', 'fv-2']),
      CONFIG,
    );

    const groundedIds = result.parsed.items.filter((i) => result.groundedItems.has(i)).map((i) => i.id);
    expect(groundedIds).toEqual(['grounded', 'also-grounded']);
    expect(result.rejectedItems.map((i) => i.id)).toEqual(['fabricated']);
  });

  it('drops a structurally malformed item without treating it as a rejected fact claim', async () => {
    const provider = new FakeLlmProvider(
      JSON.stringify({
        items: [{ id: 'kept', factReferences: ['fv-1'] }, { not: 'a valid item' }],
      }),
    );

    const result = await generateValidatedStructuredOutput(
      provider,
      'system',
      'user',
      new Set(['fv-1']),
      CONFIG,
    );

    expect(result.groundedItems.size).toBe(1);
    expect(result.rejectedItems).toHaveLength(0);
  });

  it('throws when the model response is not valid JSON', async () => {
    const provider = new FakeLlmProvider('this is not json');

    await expect(
      generateValidatedStructuredOutput(provider, 'system', 'user', new Set(), CONFIG),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the model response does not match the caller-declared schema', async () => {
    const provider = new FakeLlmProvider(JSON.stringify({ wrong: 'shape' }));

    await expect(
      generateValidatedStructuredOutput(provider, 'system', 'user', new Set(), CONFIG),
    ).rejects.toThrow(/did not match the expected schema/);
  });
});
