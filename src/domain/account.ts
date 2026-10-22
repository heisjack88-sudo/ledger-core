import type { Currency } from './money.js';

export const ACCOUNT_KINDS = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export interface Account {
  readonly id: string;
  readonly ownerId: string;
  readonly currency: Currency;
  readonly kind: AccountKind;
  readonly allowNegative: boolean;
  readonly createdAt: Date;
}
