# Analytics validation and anomaly detection

This module validates the deterministic local dataset used for TableMind analytics QA. It is intentionally isolated from production data and does not call live Supabase services.

## Scope

The validator checks the data that is actually represented in the committed fixture:

- duplicate identifiers
- missing required values
- broken references between orders, items, payments, and refunds
- invalid status values
- impossible timestamps
- cross-restaurant references
- payment/refund reconciliation
- total formula validation using `subtotal - discount_amount + tax = total`

It does not assume undocumented columns or production schema behavior beyond what is represented by the committed fixture.

## Statistical anomaly detection

Anomalies are reported separately from hard data-integrity violations. The implementation uses an IQR-style rule for supported metrics such as order totals and quantities.

Rules:

- values are evaluated against the median and IQR for a given metric
- a value outside the interquartile range is flagged as a statistical anomaly
- if the sample is too small or the variance is zero, the detector is conservative and does not label a point as unusual
- the same input yields the same result because there is no randomization

This keeps anomalies distinct from definitely incorrect records.

## Report shape

The validator returns a JSON-like object with:

- `metadata`
- `summary`
- `findings`
- `anomalies`
- `reconciliations`

Each finding includes:

- severity
- category
- record identifier (when available)
- explanation
- expected and actual values when meaningful

## Run commands

```bash
cd /Users/adikansal2608/Desktop/TableMind/table-mind-magic
npm test
npx tsc --noEmit
npm run build
npm run lint
```

## Important assumptions

- The fixture is a local test dataset only.
- Intentionally invalid rows are preserved under `invalidRows` and should be detected as expected baseline problems rather than treated as a broken test suite.
- The implementation uses deterministic arithmetic and rule-based outlier checks; it does not infer hidden business logic from live production data.
