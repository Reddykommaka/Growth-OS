#!/usr/bin/env node
/**
 * Migration lint.
 *
 * 05-data-architecture.md §11: CI rejects a migration that violates a data-architecture
 * invariant. Catching these at review time is the only cheap moment — once a column exists
 * in production with data in it, every one of these is a migration with a backfill.
 *
 * The lint is deliberately conservative: it flags patterns for a human to confirm rather
 * than attempting to parse SQL fully. A false positive costs a comment; a false negative
 * costs a production migration.
 *
 * Usage: node tools/scripts/lint-migrations.mjs [dir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Strips comments and string literals so patterns cannot match inside prose or data. */
export function stripNoise(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/\$\$[\s\S]*?\$\$/g, ' $$ ') // dollar-quoted bodies (DO blocks, functions)
    .replace(/'(?:[^']|'')*'/g, "''"); // string literals
}

/** Column names that hold money and must therefore be integer minor units (ADR-0012). */
const MONEY_COLUMN =
  /\b\w*(?:amount|price|cost|spend|total|subtotal|fee|balance|revenue|budget|limit)\w*\b/i;
const MONEY_SUFFIX = /_minor$|_bps$|_basis_points$/i;

const RULES = [
  {
    id: 'timestamptz-only',
    test(sql) {
      // `timestamp` / `timestamp(n)` not followed by "with time zone".
      const re = /\btimestamp\s*(?:\(\s*\d+\s*\))?\s*(?!with\s+time\s+zone)(?!tz)/gi;
      return [...sql.matchAll(re)].map((m) => m[0].trim());
    },
    message:
      'Use timestamptz. A naive timestamp silently loses the offset, and this product ' +
      "schedules work in the customer's local time across DST (05-data-architecture.md §8).",
  },
  {
    id: 'integer-money',
    test(sql) {
      const found = [];
      // Column definitions inside CREATE TABLE / ADD COLUMN.
      const re =
        /\b(\w+)\s+(real|double\s+precision|float\d*|numeric(?:\s*\([^)]*\))?|decimal(?:\s*\([^)]*\))?|money)\b/gi;
      for (const m of sql.matchAll(re)) {
        const [, column, type] = m;
        if (MONEY_COLUMN.test(column) && !MONEY_SUFFIX.test(column)) {
          found.push(`${column} ${type}`);
        }
      }
      return found;
    },
    message:
      'Money must be a bigint of minor units plus an ISO-4217 currency column, named ' +
      'with a _minor suffix (ADR-0012). Floating point and numeric money produce ' +
      'balances that cannot be reconciled.',
  },
  {
    id: 'no-native-enum',
    test(sql) {
      return [...sql.matchAll(/\bCREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM\b/gi)].map((m) => m[1]);
    },
    message:
      'Use text + a CHECK constraint, or a lookup table. A native enum cannot have values ' +
      'removed and ALTER TYPE takes a lock (05-data-architecture.md §1).',
  },
  {
    id: 'concurrent-index',
    test(sql, { isInitial }) {
      if (isInitial) return [];
      return [...sql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)(\w+)/gi)].map(
        (m) => m[1],
      );
    },
    message:
      'Build indexes CONCURRENTLY, in their own migration outside a transaction. A blocking ' +
      'index build on a large table is an outage (05-data-architecture.md §6 rule 7).',
  },
  {
    id: 'no-blocking-alter',
    test(sql) {
      const found = [];
      // Adding a NOT NULL column with no default rewrites the table on older engines and
      // fails outright on a populated one.
      for (const m of sql.matchAll(
        /\bADD\s+COLUMN\s+(\w+)[^,;]*\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/gi,
      )) {
        found.push(`ADD COLUMN ${m[1]} NOT NULL without DEFAULT`);
      }
      // Changing a column type rewrites and takes an ACCESS EXCLUSIVE lock.
      for (const m of sql.matchAll(/\bALTER\s+COLUMN\s+(\w+)\s+TYPE\b/gi)) {
        found.push(`ALTER COLUMN ${m[1]} TYPE`);
      }
      return found;
    },
    message:
      'Expand/contract instead: add nullable, backfill in batches, then enforce. Every ' +
      'migration must be safe against the PREVIOUS application version, because deploys ' +
      'are rolling (05-data-architecture.md §11).',
  },
  {
    id: 'no-drop-without-note',
    // Reads `raw` rather than the stripped SQL: the note it requires IS a comment, and
    // stripNoise removes comments. Checking the stripped text made this rule impossible to
    // satisfy — it flagged every drop no matter how carefully documented.
    test(sql, { raw }) {
      // An explicit marker token, not loose prose. Matching prose is too easy to satisfy by
      // accident — a comment merely *mentioning* expand/contract (including one explaining
      // that a note is missing) would exempt the file.
      if (/--\s*contract-step:/i.test(raw)) return [];
      return [...sql.matchAll(/\bDROP\s+(?:COLUMN|TABLE)\s+(?:IF\s+EXISTS\s+)?(\w+)/gi)].map(
        (m) => m[1],
      );
    },
    message:
      'A DROP is the contract half of expand/contract. Mark it with an explicit ' +
      '"-- contract-step: <why this is safe>" comment confirming the previous release no ' +
      'longer reads the object (05-data-architecture.md §11).',
  },
];

