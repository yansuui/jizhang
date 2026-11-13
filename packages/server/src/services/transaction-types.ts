import type { FundPurpose, SpendingPurpose } from '@jizhang/shared';

/** Wire/domain representation. Field names match the API contract (design.md §5). */
/** Reverse-refund summary for an original expense: how much has been refunded. */
export interface RefundSummary {
  /** Sum of all linked refund amounts, in cents. */
  readonly totalRefundCents: number;
  /** Number of linked refund transactions. */
  readonly refundCount: number;
}

/** One linked refund row for an original expense (forward-view detail). */
export interface RefundDetail {
  readonly id: string;
  readonly amountCents: number;
  readonly date: number;
  readonly note: string;
  readonly updatedAt: number;
}

/** Wire/domain representation. Field names match the API contract (design.md §5). */
export interface TransactionDto {
  readonly id: string;
  readonly type: number;
  readonly amountCents: number;
  readonly categoryId: string;
  readonly accountId: string;
  readonly date: number;
  readonly note: string;
  readonly tags: string[];
  readonly isRefund: boolean;
  /** Explicit bill-purpose override; `null` means "no override", not unresolved. */
  readonly financialPurpose: SpendingPurpose | null;
  /** 0 until the first explicit override is stored; bumped once per effective change. */
  readonly financialPurposeRevision: number;
  readonly fundPurpose: FundPurpose | null;
  readonly fundPurposeRevision: number;
  readonly fundPurposeStatus: 'resolved' | 'unresolved';
  readonly fundPurposeSource: string;
  /**
   * True once this income was confirmed into the four-purpose split by ratio.
   *
   * Such an income no longer carries a single `fundPurpose`; the allocation table owns
   * the decision. Additive field: older servers simply omit it.
   */
  readonly fundIncomeAllocated?: boolean;
  readonly refundLinkedTxIds?: string[];
  readonly refundSummary?: RefundSummary;
  readonly refundDetails?: RefundDetail[];
  readonly updatedAt: number;
}

export interface CreateTransactionInput {
  readonly type?: unknown;
  readonly amountCents?: unknown;
  readonly categoryId?: unknown;
  readonly accountId?: unknown;
  readonly date?: unknown;
  readonly note?: unknown;
  readonly tags?: unknown;
  readonly isRefund?: unknown;
  readonly refundLinkedTxIds?: unknown;
  /**
   * `null` clears an override, `'essentials' | 'joy'` sets one and an absent
   * key leaves an existing override untouched (on PATCH).
   */
  readonly financialPurpose?: unknown;
  /** Canonical four-purpose value, or null to explicitly clear. */
  readonly fundPurpose?: unknown;
  /** Canonical purpose revision guard for an explicit fundPurpose PATCH. */
  readonly expectedFundPurposeRevision?: unknown;
  /** Optional replay key for a purpose-bearing create. */
  readonly operationId?: unknown;
  /** Required with an explicit purpose on PATCH. */
  readonly expectedFinancialPurposeRevision?: unknown;
  /** Required with an explicit purpose on PATCH; fingerprints the pre-image. */
  readonly expectedTransactionToken?: unknown;
}

/**
 * A partial update uses the same optional-field shape as create: absent keys are
 * left untouched.
 */
export type UpdateTransactionInput = CreateTransactionInput;

/** A create payload after the same validation used by the ledger writer. */
export interface PreparedTransactionInput {
  readonly type: number;
  readonly amountCents: number;
  readonly categoryId: string;
  readonly accountId: string;
  readonly date: number;
  readonly note: string;
  readonly tags: string[];
  readonly isRefund: boolean;
  readonly refundLinkedTxIds: string[];
  /** Resolved next override value; `null` means no override. */
  readonly financialPurpose: SpendingPurpose | null;
  readonly fundPurpose: FundPurpose | null;
}
