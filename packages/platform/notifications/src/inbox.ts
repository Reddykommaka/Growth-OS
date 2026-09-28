/**
 * The in-app inbox.
 *
 * Every query here runs under the notifications policy, which confines it to
 * `recipient_user_id = app_current_user_id()`. That is why none of these functions take a user
 * id: passing one would invite a caller to pass somebody else's, and the only reason it would
 * fail is a policy the caller cannot see. The session's own identity is the parameter.
 */
import type { Queryable } from './ports.js';

export interface InboxEntry {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly workspaceId: string | null;
  readonly actorUserId: string | null;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

export interface InboxPage {
  readonly entries: readonly InboxEntry[];
  /** Pass as `before` to fetch the next page. Null when the last page was returned. */
  readonly nextCursor: Date | null;
}

export interface InboxQuery {
  readonly limit?: number;
  /** Keyset pagination on `created_at`. Null/absent starts at the newest. */
  readonly before?: Date | undefined;
  readonly unreadOnly?: boolean;
}

/** Bounded so a caller cannot ask for an unbounded page and turn a UI into a table scan. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

interface Row {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  workspace_id: string | null;
  actor_user_id: string | null;
  created_at: Date;
  read_at: Date | null;
}

/*
 * Keyset pagination, not OFFSET.
 *
 * An inbox has new rows arriving at the top while it is being paged. With OFFSET, one arrival
 * shifts every subsequent page by one and the reader silently skips an entry — the failure is
 * invisible and the entry is the one thing the page existed to show. A cursor on created_at is
 * stable against insertion, and the partial index on (recipient_user_id, created_at DESC) serves
 * it directly.
 */
const SELECT_PAGE = `
  SELECT id, type, payload, workspace_id, actor_user_id, created_at, read_at
    FROM notifications
   WHERE ($1::timestamptz IS NULL OR created_at < $1)
     AND ($2::boolean IS FALSE OR read_at IS NULL)
   ORDER BY created_at DESC
   LIMIT $3`;

export async function readInbox(client: Queryable, query: InboxQuery = {}): Promise<InboxPage> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  // One row beyond the page, so "is there more" is answered without a second count query —
  // which on an inbox would be a second full scan to render a chevron.
  const result = await client.query<Row>(SELECT_PAGE, [
    query.before ?? null,
    query.unreadOnly ?? false,
    limit + 1,
  ]);

  const rows = result.rows.slice(0, limit);
  const entries = rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
    readAt: row.read_at,
  }));

  return {
    entries,
    nextCursor:
      result.rows.length > limit ? (entries[entries.length - 1]?.createdAt ?? null) : null,
  };
}

export async function countUnread(client: Queryable): Promise<number> {
  const result = await client.query<{ unread: string }>(
    'SELECT count(*) AS unread FROM notifications WHERE read_at IS NULL',
  );
  return Number(result.rows[0]?.unread ?? 0);
}

/**
 * Marks one notification read. Returns false when there was nothing to mark.
 *
 * `AND read_at IS NULL` keeps the FIRST read timestamp rather than the latest. Without it, a
 * second click would move the timestamp, and "when did you see this" is exactly the question a
 * security notice exists to answer.
 */
export async function markRead(client: Queryable, id: string, at: Date): Promise<boolean> {
  const result = await client.query(
    'UPDATE notifications SET read_at = $2 WHERE id = $1 AND read_at IS NULL',
    [id, at],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Marks every unread notification read, returning how many changed. */
export async function markAllRead(client: Queryable, at: Date): Promise<number> {
  const result = await client.query('UPDATE notifications SET read_at = $1 WHERE read_at IS NULL', [
    at,
  ]);
  return result.rowCount ?? 0;
}

/** Dismisses one notification. The policy confines it to the caller's own rows. */
export async function dismiss(client: Queryable, id: string): Promise<boolean> {
  const result = await client.query('DELETE FROM notifications WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}
