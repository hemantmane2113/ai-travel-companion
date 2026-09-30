import type { Pool } from 'pg';

export type TaskType = 'comparison' | 'booking' | 'cancellation';
export type TaskStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface TaskRow {
  id: string;
  conversationId: string;
  taskType: TaskType;
  status: TaskStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function toTaskRow(row: {
  id: string;
  conversation_id: string;
  task_type: TaskType;
  status: TaskStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}): TaskRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    taskType: row.task_type,
    status: row.status,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The generic `tasks` persistence service (V2 architecture Phase 4,
 * docs/architecture-v2-agent-companion.md §F): the generalization of
 * `itinerary_jobs`'s create -> status-transition -> result shape for
 * any workflow beyond planning. Comparison is the first consumer;
 * Booking is expected to reuse this same table/module later by adding a
 * new task_type, not a new table or module. Every SQL statement this
 * phase needs lives here - agents call these functions, never raw SQL
 * directly (plan §3: "agents orchestrate; deterministic services
 * execute").
 */
export async function createTask(pool: Pool, conversationId: string, taskType: TaskType): Promise<string> {
  const result = await pool.query(
    `insert into tasks (conversation_id, task_type, status) values ($1, $2, 'pending') returning id`,
    [conversationId, taskType],
  );
  return result.rows[0].id;
}

export async function markTaskProcessing(pool: Pool, taskId: string): Promise<void> {
  await pool.query(`update tasks set status = 'processing', updated_at = now() where id = $1`, [taskId]);
}

export async function completeTask(pool: Pool, taskId: string, result: unknown): Promise<void> {
  await pool.query(
    `update tasks set status = 'complete', result = $1, updated_at = now() where id = $2`,
    [JSON.stringify(result), taskId],
  );
}

export async function failTask(pool: Pool, taskId: string, error: string): Promise<void> {
  await pool.query(`update tasks set status = 'failed', error = $1, updated_at = now() where id = $2`, [
    error,
    taskId,
  ]);
}

export async function getTask(pool: Pool, taskId: string): Promise<TaskRow | null> {
  const result = await pool.query(
    `select id, conversation_id, task_type, status, result, error, created_at, updated_at
     from tasks where id = $1`,
    [taskId],
  );
  if (result.rows.length === 0) return null;
  return toTaskRow(result.rows[0]);
}

/**
 * The most recent task of a given type for a conversation, regardless of
 * status - used by ordinal follow-up resolution (plan §C/§J: "the second
 * one" resolves against the conversation's persisted comparison result,
 * never a fresh provider call). Only a 'complete' task actually has a
 * usable `result`; callers check status themselves rather than this
 * function silently filtering, so a 'failed' or still-'processing' task
 * can still produce an honest "no comparison result available yet"
 * response instead of appearing as if no task ever ran.
 */
export async function getLatestTaskForConversation(
  pool: Pool,
  conversationId: string,
  taskType: TaskType,
): Promise<TaskRow | null> {
  const result = await pool.query(
    `select id, conversation_id, task_type, status, result, error, created_at, updated_at
     from tasks where conversation_id = $1 and task_type = $2
     order by created_at desc limit 1`,
    [conversationId, taskType],
  );
  if (result.rows.length === 0) return null;
  return toTaskRow(result.rows[0]);
}
