import { DomainError } from './errors.js';

export type Currency = string;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^(-)?(\d+)(?:[.,](\d+))?$/;

/**
 * Money is always an integer count of minor units plus a currency.
 * A float never touches a monetary value in this codebase.
 */
export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export function currency(code: string): Currency {
  const normalized = code.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(normalized)) {
    throw new DomainError('INVALID_CURRENCY', `"${code}" is not an ISO-4217 alphabetic code`);
  }
  return normalized;
}

export function money(minor: bigint, code: string | Currency): Money {
  return { minor, currency: currency(code) };
}

export function zero(code: string | Currency): Money {
  return money(0n, code);
}

export function isZero(value: Money): boolean {
  return value.minor === 0n;
}

export function isPositive(value: Money): boolean {
  return value.minor > 0n;
}

export function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `Cannot combine ${left.currency} with ${right.currency}`,
      { left: left.currency, right: right.currency },
    );
  }
}

export function add(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return { minor: left.minor + right.minor, currency: left.currency };
}

export function negate(value: Money): Money {
  return { minor: -value.minor, currency: value.currency };
}

/**
 * Parses "10.50" / "10,50" / "-3" into minor units without floating point.
 * Precision beyond the currency exponent is rejected, never rounded silently.
 */
export function parseMinor(input: string, code: string | Currency, exponent = 2): Money {
  const match = DECIMAL_PATTERN.exec(input.trim());
  if (match === null) {
    throw new DomainError('INVALID_AMOUNT', `"${input}" is not a decimal amount`);
  }

  const sign = match[1] ?? '';
  const whole = match[2] ?? '';
  const fraction = match[3] ?? '';

  if (fraction.length > exponent) {
    throw new DomainError(
      'INVALID_AMOUNT',
      `"${input}" has more than ${exponent} decimal places`,
      { input, exponent },
    );
  }

  const digits = `${whole}${fraction.padEnd(exponent, '0')}`;
  const minor = BigInt(digits);

  return { minor: sign === '-' ? -minor : minor, currency: currency(code) };
}

/**
 * Deterministic formatter (no locale grouping) so API responses are stable
 * across machines. Presentation-layer formatting belongs in the client.
 */
export function formatMinor(value: Money, exponent = 2): string {
  const scale = 10n ** BigInt(exponent);
  const negative = value.minor < 0n;
  const absolute = negative ? -value.minor : value.minor;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(exponent, '0');

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
