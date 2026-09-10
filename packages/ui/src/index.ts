/**
 * @growth-os/ui — the Growth OS design system.
 *
 * Tokens → primitives → patterns (13-design-system.md §6). Primitives are presentational:
 * they receive data and callbacks, they do not fetch, and they contain no business rules.
 * dependency-cruiser enforces that this package never imports a business module.
 */
export { type ClassValue, cx } from './lib/cx.js';
export * from './primitives/index.js';
