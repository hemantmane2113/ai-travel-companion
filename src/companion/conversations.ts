import type { Pool } from 'pg';

export type MessageRole = 'user' | 'assistant';

export interface MessageRow {
  id: string;
  role: MessageRole;
  content: string;
  structuredPayload: Record<string, unknown> | null;
  createdAt: string;
}

/** Starts a new, empty conversation thread. */
export async function createConversation(pool: Pool): Promise<string> {
  const result = await pool.query('insert into conversations default values returning id');
  return result.rows[0].id as string;
}

/** Confirms a conversation exists before appending to it - throws a plain Error the HTTP layer translates to 400/404, same pattern as an unknown destination elsewhere in this codebase. */
export async function requireConversation(pool: Pool, conversationId: string): Promise<string> {
  const result = await pool.query('select id from conversations where id = $1', [conversationId]);
  if (result.rows.length === 0) {
    throw new Error(`Unknown conversation: ${conversationId}`);
  }
  return conversationId;
}

/**
 * Appends one message to a conversation and bumps its updated_at. Every
 * Supervisor turn writes at least the user's message; a route that
 * completes synchronously (Q&A) also writes the assistant's reply here -
 * a route that only kicks off an async job (full trip) writes an
 * assistant acknowledgement carrying the jobId in structuredPayload, not
 * the eventual itinerary (that stays on the existing job/itinerary
 * tables, unchanged).
 */
export async function appendMessage(
  pool: Pool,
  conversationId: string,
  role: MessageRole,
  content: string,
  structuredPayload: Record<string, unknown> | null = null,
): Promise<void> {
  await pool.query(
    `insert into messages (conversation_id, role, content, structured_payload) values ($1, $2, $3, $4)`,
    [conversationId, role, content, structuredPayload ? JSON.stringify(structuredPayload) : null],
  );
  await pool.query('update conversations set updated_at = now() where id = $1', [conversationId]);
}

/** Full message history for a conversation, oldest first - not yet consumed by anything in Phase 2 (no multi-turn context is built from it), but needed for the migration to be independently verifiable/testable. */
export async function listMessages(pool: Pool, conversationId: string): Promise<MessageRow[]> {
  const result = await pool.query(
    `select id, role, content, structured_payload, created_at
     from messages where conversation_id = $1 order by created_at`,
    [conversationId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    structuredPayload: row.structured_payload,
    createdAt: row.created_at,
  }));
}
