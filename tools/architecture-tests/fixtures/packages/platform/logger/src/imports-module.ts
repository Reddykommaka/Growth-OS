// VIOLATION: platform/* holds cross-cutting foundations with no business rules. Depending
// on a business module inverts the architecture (04-domain-architecture.md §1).
import type { Contract } from '../../../modules/social/src/contracts/index.ts';
export type Bad = Contract;
