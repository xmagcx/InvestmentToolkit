# Portfolio Maintainer Specification

## Purpose

Manual web portfolio data entry and maintenance replacing broken TV/CDP sync. User records buy/sell transactions and manages accounts/cash; system computes weighted-average cost and maintains cash balance on `domain_model.sqlite`. Every transaction writes an audit row to `trade_log_entry`. No new schema.

## ADDED Requirements

### Requirement: Buy — weighted average cost

On a buy entry (ticker, qty, price, optional commission), the system MUST recompute quantity and average cost on the target `account_investment` row. First buy: `avg = (qty*price + commission) / qty`. Subsequent: `new_qty = old_qty + qty; new_avg = (old_qty*old_avg + qty*price + commission) / new_qty`. Commission SHALL default to 0 when omitted.

#### Scenario: First buy

- GIVEN no position for TICKER in ACCOUNT and account cash >= qty*price + commission
- WHEN user records a buy for qty=2, price=50, commission=10
- THEN position created with quantity=2, average_cost=55
- AND account cash reduced by 110

#### Scenario: Subsequent buy

- GIVEN position TICKER quantity=2, average_cost=55
- WHEN user records buy qty=1, price=60, commission=0
- THEN quantity=3, average_cost=(2*55 + 1*60)/3 = 56.67

#### Scenario: Commission omitted

- GIVEN commission field blank
- WHEN user records first buy qty=4, price=25
- THEN average_cost=25 (commission treated as 0)

### Requirement: Sell / trim — avg cost unchanged

On a sell entry, the system MUST reduce quantity only and SHALL keep average cost unchanged: `new_qty = old_qty - qty; new_avg = old_avg`. Oversell (qty > old_qty) MUST be rejected with a clear error. Full exit (new_qty <= 0) MUST delete the `account_investment` row.

#### Scenario: Partial sell keeps avg

- GIVEN position quantity=10, average_cost=20
- WHEN user records sell qty=4, price=30, commission=5
- THEN quantity=6, average_cost=20
- AND account cash increased by 4*30 - 5 = 115

#### Scenario: Oversell rejected

- GIVEN position quantity=5
- WHEN user records sell qty=6
- THEN transaction rejected with error, position unchanged, no trade_log_entry

#### Scenario: Full exit deletes row

- GIVEN position quantity=3
- WHEN user records sell qty=3
- THEN position row deleted, cash increased by proceeds - commission

### Requirement: Cash per account updated by transactions

The system MUST maintain per-account cash, modeled as synthetic `CASH_<CURRENCY>` `account_investment` row (average_cost=1.0). Buy SHALL deduct `qty*price + commission`; sell SHALL add `qty*price - commission`. Overspend (buy exceeding available account cash) MUST be rejected.

#### Scenario: Buy deducts cash

- GIVEN account cash = 1000
- WHEN user records buy costing 110 (with commission)
- THEN cash = 890

#### Scenario: Overspend rejected

- GIVEN account cash = 50
- WHEN user records buy costing 110
- THEN transaction rejected, no position/cash/trade_log change

#### Scenario: Sell adds cash

- GIVEN account cash = 1000
- WHEN user records sell proceeds 95 (after commission)
- THEN cash = 1095

### Requirement: Account management

The system MUST support creating and editing accounts (TFSA/RRSP/CASH). Each account SHALL have a base currency, defaulting TFSA/RRSP=CAD and CASH=USD, editable at creation. Initial cash SHALL be settable per account.

#### Scenario: Create account with default currency

- GIVEN user creates account type TFSA
- THEN account created, base currency CAD

#### Scenario: Set initial cash

- GIVEN account exists
- WHEN user sets initial cash = 5000
- THEN `CASH_CAD` row quantity=5000

### Requirement: Audit trail

The system MUST write one `trade_log_entry` per buy/sell transaction with current timestamp and outcome.

#### Scenario: Buy logged

- GIVEN successful buy
- THEN trade_log_entry written documenting ticker, qty, price, commission, avg cost, timestamp

#### Scenario: Rejected transaction not logged

- GIVEN oversell or overspend rejected
- THEN no trade_log_entry written

### Requirement: Position removal

The system MUST support deleting a position via DELETE endpoint after confirmation.

#### Scenario: Delete position

- GIVEN position exists
- WHEN user confirms delete
- THEN position row removed, cash unchanged

## ADDED edge-case requirement

### Requirement: Currency correctness

Buy/sell cash math SHALL use the account's base currency; positions and cash in different currencies MUST NOT be mixed.

#### Scenario: USD cash account sell

- GIVEN CASH account base currency USD, cash=5000
- WHEN sell proceeds 95 USD
- THEN cash=5095 (USD, not converted)
