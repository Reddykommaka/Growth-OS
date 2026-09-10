// VIOLATION: circular dependency.
import { b } from './cycle-b.ts';
export const a = () => b;
