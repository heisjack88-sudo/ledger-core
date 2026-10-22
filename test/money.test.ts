import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/domain/errors.js';
import { add, formatMinor, money, parseMinor } from '../src/domain/money.js';

describe('money', () => {
  it('parses decimals without floating point drift', () => {
    expect(parseMinor('0.10', 'USD').minor).toBe(10n);
    expect(parseMinor('0.20', 'USD').minor).toBe(20n);
    expect(add(parseMinor('0.10', 'USD'), parseMinor('0.20', 'USD')).minor).toBe(30n);

    expect(parseMinor('10.5', 'USD').minor).toBe(1050n);
    expect(parseMinor('10,50', 'EUR').minor).toBe(1050n);
    expect(parseMinor('-3.01', 'USD').minor).toBe(-301n);
    expect(parseMinor('1', 'USD').minor).toBe(100n);
    expect(parseMinor('00012.34', 'USD').minor).toBe(1234n);
  });

  it('rejects precision the currency cannot represent', () => {
    expect(() => parseMinor('1.005', 'USD')).toThrowError(DomainError);
    expect(() => parseMinor('1.5', 'JPY', 0)).toThrowError(DomainError);
  });

  it('rejects malformed amounts instead of coercing them', () => {
    for (const input of ['', 'abc', '1.2.3', '1e5', '--1', ' 1 2 ']) {
      expect(() => parseMinor(input, 'USD')).toThrowError(DomainError);
    }
  });

  it('formats minor units deterministically', () => {
    expect(formatMinor(money(-12345n, 'USD'))).toBe('-123.45');
    expect(formatMinor(money(5n, 'USD'))).toBe('0.05');
    expect(formatMinor(money(0n, 'USD'))).toBe('0.00');
  });

  it('normalizes currency casing but rejects invalid codes', () => {
    expect(money(1n, 'usd').currency).toBe('USD');
    expect(() => money(1n, 'US')).toThrowError(DomainError);
    expect(() => money(1n, 'USDD')).toThrowError(DomainError);
  });

  it('refuses to add different currencies', () => {
    expect(() => add(money(1n, 'USD'), money(1n, 'EUR'))).toThrowError(DomainError);
  });
});
