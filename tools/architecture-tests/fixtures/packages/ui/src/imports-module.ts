// VIOLATION: packages/ui is presentational and must never import a business module
// (03-repository-structure.md §2, ADR-0010).
import type { Contract } from '../../modules/social/src/contracts/index.ts';
export type Leak = Contract;
