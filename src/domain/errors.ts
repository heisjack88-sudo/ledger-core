export type DomainErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'INVALID_CURSOR'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'SAME_ACCOUNT'
  | 'UNBALANCED_ENTRY'
  | 'SINGLE_POSTING'
  | 'ACCOUNT_NOT_FOUND';

export class DomainError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: DomainErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.details = details;
  }
}
