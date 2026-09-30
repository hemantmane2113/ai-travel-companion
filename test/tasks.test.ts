import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createConversation } from '../src/companion/conversations';
import { completeTask, createTask, failTask, getLatestTaskForConversation, getTask, markTaskProcessing } from '../src/tasks/tasks';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

describe('tasks persistence', () => {
  it('creates a task in pending status, linked to its conversation', async () => {
    const conversationId = await createConversation(pool);
    const taskId = await createTask(pool, conversationId, 'comparison');

    const task = await getTask(pool, taskId);
    expect(task).not.toBeNull();
    expect(task!.conversationId).toBe(conversationId);
    expect(task!.taskType).toBe('comparison');
    expect(task!.status).toBe('pending');
    expect(task!.result).toBeNull();
    expect(task!.error).toBeNull();
  });

  it('transitions pending -> processing -> complete and persists the exact JSONB result', async () => {
    const conversationId = await createConversation(pool);
    const taskId = await createTask(pool, conversationId, 'comparison');

    await markTaskProcessing(pool, taskId);
    const processing = await getTask(pool, taskId);
    expect(processing!.status).toBe('processing');

    const result = { offers: [{ offerId: 'a' }, { offerId: 'b' }], narrative: 'test narrative', nested: { ok: true } };
    await completeTask(pool, taskId, result);

    const complete = await getTask(pool, taskId);
    expect(complete!.status).toBe('complete');
    expect(complete!.result).toEqual(result);
    // Ordering inside the persisted JSONB array must survive exactly.
    expect((complete!.result as { offers: Array<{ offerId: string }> }).offers.map((o) => o.offerId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('transitions to failed with an error message and no result', async () => {
    const conversationId = await createConversation(pool);
    const taskId = await createTask(pool, conversationId, 'comparison');

    await failTask(pool, taskId, 'simulated failure');

    const task = await getTask(pool, taskId);
    expect(task!.status).toBe('failed');
    expect(task!.error).toBe('simulated failure');
    expect(task!.result).toBeNull();
  });

  it('returns null for an unknown task id', async () => {
    const task = await getTask(pool, '00000000-0000-0000-0000-000000000000');
    expect(task).toBeNull();
  });

  it('getLatestTaskForConversation returns the most recently created task of that type', async () => {
    const conversationId = await createConversation(pool);
    const first = await createTask(pool, conversationId, 'comparison');
    await completeTask(pool, first, { offers: [], marker: 'first' });

    // created_at has second-level-ish resolution in practice but insertion
    // order within the same transactionless connection is still exactly
    // reflected by `order by created_at desc` for two sequential inserts.
    const second = await createTask(pool, conversationId, 'comparison');
    await completeTask(pool, second, { offers: [], marker: 'second' });

    const latest = await getLatestTaskForConversation(pool, conversationId, 'comparison');
    expect(latest!.id).toBe(second);
    expect((latest!.result as { marker: string }).marker).toBe('second');
  });

  it('getLatestTaskForConversation returns null when no task of that type exists for the conversation', async () => {
    const conversationId = await createConversation(pool);
    const latest = await getLatestTaskForConversation(pool, conversationId, 'comparison');
    expect(latest).toBeNull();
  });

  it('scopes tasks to their own conversation - a task from a different conversation is never returned', async () => {
    const conversationA = await createConversation(pool);
    const conversationB = await createConversation(pool);
    await createTask(pool, conversationA, 'comparison');

    const latestForB = await getLatestTaskForConversation(pool, conversationB, 'comparison');
    expect(latestForB).toBeNull();
  });
});
