/**
 * The scan gate.
 *
 * 10-security-architecture.md §3: an "async malware scan gates `scan_status` before a file is
 * usable". This module is the state machine for that verdict, and the column it writes is one the
 * application role is denied — a request-serving session that could set `scan_status = 'clean'`
 * would defeat the whole control with a statement RLS allows, because the row passes the tenant
 * predicate.
 *
 * WHAT IS HERE AND WHAT IS NOT. The claim-verdict protocol, its concurrency and its terminal states
 * are here and tested. The SCANNER is not: it requires an engine (ClamAV or a provider API) and it
 * requires reading the bytes out of object storage, neither of which exists yet. ADR-0022 records the
 * dependency and the exact acceptance condition, and `scanUnusable` below is what makes the gap safe
 * in the meantime — an unscanned file is not downloadable, so "no scanner" degrades to "no uploads are
 * usable" rather than to "unscanned files are served".
 */
import type { Queryable } from './ports.js';

export type ScanVerdict = 'clean' | 'infected' | 'failed';

export interface PendingScan {
  readonly fileId: string;
  readonly organizationId: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/**
 * What performs the scan. Supplied by the worker; a recorder in tests.
 *
 * Returns a verdict rather than throwing on a detection: an infected file is a normal, expected
 * outcome that must be recorded, not an error that aborts a batch. `failed` is the error case — the
 * engine was unreachable, or the object could not be read — and it is deliberately NOT `clean`.
 */
export interface FileScanner {
  scan(file: PendingScan): Promise<{ readonly verdict: ScanVerdict; readonly detail?: string }>;
}

/*
 * `FOR UPDATE SKIP LOCKED`, so several worker replicas share the queue without a distributed lock.
 * Ordered by `finalized_at` so the oldest unscanned file is scanned first — which is what makes the
 * backlog's age a meaningful signal rather than a function of which row happened to be picked.
 */
const CLAIM = `
  SELECT id, organization_id, storage_key, mime_type, size_bytes
    FROM files
   WHERE status = 'ready' AND scan_status = 'pending'
   ORDER BY finalized_at
   LIMIT $1
   FOR UPDATE SKIP LOCKED`;

/*
 * The verdict, in one statement, with `scan_status = 'pending'` in the predicate.
 *
 * An infected verdict also moves `status` to `rejected`, in the SAME statement. Two statements could
 * leave a file recorded as infected and still `ready`, and `ready` is half of what makes a file
 * downloadable — so the window between them would be a window in which an infected file was
 * serveable.
 */
const RECORD = `
  UPDATE files
     SET scan_status = $2,
         scan_detail = left($3, 500),
         scanned_at = $4,
         status = CASE WHEN $2 = 'infected' THEN 'rejected' ELSE status END
   WHERE id = $1 AND scan_status = 'pending'`;

interface Row {
  id: string;
  organization_id: string;
  storage_key: string;
  mime_type: string;
  size_bytes: string;
}

/**
 * Asks the scanner, and turns a throw into a verdict.
 *
 * A THROWING SCANNER IS `failed`, NEVER `clean`. Treating an engine error as a pass is the single worst
 * thing this module could do: it would serve unscanned files precisely when the scanner was broken,
 * which is exactly when serving them is most dangerous.
 */
async function verdictFor(
  scanner: FileScanner,
  row: Row,
): Promise<{ verdict: ScanVerdict; detail?: string }> {
  try {
    return await scanner.scan({
      fileId: row.id,
      organizationId: row.organization_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
    });
  } catch (error) {
    return {
      verdict: 'failed',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

export interface ScanPass {
  readonly clean: number;
  readonly infected: number;
  readonly failed: number;
}

export interface ScanTransactor {
  run<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
}

export interface ScanOptions {
  readonly batchSize?: number;
  readonly now?: () => Date;
}

/**
 * One scan pass.
 *
 * A failure does NOT stop the batch, for the same reason the mail sender's does not: files are
 * independent, and one unreadable object must not hold up every other tenant's uploads. Unlike the
 * mail sender there is no retry counter here — a `failed` verdict is terminal for this pass and the
 * file is picked up again only if something resets it, deliberately, because an automatic retry loop
 * on a scanner error is how a broken engine turns into an unbounded bill.
 */
export async function scanOnce(
  transactor: ScanTransactor,
  scanner: FileScanner,
  options: ScanOptions = {},
): Promise<ScanPass> {
  const batchSize = options.batchSize ?? 20;
  const now = options.now ?? (() => new Date());

  return transactor.run(async (client) => {
    const claimed = await client.query<Row>(CLAIM, [batchSize]);
    let clean = 0;
    let infected = 0;
    let failed = 0;

    for (const row of claimed.rows) {
      const { verdict, detail } = await verdictFor(scanner, row);
      await client.query(RECORD, [row.id, verdict, detail ?? null, now()]);
      if (verdict === 'clean') clean += 1;
      else if (verdict === 'infected') infected += 1;
      else failed += 1;
    }

    return { clean, infected, failed };
  });
}

export interface ScanBacklog {
  readonly awaiting: number;
  /** Null when nothing is awaiting — distinct from zero seconds of backlog. */
  readonly oldestSeconds: number | null;
  readonly infected: number;
  readonly failed: number;
}

/** Reads the backlog from migration 0017's one definition. */
export async function readScanBacklog(client: Queryable): Promise<ScanBacklog> {
  const result = await client.query<{
    awaiting: string;
    oldest_seconds: number | null;
    infected: string;
    failed: string;
  }>('SELECT awaiting, oldest_seconds, infected, failed FROM file_scan_backlog()');
  const row = result.rows[0];
  return {
    awaiting: Number(row?.awaiting ?? 0),
    oldestSeconds: row?.oldest_seconds ?? null,
    infected: Number(row?.infected ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

/**
 * Whether a file in this state may be handed to a user.
 *
 * Exported so the rule exists once. `requestDownload` enforces it in SQL, and anything else that
 * ever needs to ask — a listing, an export, a marketplace fulfilment — asks here rather than
 * re-implementing `status === 'ready' && scan_status === 'clean'` and getting one of the two wrong.
 */
export const isUsable = (file: { status: string; scanStatus: string }): boolean =>
  file.status === 'ready' && file.scanStatus === 'clean';

/** The inverse, named, because the safe default is the interesting one. */
export const scanUnusable = (file: { status: string; scanStatus: string }): boolean =>
  !isUsable(file);
