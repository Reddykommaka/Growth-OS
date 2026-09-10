/**
 * @growth-os/types — shared primitives with no dependencies on any other Growth OS package.
 *
 * Everything here is used by domain code, so it must stay free of I/O, frameworks and
 * business rules (03-repository-structure.md §2).
 */
export * from './clock.js';
export * from './ids.js';
export * from './money.js';
export * from './pagination.js';
export * from './result.js';
