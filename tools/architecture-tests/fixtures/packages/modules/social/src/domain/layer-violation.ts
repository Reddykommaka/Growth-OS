// VIOLATION: domain/ must not import infrastructure/ (03-repository-structure.md §2).
// The dependency rule is domain <- application <- infrastructure, never the reverse.
import { repository } from '../infrastructure/repo.ts';
export const broken = repository;
