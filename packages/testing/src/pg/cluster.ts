/**
 * Throwaway PostgreSQL cluster for integration tests.
 *
 * 11-testing-architecture.md §2: integration tests run against real PostgreSQL, never a
 * mock or SQLite. A mocked database cannot fail to isolate a tenant, so it cannot verify
 * the control the entire multi-tenant promise rests on.
 *
 * This harness uses the PostgreSQL server binaries directly rather than Testcontainers.
 * 00-assessment.md §2 records why: the build environment has full PG 16 binaries but no
 * Docker daemon, and a suite that *requires* containers is unrunnable there. Testcontainers
 * remains a supported option where a daemon exists — never the only path.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ClusterHandle {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly superuser: string;
  /** Connection URL for the given database as the given role. */
  url(database: string, role?: string): string;
  stop(): void;
}

const PG_BIN_CANDIDATES = [
  '/usr/lib/postgresql/16/bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/pgsql-16/bin',
];

export function resolvePgBin(): string {
  if (process.env['PG_BIN'] !== undefined && existsSync(process.env['PG_BIN'])) {
    return process.env['PG_BIN'];
  }
  for (const dir of PG_BIN_CANDIDATES) {
    if (existsSync(join(dir, 'initdb'))) return dir;
  }
  // A PATH-resolved initdb (Homebrew, Nix, a developer's own install).
  const which = spawnSync('sh', ['-c', 'command -v initdb'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim() !== '') {
    return which.stdout.trim().replace(/\/initdb$/, '');
  }
  throw new Error(
    'PostgreSQL server binaries not found. Install postgresql-16 (or set PG_BIN). ' +
      'Integration tests require a real database — see docs/architecture/11-testing-architecture.md §2.',
  );
}

/**
 * PostgreSQL refuses to run as root. In CI and container images the tests typically run as
 * root, so the cluster is driven through an unprivileged account when necessary.
 */
function unprivilegedUser(): string | null {
  if (process.getuid?.() !== 0) return null;
  for (const candidate of ['postgres', 'nobody']) {
    const probe = spawnSync('id', ['-u', candidate], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    'Running as root and no unprivileged account (postgres, nobody) exists. ' +
      'PostgreSQL will not start as root. Create a postgres user or run the suite as a normal user.',
  );
}

function runAs(user: string | null, command: string, args: readonly string[]): void {
  if (user === null) {
    execFileSync(command, args, { stdio: 'pipe' });
    return;
  }
  // Quote each argument so paths and option strings survive the shell hop intact.
  const quoted = [command, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  execFileSync('su', [user, '-s', '/bin/bash', '-c', quoted], { stdio: 'pipe' });
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not allocate a port for the test cluster.'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export interface StartClusterOptions {
  /**
   * Durability is disabled: the data directory is deleted at the end of the run, so paying
   * for fsync buys nothing and roughly halves suite time.
   */
  readonly durable?: boolean;
  readonly superuser?: string;
}

export async function startCluster(options: StartClusterOptions = {}): Promise<ClusterHandle> {
  const bin = resolvePgBin();
  // Deliberately outside the growth_os_ namespace: the harness superuser is not a deployed
  // role, and naming it growth_os_* would let it masquerade as one in role-posture
  // assertions that scan that prefix.
  const superuser = options.superuser ?? 'gos_harness_super';
  const user = unprivilegedUser();

  const root = mkdtempSync(join(tmpdir(), 'growth-os-pg-'));
  // The unprivileged account must own and be able to traverse the directory.
  chmodSync(root, 0o777);
  if (user !== null) execFileSync('chown', ['-R', `${user}:${user}`, root], { stdio: 'pipe' });

  const dataDir = join(root, 'data');
  const port = await findFreePort();

  runAs(user, join(bin, 'initdb'), [
    '-D',
    dataDir,
    '-A',
    'trust', // The cluster listens only on loopback and lives for the test run.
    '-U',
    superuser,
    '--encoding=UTF8',
    '--locale=C',
    '--no-sync',
  ]);

  const settings = [
    `-p ${port}`,
    `-k ${root}`,
    '-c listen_addresses=127.0.0.1',
    ...(options.durable === true
      ? []
      : ['-c fsync=off', '-c full_page_writes=off', '-c synchronous_commit=off']),
    '-c max_connections=100',
    // Fail fast rather than queueing behind a lock we forgot to release.
    '-c lock_timeout=10s',
    '-c statement_timeout=60s',
    '-c log_min_messages=warning',
  ].join(' ');

  runAs(user, join(bin, 'pg_ctl'), [
    '-D',
    dataDir,
    '-o',
    settings,
    '-l',
    join(root, 'server.log'),
    '-w',
    '-t',
    '60',
    'start',
  ]);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      runAs(user, join(bin, 'pg_ctl'), [
        '-D',
        dataDir,
        '-m',
        'immediate',
        '-w',
        '-t',
        '30',
        'stop',
      ]);
    } catch {
      // Already gone; the data directory removal below is what actually matters.
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not worth failing a test run over.
    }
  };

  // A crashed or killed runner must not leave a cluster and its data behind.
  process.once('exit', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  return {
    host: '127.0.0.1',
    port,
    dataDir,
    superuser,
    url: (database: string, role?: string) =>
      `postgres://${role ?? superuser}@127.0.0.1:${port}/${database}`,
    stop,
  };
}

/** Reads the checked-in SQL migrations in lexical order. */
export function readMigrations(dir: string): { name: string; sql: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}
