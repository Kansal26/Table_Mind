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

Generate the expanded, reproducible JSON analytics report from the deterministic fixture:

```bash
npm run analytics:report
```

This writes `reports/analytics-validation.json`. The report includes:

- row counts by fixture collection and total rows analyzed
- validation findings, grouped by category and severity, with unique affected-record counts
- error and warning record counts that avoid counting the same record twice across those severity totals
- statistical anomalies kept separate from deterministic validation findings
- per-order formula reconciliation and settled-payment reconciliation
- daily and restaurant summaries, plus the most important explanations
- assumptions and limitations alongside the machine-readable results
- expected-baseline findings are marked in the highlighted findings so known-invalid fixture cases remain visible without being mistaken for unexpected failures

Category counts represent findings and distinct affected records _within that category_. A record can have findings in multiple categories, so category counts are not additive. Known-invalid fixture rows are included and explicitly identified as expected baseline findings.

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
- Order totals are reconciled as `subtotal - discount_amount + tax` within one cent.
- Payment reconciliation compares settled payments with the gross total of paid/refunded orders. Cancelled orders are excluded; refunds are reported separately and do not reduce original captured-payment totals.
- Malformed order, payment, and refund timestamps are validation errors. Payment and refund timestamps must be ISO-8601 timestamps with a time and timezone; chronological comparisons are made only when both related timestamps parse.
- Refunded-order payment reconciliation checks the original settled capture against the original order total. Refund amounts are validated separately against settled captured payments.
- Daily revenue is grouped by order date and excludes cancelled orders; refund amounts use refund date. Sparse synthetic dates are not a meaningful production trend baseline.
- Statistical anomalies are heuristic observations, not confirmed defects or fraud; the small fixture limits statistical inference.
