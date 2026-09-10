// VIOLATION: explicit `any` (01-overview.md §3 principle 10).
export function widen(input: any): any {
  return input;
}
