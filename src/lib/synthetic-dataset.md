# Deterministic synthetic analytics dataset

This fixture is intentionally local-only. It is designed for analytics validation and data-quality tests and must never be inserted into a production database or service-backed environment.

## Purpose

The dataset models a small but realistic ordering environment with:

- 3 restaurants in different cities
- 8 valid orders spanning several dates
- multiple statuses (`paid`, `cancelled`, `refunded`)
- associated order items, payments, and refunds
- 4 deliberately invalid records for validation testing

## Structure

The dataset is exported from `src/lib/synthetic-dataset.ts` and includes:

- `restaurants`: restaurant dimension rows
- `menuItems`: item catalog rows for each restaurant
- `orders`: valid order records with subtotal, discount, tax, total, and status
- `orderItems`: line items for each order
- `payments`: payment rows for successful settlements
- `refunds`: refund rows linked to refunded orders
- `invalidRows`: intentionally corrupted records with `isValid: false`

## Dataset properties

- Deterministic: generated from a fixed seed (`20250120`)
- Normal and invalid records are clearly separated via `isValid` and `invalidReason`
- Expected totals are defined in the test file, not derived from the function under test
- The fixture is intentionally small enough to run quickly while still exercising real-world edge cases

## Expected summary

The independent expected summary is:

- valid orders: 8
- invalid rows: 4
- gross revenue (excluding cancelled orders): 760.98
- total refunds: 82.70

These values are asserted in `src/lib/synthetic-dataset.test.ts`.
