/**
 * Clock port.
 *
 * Domain code must never call `Date.now()` directly: a rule that depends on the wall clock
 * is untestable without sleeping, and scheduling logic that reads worker-local time drifts
 * across replicas (08-automation-architecture.md — all scheduling decisions use database
 * `now()`). Injecting a Clock makes time an explicit dependency.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Deterministic clock for tests. */
export function fixedClock(start: Date): Clock & { advance(ms: number): void; set(d: Date): void } {
  let current = new Date(start.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    set: (d: Date) => {
      current = new Date(d.getTime());
    },
  };
}
