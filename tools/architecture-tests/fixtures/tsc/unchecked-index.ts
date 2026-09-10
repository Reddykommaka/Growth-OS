// VIOLATION: noUncheckedIndexedAccess — indexing may yield undefined.
export function first(items: string[]): string {
  return items[0];
}
