import {
  PaymentTransaction,
  TransactionStatus,
  TransactionType,
} from '../entities/transaction.entity';

/**
 * Walks a single contract's payment transactions and surfaces invariants
 * that must hold for every penny to be accounted for. Pure function: no
 * DB or network access — caller passes everything in. Used by the
 * Financial Audit test-suite and (optionally) by an admin sanity-check
 * endpoint.
 *
 * Money is accumulated in tiyin to avoid float drift; sums are returned
 * in tiyin too. The caller decides how to format / rouble-convert.
 */
export interface ContractAuditInput {
  /** Contract id, only used for friendlier error messages. */
  contractId?: number;
  /** Contract amount + commission in *sum*, frozen at create time. */
  expectedAmountSum?: number;
  expectedCommissionSum?: number;
  /** All payment_transactions rows for this contract, in any order. */
  transactions: PaymentTransaction[];
}

export interface ContractAuditResult {
  contractId?: number;
  ok: boolean;
  /** All discrepancies, in plain Uzbek. Empty when ok. */
  errors: string[];
  /** Sums in tiyin so the caller can format / display. */
  sums: {
    held: number;
    charged: number;
    dismissed: number;
    paidOut: number;
    /** Net = held - dismissed - charged. Should be 0 once the contract has
     *  fully settled (either dismissed=held, or charged=held). */
    netBalance: number;
  };
}

const SUCCESS_HOLD = new Set([TransactionStatus.HELD, TransactionStatus.CHARGED]);
const SUCCESS_CHARGE = new Set([TransactionStatus.CHARGED]);
const SUCCESS_DISMISS = new Set([TransactionStatus.DISMISSED]);
const SUCCESS_PAYOUT = new Set([TransactionStatus.PAID_OUT]);

function tiyinFromSum(sum: number): number {
  return Math.round(sum * 100);
}

export function auditContract(
  input: ContractAuditInput,
): ContractAuditResult {
  const errors: string[] = [];
  let held = 0;
  let charged = 0;
  let dismissed = 0;
  let paidOut = 0;

  for (const tx of input.transactions) {
    const amt = Number(tx.amount ?? 0);
    if (!Number.isFinite(amt) || amt < 0) {
      errors.push(
        `tx ${tx.id}: salbiy yoki noto'g'ri summa (${tx.amount})`,
      );
      continue;
    }
    if (tx.type === TransactionType.HOLD && SUCCESS_HOLD.has(tx.status)) {
      held += amt;
    } else if (
      tx.type === TransactionType.CHARGE &&
      SUCCESS_CHARGE.has(tx.status)
    ) {
      charged += amt;
    } else if (
      tx.type === TransactionType.DISMISS &&
      SUCCESS_DISMISS.has(tx.status)
    ) {
      dismissed += amt;
    } else if (
      tx.type === TransactionType.PAYOUT &&
      SUCCESS_PAYOUT.has(tx.status)
    ) {
      paidOut += amt;
    }
  }

  // Invariant 1: held >= charged + dismissed (we never settle more than we held)
  if (charged + dismissed > held) {
    errors.push(
      `Hisobot: charged (${charged}) + dismissed (${dismissed}) > held (${held})`,
    );
  }

  // Invariant 2: paidOut <= charged (we can only pay out what we've collected)
  if (paidOut > charged) {
    errors.push(
      `Hisobot: paidOut (${paidOut}) > charged (${charged}) — komissiyasiz pul olib chiqilgan`,
    );
  }

  // Invariant 3: if a contract is fully charged, hold and charge must match.
  if (charged > 0 && charged !== held) {
    errors.push(
      `Hisobot: charged (${charged}) != held (${held}) — qisman charge bo'lgan, kutilmagan`,
    );
  }

  // Invariant 4 (optional): payout must equal contract amount (excluding commission).
  if (
    input.expectedAmountSum !== undefined &&
    paidOut > 0 &&
    paidOut !== tiyinFromSum(input.expectedAmountSum)
  ) {
    errors.push(
      `Hisobot: paidOut tiyin (${paidOut}) != kutilgan amount tiyin (${tiyinFromSum(input.expectedAmountSum)})`,
    );
  }

  // Invariant 5 (optional): held must equal amount + commission.
  if (
    input.expectedAmountSum !== undefined &&
    input.expectedCommissionSum !== undefined &&
    held > 0
  ) {
    const expectedHeld =
      tiyinFromSum(input.expectedAmountSum) +
      tiyinFromSum(input.expectedCommissionSum);
    if (held !== expectedHeld) {
      errors.push(
        `Hisobot: held tiyin (${held}) != amount + commission tiyin (${expectedHeld})`,
      );
    }
  }

  return {
    contractId: input.contractId,
    ok: errors.length === 0,
    errors,
    sums: {
      held,
      charged,
      dismissed,
      paidOut,
      netBalance: held - dismissed - charged,
    },
  };
}