/**
 * Rules that need the whole migration set, not one file: a tenant-scoped table must have
 * RLS enabled AND forced AND a policy with both USING and WITH CHECK, and every foreign key
 * needs a covering index. Both are checked across files because a table may be created in
 * one migration and secured in another.
 */
export function checkCrossFile(files) {
  const findings = [];
  const all = files.map((f) => stripNoise(f.sql)).join('\n');

  const tenantTables = new Set();
  for (const m of all.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\s*\)\s*(?:PARTITION|;)/gi,
  )) {
    const [, table, body] = m;
    if (/\borganization_id\b/i.test(body)) tenantTables.add(table);
  }

  for (const table of tenantTables) {
    const enabled = new RegExp(
      `ALTER\\s+TABLE\\s+${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    ).test(all);
    const forced = new RegExp(
      `ALTER\\s+TABLE\\s+${table}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    ).test(all);
    const policy = new RegExp(
      `CREATE\\s+POLICY[\\s\\S]{0,400}?\\sON\\s+${table}\\b([\\s\\S]{0,600}?);`,
      'i',
    ).exec(all);

    if (!enabled) findings.push({ rule: 'rls-required', detail: `${table}: RLS not ENABLEd` });
    if (!forced)
      findings.push({
        rule: 'rls-required',
        detail: `${table}: RLS not FORCEd (the owner would bypass it)`,
      });
    if (policy === null) {
      findings.push({ rule: 'rls-required', detail: `${table}: no policy` });
    } else {
      const body = policy[1] ?? '';
      if (!/\bUSING\b/i.test(body))
        findings.push({ rule: 'rls-required', detail: `${table}: policy has no USING` });
      if (!/\bWITH\s+CHECK\b/i.test(body)) {
        findings.push({
          rule: 'rls-required',
          detail:
            `${table}: policy has no explicit WITH CHECK — PostgreSQL will reuse USING as ` +
            'the write predicate, which is a hole wherever USING is broader than the write rule',
        });
      }
    }
  }

  // Foreign keys need a covering index; PostgreSQL creates none, and its absence turns
  // parent deletes and joins into sequential scans (05-data-architecture.md §6 rule 2).
  for (const m of all.matchAll(/\b(\w+)\s+[\w\s()]*?\bREFERENCES\s+(\w+)\s*\(/gi)) {
    const column = m[1];
    if (/^(?:constraint|foreign|key|references)$/i.test(column)) continue;
    const indexed =
      new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX[^;]*\\(\\s*${column}\\b`, 'i').test(all) ||
      new RegExp(`PRIMARY\\s+KEY\\s*\\(\\s*${column}\\b`, 'i').test(all) ||
      new RegExp(`\\b${column}\\b[^,;]*\\bPRIMARY\\s+KEY\\b`, 'i').test(all) ||
      new RegExp(`UNIQUE\\s*\\(\\s*${column}\\b`, 'i').test(all);
    if (!indexed) {
      findings.push({
        rule: 'fk-needs-index',
        detail: `${column} references ${m[2]} with no covering index`,
      });
    }
  }

  return findings;
}

export function lintMigrations(dir) {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const files = names.map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
  const findings = [];

  for (const file of files) {
    const sql = stripNoise(file.sql);
    const isInitial = /^0001[_-]/.test(file.name);
    for (const rule of RULES) {
      for (const hit of rule.test(sql, { isInitial, raw: file.sql })) {
        findings.push({ file: file.name, rule: rule.id, detail: hit, message: rule.message });
      }
    }
  }

  for (const f of checkCrossFile(files)) {
    findings.push({ file: '(across migrations)', ...f, message: MESSAGES[f.rule] });
  }

  return findings;
}

const MESSAGES = {
  'rls-required':
    'Every tenant-scoped table needs RLS ENABLED and FORCED with a policy carrying both ' +
    'USING and WITH CHECK (06-identity-and-access.md §4). This is the backstop the entire ' +
    'multi-tenant promise rests on.',
  'fk-needs-index': 'Every foreign key needs a covering index (05-data-architecture.md §6 rule 2).',
};

const invokedDirectly = process.argv[1]?.endsWith('lint-migrations.mjs') === true;
if (invokedDirectly) {
  const dir = process.argv[2] ?? 'db/migrations';
  let findings;
  try {
    statSync(dir);
    findings = lintMigrations(dir);
  } catch (error) {
    console.error(`Cannot read migrations at ${dir}: ${error.message}`);
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(`Migration lint found ${findings.length} problem(s):\n`);
    const byRule = new Map();
    for (const f of findings) {
      if (!byRule.has(f.rule)) byRule.set(f.rule, []);
      byRule.get(f.rule).push(f);
    }
    for (const [rule, items] of byRule) {
      console.error(`  [${rule}]`);
      for (const i of items) console.error(`    ${i.file}: ${i.detail}`);
      console.error(`    → ${items[0].message}\n`);
    }
    process.exit(1);
  }
  console.log(
    `migration-lint: OK (${readdirSync(dir).filter((f) => f.endsWith('.sql')).length} migrations)`,
  );
}
