export type Account = { balanceCents: number };

/** Withdraw an amount in cents, returning the updated account. */
export function withdraw(account: Account, amountCents: number): Account {
  if (!Number.isSafeInteger(amountCents)) throw new Error('Amount must be whole cents');
  if (amountCents > account.balanceCents) throw new Error('Insufficient funds');

  return { ...account, balanceCents: account.balanceCents - amountCents };
}
