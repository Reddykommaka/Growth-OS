// VIOLATION: apps may import a module's ./contracts only — never domain or infrastructure
// (01-overview.md §3 principle 1).
import { repository } from '../../../packages/modules/social/src/infrastructure/repo.ts';
export const leaked = repository;
