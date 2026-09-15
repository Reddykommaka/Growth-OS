/**
 * The database handle shape shared by the identity repositories.
 *
 * These tables are GLOBAL — a user belongs to many organizations, so they carry no tenant
 * column and no RLS (05-data-architecture.md §3 level 1). Isolation for identity is the
 * application's job, and every query is keyed by an id the caller has already authenticated
 * or by a high-entropy token hash. None takes a tenant-supplied filter.
 *
 * The connection is still growth_os_app and still NOBYPASSRLS, so nothing here can reach a
 * tenant-scoped table either.
 */
/**
 * The subset of `pg` the identity repositories need.
 *
 * A Pool and a PoolClient both satisfy it, so a repository works standalone or inside a
 * caller's transaction without knowing which — which is what lets registration and its
 * verification token be written atomically.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}
