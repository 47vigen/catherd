# Plan Ledger

Goal: a double-entry ledger with fees.

## 3. Ledger contracts

The shapes every task of this plan follows.

### 3.1 Entry shape

PLAN-3.1-MARK An entry names an account, an amount and a direction.

### 3.2 Posting rules

PLAN-3.2-MARK A posting is a balanced pair of entries written in one step.

## M1 — ledger

A1 [worker] — the ledger posts balanced entries and refuses an unbalanced pair
A2 [verifier] — the build boots and the ledger test file passes on a clean checkout
A3 — the ledger keeps every posting in the order it arrived

Check: bun test

### Task 1: Implement the ledger

Post entries as §3.2 sets out, and charge fees from the table in spec.md §4.

Interfaces: `post(pair: Pair): void`
Test: `ledger.test.ts` — "posts a balanced pair"

## M2 — fees

A4 [reviewer] — fees are rounded once, at the end of the posting

### Task 2: Add fees

Credit the account as credit.md §3 describes.

Test: `fees.test.ts` — "rounds once"
