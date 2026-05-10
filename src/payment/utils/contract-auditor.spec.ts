import {
  PaymentTransaction,
  TransactionStatus,
  TransactionType,
} from '../entities/transaction.entity';
import { auditContract } from './contract-auditor';

// Helper for fixture rows — fills in the bits the auditor doesn't read.
function tx(
  partial: Pick<PaymentTransaction, 'type' | 'status' | 'amount'> &
    Partial<PaymentTransaction>,
): PaymentTransaction {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    contractId: partial.contractId ?? 1,
    userId: partial.userId ?? 1,
    cardId: partial.cardId,
    paylovTransactionId: partial.paylovTransactionId,
    extId: partial.extId,
    rawResponse: partial.rawResponse,
    lastError: partial.lastError,
    approvedBy: partial.approvedBy ?? null,
    approvedAt: partial.approvedAt ?? null,
    approvalNote: partial.approvalNote ?? null,
    createdAt: partial.createdAt ?? new Date(),
    updatedAt: partial.updatedAt ?? new Date(),
    type: partial.type,
    status: partial.status,
    amount: partial.amount,
  } as PaymentTransaction;
}

describe('auditContract — financial invariants', () => {
  it('passes a clean settled contract (1.05M held, charged, 1M paid out)', () => {
    const r = auditContract({
      contractId: 42,
      expectedAmountSum: 1_000_000,
      expectedCommissionSum: 50_000,
      transactions: [
        tx({
          type: TransactionType.HOLD,
          status: TransactionStatus.CHARGED, // hold rolled into charge
          amount: 105_000_000, // 1.05M sum in tiyin
        }),
        tx({
          type: TransactionType.CHARGE,
          status: TransactionStatus.CHARGED,
          amount: 105_000_000,
        }),
        tx({
          type: TransactionType.PAYOUT,
          status: TransactionStatus.PAID_OUT,
          amount: 100_000_000, // 1M sum (commission stays with us)
        }),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.sums.held).toBe(105_000_000);
    expect(r.sums.charged).toBe(105_000_000);
    expect(r.sums.paidOut).toBe(100_000_000);
    expect(r.sums.netBalance).toBe(0); // held - charged - dismissed = 0
  });

  it('passes a cancelled (dismissed) contract', () => {
    const r = auditContract({
      contractId: 7,
      expectedAmountSum: 500_000,
      expectedCommissionSum: 25_000,
      transactions: [
        tx({
          type: TransactionType.HOLD,
          status: TransactionStatus.HELD,
          amount: 52_500_000,
        }),
        tx({
          type: TransactionType.DISMISS,
          status: TransactionStatus.DISMISSED,
          amount: 52_500_000,
        }),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.sums.dismissed).toBe(52_500_000);
    expect(r.sums.netBalance).toBe(0);
  });

  it('flags charged > held', () => {
    const r = auditContract({
      transactions: [
        tx({
          type: TransactionType.HOLD,
          status: TransactionStatus.CHARGED,
          amount: 100_000,
        }),
        tx({
          type: TransactionType.CHARGE,
          status: TransactionStatus.CHARGED,
          amount: 200_000,
        }),
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /charged.*>.*held/.test(e))).toBe(true);
  });

  it('flags paidOut > charged (we paid out without collecting)', () => {
    const r = auditContract({
      transactions: [
        tx({
          type: TransactionType.HOLD,
          status: TransactionStatus.CHARGED,
          amount: 100_000,
        }),
        tx({
          type: TransactionType.CHARGE,
          status: TransactionStatus.CHARGED,
          amount: 100_000,
        }),
        tx({
          type: TransactionType.PAYOUT,
          status: TransactionStatus.PAID_OUT,
          amount: 200_000, // > charged: payment out of thin air
        }),
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /paidOut.*>.*charged/.test(e))).toBe(true);
  });

  it('flags partial charge (charged != held)', () => {
    const r = auditContract({
      transactions: [
        tx({
          type: TransactionType.HOLD,
          status: TransactionStatus.CHARGED,
          amount: 100_000,
        }),
        tx({
          type: TransactionType.CHARGE,
          status: TransactionStatus.CHARGED,
          amount: 70_000,
        }),
      ],
    });
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => /charged.*!=.*held|qisman charge/.test(e)),
    ).toBe(true);
  });

  it('flags wrong payout amount vs contract', () => {
    const r = auditContract({
      expectedAmountSum: 1_000_000,
      expectedCommissionSum: 50_000,
      transactions: [
        tx({
          type: TransactionType.HOLD,
          status: TransactionStatus.CHARGED,
          amount: 105_000_000,
        }),
        tx({
          type: TransactionType.CHARGE,
          status: TransactionStatus.CHARGED,
          amount: 105_000_000,
        }),
        tx({
          type: TransactionType.PAYOUT,
          status: TransactionStatus.PAID_OUT,
          amount: 105_000_000, // wrong: included commission
        }),
      ],
    });
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => /paidOut.*kutilgan amount/.test(e)),
    ).toBe(true);
  });

  it('flags held != amount + commission', () => {
    const r = auditContract({
      expectedAmountSum: 1_000_000,
      expectedCommissionSum: 50_000,
      transactions: [
        tx({
          type: TransactionType.HOLD,
          status: TransactionStatus.HELD,
          amount: 110_000_000, // expected 105_000_000
        }),
      ],
    });
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => /held.*!= amount/.test(e)),
    ).toBe(true);
  });

  it('flags negative tx amount', () => {
    const r = auditContract({
      transactions: [
        tx({
          type: TransactionType.HOLD,
          status: TransactionStatus.HELD,
          amount: -1,
        }),
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /salbiy/.test(e))).toBe(true);
  });

  it('ignores failed/awaiting_approval transactions when computing sums', () => {
    const r = auditContract({
      expectedAmountSum: 1_000_000,
      expectedCommissionSum: 50_000,
      transactions: [
        tx({
          type: TransactionType.HOLD,
          status: TransactionStatus.CHARGED,
          amount: 105_000_000,
        }),
        tx({
          type: TransactionType.CHARGE,
          status: TransactionStatus.CHARGED,
          amount: 105_000_000,
        }),
        // A failed payout retry — should NOT be counted
        tx({
          type: TransactionType.PAYOUT,
          status: TransactionStatus.FAILED,
          amount: 100_000_000,
        }),
        // A parked payout awaiting approval — should NOT be counted
        tx({
          type: TransactionType.PAYOUT,
          status: TransactionStatus.AWAITING_APPROVAL,
          amount: 100_000_000,
        }),
        // The successful retry
        tx({
          type: TransactionType.PAYOUT,
          status: TransactionStatus.PAID_OUT,
          amount: 100_000_000,
        }),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.sums.paidOut).toBe(100_000_000);
  });
});
