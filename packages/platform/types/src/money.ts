/**
 * Money.
 *
 * 05-data-architecture.md §1 and ADR-0012: every monetary value is an integer number of
 * minor units plus an ISO-4217 currency code. Floating point is banned outright — 0.1 + 0.2
 * is not 0.3, and in a marketplace that difference is an unreconcilable ledger.
 *
 * The constructor refuses non-integers, so a float cannot enter the system even by accident.
 */
import { z } from 'zod';

/** Minor-unit exponent for currencies that are not the common 2-decimal case. */
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
});
const DEFAULT_EXPONENT = 2;

const CURRENCY = /^[A-Z]{3}$/;

export type CurrencyCode = string & { readonly __currency: unique symbol };

export interface Money {
  /** Integer minor units (cents, pence, satang…). Never a float. */
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function currencyExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? DEFAULT_EXPONENT;
}

function assertCurrency(currency: string): CurrencyCode {
  const upper = currency.toUpperCase();
  if (!CURRENCY.test(upper)) {
    throw new MoneyError(`Invalid currency code: ${currency}. Expected ISO-4217, e.g. "EUR".`);
  }
  return upper as CurrencyCode;
}

/**
 * Constructs Money from minor units.
 *
 * Accepts bigint, or a number that is an exact integer. A non-integer number is rejected:
 * silently rounding it would hide the very defect this type exists to prevent.
 */
export function money(amountMinor: bigint | number, currency: string): Money {
  let minor: bigint;
  if (typeof amountMinor === 'bigint') {
    minor = amountMinor;
  } else {
    if (!Number.isFinite(amountMinor)) {
      throw new MoneyError(`Money amount must be finite, received ${amountMinor}.`);
    }
    if (!Number.isInteger(amountMinor)) {
      throw new MoneyError(
        `Money must be constructed from integer minor units, received ${amountMinor}. ` +
          'Use money(1250, "EUR") for €12.50 — never a decimal amount (ADR-0012).',
      );
    }
    if (!Number.isSafeInteger(amountMinor)) {
      throw new MoneyError(
        `Money amount ${amountMinor} exceeds the safe integer range; pass a bigint.`,
      );
    }
    minor = BigInt(amountMinor);
  }
  return Object.freeze({ amountMinor: minor, currency: assertCurrency(currency) });
}

/** Parses a decimal string ("12.50") into Money without ever using a float. */
export function moneyFromDecimalString(value: string, currency: string): Money {
  const code = assertCurrency(currency);
  const exponent = currencyExponent(code);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new MoneyError(`Invalid decimal amount: "${value}".`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new MoneyError(
      `"${value}" has more precision than ${code} supports (${exponent} minor digits).`,
    );
  }
  const padded = fraction.padEnd(exponent, '0');
  const minor = BigInt(`${whole}${padded}`) * (sign === '-' ? -1n : 1n);
  return Object.freeze({ amountMinor: minor, currency: code });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Cannot combine ${a.currency} and ${b.currency}. Convert explicitly with a recorded rate.`,
    );
  }
}

export const addMoney = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
};

export const subtractMoney = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
};

/** Multiplies by an integer quantity. Fractional rates go through `applyBasisPoints`. */
export const multiplyMoney = (a: Money, quantity: bigint | number): Money => {
  if (typeof quantity === 'number' && !Number.isInteger(quantity)) {
    throw new MoneyError(
      `Quantity must be an integer, received ${quantity}. Use applyBasisPoints for a rate.`,
    );
  }
  return money(a.amountMinor * BigInt(quantity), a.currency);
};

/**
 * Applies a rate expressed in basis points (1 bp = 0.01%), the form commissions take.
 * Rounds half away from zero, in integer arithmetic only.
 */
export function applyBasisPoints(a: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints)) {
    throw new MoneyError(`Basis points must be an integer, received ${basisPoints}.`);
  }
  const scaled = a.amountMinor * BigInt(basisPoints);
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const rounded = (magnitude + 5000n) / 10_000n;
  return money(negative ? -rounded : rounded, a.currency);
}

export const isZero = (a: Money): boolean => a.amountMinor === 0n;
export const isNegative = (a: Money): boolean => a.amountMinor < 0n;
export const compareMoney = (a: Money, b: Money): -1 | 0 | 1 => {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
};
export const equalsMoney = (a: Money, b: Money): boolean =>
  a.currency === b.currency && a.amountMinor === b.amountMinor;

/** Formats for display in a locale. Presentation only — never parsed back. */
export function formatMoney(a: Money, locale = 'en-US'): string {
  const exponent = currencyExponent(a.currency);
  const divisor = 10n ** BigInt(exponent);
  const negative = a.amountMinor < 0n;
  const magnitude = negative ? -a.amountMinor : a.amountMinor;
  const whole = magnitude / divisor;
  const fraction = (magnitude % divisor).toString().padStart(exponent, '0');
  const decimal = exponent === 0 ? `${whole}` : `${whole}.${fraction}`;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: a.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(Number(negative ? `-${decimal}` : decimal));
}

/** Wire/storage representation: bigint is not JSON-serialisable. */
export const moneySchema = z.object({
  amountMinor: z.union([z.bigint(), z.string().regex(/^-?\d+$/)]).transform(BigInt),
  currency: z.string().regex(CURRENCY),
});

export const serialiseMoney = (a: Money) => ({
  amountMinor: a.amountMinor.toString(),
  currency: a.currency as string,
});
