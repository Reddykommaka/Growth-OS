# Lint configuration rationale

Non-obvious entries in `biome.json` and `.dependency-cruiser.cjs`. A rule turned off without
a recorded reason invites someone to turn it back on and rediscover the problem.

| Setting | Why |
| --- | --- |
| `complexity/useLiteralKeys: off` | `tsconfig.base.json` sets `noPropertyAccessFromIndexSignature`, which **requires** bracket access on index signatures such as `process.env['PG_BIN']`. Biome's `useLiteralKeys` demands the opposite. The two rules directly contradict each other on every environment-variable read; the compiler wins, because its rule catches a real class of typo that Biome's does not. |
| `suspicious/noConsole` allows `console.error` | Bootstrap scripts and CLI tools under `tools/` must be able to report a failure before the logger exists. Application code uses `@growth-os/logger`, which is enforced by the `noConsole` error level everywhere else. |
| Model-provider SDKs banned outside `packages/integrations/*` | [ADR-0013](adr/0013-model-provider-abstraction.md). Product code depends on `IntelligencePort`, never a vendor. |
| ORM / Redis / queue / provider SDKs banned in `domain/` and `application/` | [03-repository-structure.md](architecture/03-repository-structure.md) §2. `domain/` is pure; `application/` depends on ports it declares. |
| `dependency-cruiser` runs against **bare directories**, never globs | A recursive glob walks pnpm's workspace symlinks under `node_modules`, reporting the same file many times and turning a 0.7s check into a multi-minute one. |
| `pnpm.packageExtensions` pins `typescript@6.0.3` inside `dependency-cruiser` | dependency-cruiser does not support TypeScript ≥7 and **fails silently**: with no compatible compiler API it cruises zero modules and reports success. The build compiler is unaffected. The architecture suite additionally asserts `totalCruised` stays above a floor so this cannot regress unnoticed. |
| No ESLint | Every rule required by [18-phase-0-plan.md](architecture/18-phase-0-plan.md) exists natively in Biome, which ships its own parser. `typescript-eslint` declares `typescript >=4.8.4 <6.1.0` and cannot run against TypeScript 7. See [02-technology-stack.md](architecture/02-technology-stack.md) §7. |
