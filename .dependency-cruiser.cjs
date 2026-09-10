/**
 * Boundary enforcement mechanism 3 — architectural rules as code.
 *
 * Encodes the dependency rule and module boundaries from
 * docs/architecture/03-repository-structure.md §2 and ADR-0001.
 *
 * Path patterns are deliberately NOT anchored to the repository root, so the same
 * ruleset applies to the real tree and to the deliberately-illegal fixtures under
 * tools/architecture-tests/fixtures/ that prove these rules actually fire.
 */
const MODULE = 'packages/modules/[^/]+/src';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'Circular dependencies make initialisation order undefined and prevent a module ' +
        'from ever being extracted into its own service (ADR-0001).',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-imports-nothing-above-it',
      comment:
        'The dependency rule is domain <- application <- infrastructure. domain/ is pure: ' +
        'no I/O, no framework, no orchestration (03-repository-structure.md §2).',
      severity: 'error',
      from: { path: `${MODULE}/domain` },
      to: { path: `${MODULE}/(application|infrastructure)` },
    },
    {
      name: 'application-must-not-import-infrastructure',
      comment:
        'application/ orchestrates through ports it declares; it must not reach for a ' +
        'concrete adapter. Wiring happens in the composition root.',
      severity: 'error',
      from: { path: `${MODULE}/application` },
      to: { path: `${MODULE}/infrastructure` },
    },
    {
      name: 'apps-import-contracts-only',
      comment:
        'Business logic never lives in an app (01-overview.md §3 principle 1). Apps may ' +
        "import a module's ./contracts, and its ./infrastructure only from a composition root.",
      severity: 'error',
      from: { path: 'apps/[^/]+/src', pathNot: 'apps/[^/]+/src/bootstrap' },
      to: { path: `${MODULE}/(domain|application|infrastructure)` },
    },
    {
      name: 'ui-must-not-import-business-modules',
      comment:
        'packages/ui is presentational: it receives data and callbacks and holds no ' +
        'business rules (ADR-0010).',
      severity: 'error',
      from: { path: 'packages/(ui|charts)/src' },
      to: { path: 'packages/modules/' },
    },
    {
      name: 'platform-must-not-import-modules',
      comment:
        'platform/* holds cross-cutting foundations with no business rules; depending on a ' +
        'business module would invert the architecture.',
      severity: 'error',
      from: { path: 'packages/platform/[^/]+/src' },
      to: { path: 'packages/modules/' },
    },
    {
      name: 'no-orphan-source',
      comment: 'An unreferenced source file is dead code or a missing wire-up.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)index\\.ts$',
          '\\.config\\.(ts|js|cjs|mjs)$',
          // Referenced by a tool's configuration (vitest setupFiles), not by an import, so
          // dependency-cruiser cannot see the edge and reports a false orphan.
          '(^|/)testing/setup\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-dev-dep',
      comment: 'Runtime code must not depend on a devDependency.',
      severity: 'error',
      from: { path: '^(apps|packages)', pathNot: '\\.(test|spec)\\.(ts|tsx)$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-undeclared-deps',
      comment:
        'Import something a package does not declare and it breaks under strict, ' +
        'non-hoisted node_modules (boundary mechanism 2).',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['undetermined', 'npm-no-pkg', 'npm-unknown'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // node_modules must be excluded from enumeration, not merely un-followed: pnpm links
    // workspace packages into each other's node_modules, so a recursive glob would walk
    // the same sources repeatedly through symlinks and never terminate.
    exclude: { path: '(^|/)(node_modules|dist|coverage|\\.next|\\.turbo)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.mjs'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
