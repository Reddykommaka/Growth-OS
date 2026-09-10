import { describe, expect, it } from 'vitest';
import {
  addMoney,
  applyBasisPoints,
  compareMoney,
  equalsMoney,
  formatMoney,
  MoneyError,
  money,
  moneyFromDecimalString,
  multiplyMoney,
  serialiseMoney,
  subtractMoney,
} from './money.js';

describe('Money cannot be constructed from a float', () => {
  // Exit criterion 12 (18-phase-0-plan.md). ADR-0012: representation error in money is a
  // correctness bug, so the constructor refuses rather than rounds.
  it.each([12.5, 0.1, -3.7, 1e-7, 1 / 3])('rejects %s', (value) => {
    expect(() => money(value, 'EUR')).toThrow(MoneyError);
    expect(() => money(value, 'EUR')).toThrow(/integer minor units/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => money(Number.NaN, 'EUR')).toThrow(MoneyError);
    expect(() => money(Number.POSITIVE_INFINITY, 'EUR')).toThrow(MoneyError);
  });

  it('rejects an unsafe integer rather than losing precision silently', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, 'EUR')).toThrow(/bigint/);
  });

  it('accepts integer minor units and bigint', () => {
    expect(money(1250, 'EUR').amountMinor).toBe(1250n);
    expect(money(9_007_199_254_740_993n, 'EUR').amountMinor).toBe(9_007_199_254_740_993n);
  });

  it('does not exhibit float error under addition', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In minor units it is exact.
    const total = addMoney(money(10, 'EUR'), money(20, 'EUR'));
    expect(total.amountMinor).toBe(30n);
    expect(equalsMoney(total, money(30, 'EUR'))).toBe(true);
  });
});

describe('currency', () => {
  it('rejects a malformed code', () => {
    expect(() => money(1, 'EURO')).toThrow(/ISO-4217/);
    expect(() => money(1, '')).toThrow(MoneyError);
  });

  it('normalises case', () => {
    expect(money(1, 'eur').currency).toBe('EUR');
  });

  it('refuses to combine different currencies', () => {
    expect(() => addMoney(money(1, 'EUR'), money(1, 'USD'))).toThrow(/Cannot combine/);
    expect(() => subtractMoney(money(1, 'EUR'), money(1, 'USD'))).toThrow(/Cannot combine/);
    expect(() => compareMoney(money(1, 'EUR'), money(1, 'USD'))).toThrow(/Cannot combine/);
  });
});

describe('decimal string parsing never routes through a float', () => {
  it.each([
    ['12.50', 'EUR', 1250n],
    ['0.01', 'EUR', 1n],
    ['-3.99', 'USD', -399n],
    ['100', 'EUR', 10_000n],
    ['1000', 'JPY', 1000n], // zero-decimal currency
    ['1.234', 'KWD', 1234n], // three-decimal currency
  ])('parses %s %s', (value, currency, expected) => {
    expect(moneyFromDecimalString(value, currency).amountMinor).toBe(expected);
  });

  it('rejects more precision than the currency supports', () => {
    expect(() => moneyFromDecimalString('1.234', 'EUR')).toThrow(/more precision/);
    expect(() => moneyFromDecimalString('1.5', 'JPY')).toThrow(/more precision/);
  });

  it('rejects a malformed amount', () => {
    expect(() => moneyFromDecimalString('12,50', 'EUR')).toThrow(MoneyError);
    expect(() => moneyFromDecimalString('abc', 'EUR')).toThrow(MoneyError);
  });
});

describe('commission arithmetic', () => {
  it('applies basis points with half-away-from-zero rounding', () => {
    // 1000 minor units at 250bp (2.5%) = 25
    expect(applyBasisPoints(money(1000, 'EUR'), 250).amountMinor).toBe(25n);
    // 333 at 1000bp (10%) = 33.3 -> 33
    expect(applyBasisPoints(money(333, 'EUR'), 1000).amountMinor).toBe(33n);
    // 335 at 1000bp = 33.5 -> 34
    expect(applyBasisPoints(money(335, 'EUR'), 1000).amountMinor).toBe(34n);
    // negative rounds away from zero symmetrically
    expect(applyBasisPoints(money(-335, 'EUR'), 1000).amountMinor).toBe(-34n);
  });

  it('rejects fractional basis points and fractional quantities', () => {
    expect(() => applyBasisPoints(money(100, 'EUR'), 2.5)).toThrow(/integer/);
    expect(() => multiplyMoney(money(100, 'EUR'), 1.5)).toThrow(/applyBasisPoints/);
  });
});

describe('serialisation and display', () => {
  it('serialises bigint as a string so JSON round-trips', () => {
    expect(serialiseMoney(money(1250, 'EUR'))).toEqual({ amountMinor: '1250', currency: 'EUR' });
    expect(() => JSON.stringify(serialiseMoney(money(1250, 'EUR')))).not.toThrow();
  });

  it('formats using the currency exponent', () => {
    expect(formatMoney(money(1250, 'USD'), 'en-US')).toBe('$12.50');
    expect(formatMoney(money(1000, 'JPY'), 'en-US')).toBe('¥1,000');
  });

  it('is immutable', () => {
    const m = money(100, 'EUR');
    expect(Object.isFrozen(m)).toBe(true);
  });
});
