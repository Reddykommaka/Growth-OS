/**
 * Cursor pagination.
 *
 * Offset pagination is not offered: on a tenant-scoped table with concurrent writes it
 * silently skips and repeats rows, and its cost grows with the offset. Cursors are opaque
 * so the encoding can change without breaking a client.
 */
import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const pageRequestSchema = z.object({
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});
export type PageRequest = z.infer<typeof pageRequestSchema>;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export const emptyPage = <T>(): Page<T> => ({ items: [], nextCursor: null, hasMore: false });

export function encodeCursor(parts: Readonly<Record<string, string>>): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string') return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
