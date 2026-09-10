import { a } from './cycle-a.ts';
export const b = () => a;
