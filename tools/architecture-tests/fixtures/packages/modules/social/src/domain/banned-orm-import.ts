// VIOLATION: drizzle-orm may only appear in infrastructure/ (03-repository-structure.md §2).
import { sql } from 'drizzle-orm';
export const q = sql;
