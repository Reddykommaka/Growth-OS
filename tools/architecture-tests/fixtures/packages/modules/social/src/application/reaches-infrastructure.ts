// VIOLATION: application/ orchestrates through ports it declares; it must not reach for a
// concrete adapter. Wiring belongs in the composition root (03-repository-structure.md §2).
import { repository } from '../infrastructure/repo.ts';
export const svc = repository;
