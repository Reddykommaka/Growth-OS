/**
 * Password hashing and verification.
 *
 * Argon2id at m=64MiB, t=3, p=4, tuned to ~250ms on production hardware
 * (06-identity-and-access.md §2). Those are cost parameters, not style: halving the memory
 * cost halves an attacker's cost too, and the number is chosen against offline cracking of
 * a stolen dump rather than against our own login latency.
 */

import { ValidationError } from '@growth-os/errors';
import { hash, verify } from '@node-rs/argon2';

export interface PasswordPolicy {
  readonly minimumLength: number;
  readonly maximumLength: number;
}

/**
 * Length only, deliberately.
 *
 * Composition rules ("one uppercase, one symbol") measurably push people toward
 * `Password1!` and are no longer recommended by NIST SP 800-63B. Length plus a breached-
 * corpus check is what actually removes guessable passwords (06 §2).
 *
 * The maximum exists because Argon2's cost is paid per call on OUR hardware: an unbounded
 * input is a cheap denial-of-service. 1024 is far beyond any real passphrase.
 */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minimumLength: 12,
  maximumLength: 1024,
};

/**
 * Argon2id parameters. Exported so a test can assert what was actually used.
 *
 * The algorithm is the literal 2 rather than `Algorithm.Argon2id` because that is an
 * ambient const enum, which `verbatimModuleSyntax` forbids importing. A bare number in a
 * security parameter is exactly the sort of thing that silently drifts, so a test asserts
 * the ENCODED OUTPUT begins `$argon2id$` — verifying the behaviour rather than the constant.
 */
const ARGON2ID = 2;

export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

/**
 * A pre-computed hash verified when no user exists.
 *
 * Without it, an unknown address returns in microseconds while a known one takes ~250ms,
 * and that difference enumerates the user base at the login endpoint. Computed once at
 * module load so the cost is paid at boot rather than on the first probe.
 */
let dummyHashPromise: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hash('growth-os-timing-equaliser', ARGON2_OPTIONS);
  return dummyHashPromise;
}

/** A port so a breached-password corpus can be plugged in without changing this module. */
export interface BreachedPasswordCheck {
  /** True when the password appears in a known breach corpus. */
  isBreached(password: string): Promise<boolean>;
}

export interface HashPasswordOptions {
  readonly policy?: PasswordPolicy;
  readonly breachCheck?: BreachedPasswordCheck;
}

/**
 * Length in user-perceived characters.
 *
 * Not UTF-16 units, and not code points either. A single family emoji is 11 UTF-16 units and
 * 7 code points (four people joined by three zero-width joiners) but ONE thing the user
 * chose. Counting units or code points lets two emoji clear a 12-character minimum while
 * carrying the entropy of two selections.
 *
 * A minimum length is a proxy for "how many independent choices did you make", so graphemes
 * are the unit that proxy actually needs. `Intl.Segmenter` is built into Node 22 and gets
 * the clustering right, which hand-rolled counting does not.
 */
function graphemeLength(value: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(value)) count++;
  return count;
}

export async function hashPassword(
  password: string,
  options: HashPasswordOptions = {},
): Promise<string> {
  const policy = options.policy ?? DEFAULT_PASSWORD_POLICY;

  const length = graphemeLength(password);
  if (length < policy.minimumLength) {
    throw new ValidationError(`A password must be at least ${policy.minimumLength} characters.`);
  }
  if (length > policy.maximumLength) {
    throw new ValidationError(`A password may be at most ${policy.maximumLength} characters.`);
  }
  if (options.breachCheck !== undefined && (await options.breachCheck.isBreached(password))) {
    throw new ValidationError(
      'This password has appeared in a known data breach. Choose a different one.',
    );
  }

  return await hash(password, ARGON2_OPTIONS);
}

/**
 * Verifies a password against a stored hash.
 *
 * Pass `storedHash: null` for an address with no account, or one that has only ever used
 * OAuth. A dummy hash is verified instead so the call costs the same either way, and the
 * result is false. Returning early here would reintroduce exactly the timing oracle the
 * dummy exists to close.
 */
export async function verifyPassword(
  storedHash: string | null,
  password: string,
): Promise<boolean> {
  if (storedHash === null) {
    await verify(await dummyHash(), password).catch(() => false);
    return false;
  }
  try {
    return await verify(storedHash, password);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as an error the
    // caller might treat as a transient failure and retry into a lockout bypass.
    return false;
  }
}

/** Whether a stored hash was produced with weaker parameters and should be upgraded. */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (match === null) return true;
  const [, memory, time, parallelism] = match;
  return (
    Number(memory) < ARGON2_OPTIONS.memoryCost ||
    Number(time) < ARGON2_OPTIONS.timeCost ||
    Number(parallelism) < ARGON2_OPTIONS.parallelism
  );
}
