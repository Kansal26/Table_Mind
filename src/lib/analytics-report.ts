import {
  sortFindingsBySeverity,
  validateAnalyticsDataset,
  type AnalyticsValidationReport,
  type StatisticalAnomaly,
  type ValidationFinding,
} from "./analytics-validation";
import type { SyntheticDataset } from "./synthetic-dataset";

type ReconciliationResult = {
  evaluated: number;
  matched: number;
  mismatched: number;
  totalExpected: number;
  totalActual: number;
  records: {
    recordId: string;
    expected: number;
    actual: number;
    difference: number;
    matches: boolean;
  }[];
};

export type AnalyticsReport = {
  reportVersion: 1;
  metadata: {
    seed: number;
    fixtureGeneratedAt: string;
    localOnly: true;
  };
  recordsAnalyzed: {
    total: number;
    byType: Record<string, number>;
  };
  validation: {
    findingCount: number;
    errorFindingCount: number;
    warningCount: number;
    recordsWithValidationErrors: number;
    recordsWithWarnings: number;
    expectedBaselineFindingCount: number;
    unexpectedFindingCount: number;
    findingsByCategory: Record<string, { findingCount: number; distinctRecordCount: number }>;
    findingsBySeverity: AnalyticsValidationReport["summary"]["findingsBySeverity"];
    findings: ValidationFinding[];
  };
  statisticalAnomalies: {
    count: number;
    anomalies: StatisticalAnomaly[];
  };
  reconciliations: {
    orderTotals: ReconciliationResult;
    payments: ReconciliationResult & {
      excludedOrders: number;
      excludedNonSettledPayments: number;
    };
    totalSettledPayments: number;
    totalRefunds: number;
  };
  summaries: {
    byRestaurant: {
      restaurantId: string;
      restaurantName: string;
      orderCount: number;
      cancelledOrderCount: number;
      grossRevenue: number;
      settledPayments: number;
      refunds: number;
    }[];
    byDay: {
      date: string;
      orderCount: number;
      cancelledOrderCount: number;
      grossRevenue: number;
      refunds: number;
    }[];
  };
  importantFindings: {
    type: "validation" | "statistical_anomaly";
    recordId?: string;
    categoryOrMetric: string;
    severity: string;
    expectedBaseline: boolean;
    explanation: string;
  }[];
  assumptionsAndLimitations: string[];
};

function toCents(value: number): number {
  return Math.round(value * 100);
}

function fromCents(value: number): number {
  return value / 100;
}

function recordKey(finding: ValidationFinding, findingIndex: number): string {
  const identifier = finding.recordIdentifier ?? finding.recordId;
  return identifier && identifier !== "unknown"
    ? `${finding.recordType}:${identifier}`
    : `${finding.recordType}:unknown:${findingIndex}`;
}

function buildReconciliation(
  records: { recordId: string; expectedCents: number; actualCents: number }[],
): ReconciliationResult {
  const reconciledRecords = records.map((record) => {
    const differenceCents = record.actualCents - record.expectedCents;
    const matches = Math.abs(differenceCents) <= 1;
    return {
      recordId: record.recordId,
      expected: fromCents(record.expectedCents),
      actual: fromCents(record.actualCents),
      difference: fromCents(differenceCents),
      matches,
    };
  });

  return {
    evaluated: reconciledRecords.length,
    matched: reconciledRecords.filter((record) => record.matches).length,
    mismatched: reconciledRecords.filter((record) => !record.matches).length,
    totalExpected: fromCents(records.reduce((sum, record) => sum + record.expectedCents, 0)),
    totalActual: fromCents(records.reduce((sum, record) => sum + record.actualCents, 0)),
    records: reconciledRecords,
  };
}

export function createAnalyticsReport(dataset: SyntheticDataset): AnalyticsReport {
  const validation = validateAnalyticsDataset(dataset);
  const categoryGroups = new Map<string, Set<string>>();
  const errorRecordKeys = new Set<string>();
  const warningRecordKeys = new Set<string>();

  for (const [findingIndex, finding] of validation.findings.entries()) {
    const key = recordKey(finding, findingIndex);
    const records = categoryGroups.get(finding.category) ?? new Set<string>();
    records.add(key);
    categoryGroups.set(finding.category, records);

    if (finding.severity === "critical" || finding.severity === "error") {
      errorRecordKeys.add(key);
    } else if (finding.severity === "warning") {
      warningRecordKeys.add(key);
    }
  }

  for (const key of errorRecordKeys) {
    warningRecordKeys.delete(key);
  }

  const findingsByCategory = Object.fromEntries(
    Object.entries(validation.summary.findingsByCategory).map(([category, findingCount]) => [
      category,
      {
        findingCount,
        distinctRecordCount: categoryGroups.get(category)?.size ?? 0,
      },
    ]),
  );

  const validOrders = dataset.orders.filter((order) => order.isValid !== false);
  const orderTotals = buildReconciliation(
    validOrders.map((order) => ({
      recordId: order.id,
      expectedCents: toCents(order.subtotal) - toCents(order.discount_amount) + toCents(order.tax),
      actualCents: toCents(order.total),
    })),
  );

  const eligiblePaymentOrders = validOrders.filter(
    (order) => order.status === "paid" || order.status === "refunded",
  );
  const paymentRecords = eligiblePaymentOrders.map((order) => {
    const settledCents = dataset.payments
      .filter((payment) => payment.order_id === order.id && payment.status === "settled")
      .reduce((sum, payment) => sum + toCents(payment.amount), 0);
    return {
      recordId: order.id,
      expectedCents: toCents(order.total),
      actualCents: settledCents,
    };
  });
  const payments = {
    ...buildReconciliation(paymentRecords),
    excludedOrders: validOrders.length - eligiblePaymentOrders.length,
    excludedNonSettledPayments: dataset.payments.filter((payment) => payment.status !== "settled")
      .length,
  };

  const restaurants = new Map(
    dataset.restaurants.map((restaurant) => [
      restaurant.id,
      {
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        orderCount: 0,
        cancelledOrderCount: 0,
        grossRevenueCents: 0,
        settledPaymentsCents: 0,
        refundsCents: 0,
      },
    ]),
  );
  const daily = new Map<
    string,
    {
      date: string;
      orderCount: number;
      cancelledOrderCount: number;
      grossRevenueCents: number;
      refundsCents: number;
    }
  >();

  for (const order of validOrders) {
    const summary = restaurants.get(order.restaurant_id);
    if (summary) {
      summary.orderCount += 1;
      if (order.status === "cancelled") {
        summary.cancelledOrderCount += 1;
      } else {
        summary.grossRevenueCents += toCents(order.total);
      }
    }

    const date = order.ordered_at.slice(0, 10);
    const day = daily.get(date) ?? {
      date,
      orderCount: 0,
      cancelledOrderCount: 0,
      grossRevenueCents: 0,
      refundsCents: 0,
    };
    day.orderCount += 1;
    if (order.status === "cancelled") {
      day.cancelledOrderCount += 1;
    } else {
      day.grossRevenueCents += toCents(order.total);
    }
    daily.set(date, day);
  }

  for (const payment of dataset.payments.filter((record) => record.status === "settled")) {
    const order = validOrders.find((candidate) => candidate.id === payment.order_id);
    if (!order) continue;
    const summary = restaurants.get(order.restaurant_id);
    if (summary) summary.settledPaymentsCents += toCents(payment.amount);
  }

  for (const refund of dataset.refunds) {
    const order = validOrders.find((candidate) => candidate.id === refund.order_id);
    if (!order) continue;
    const summary = restaurants.get(order.restaurant_id);
    if (summary) summary.refundsCents += toCents(refund.amount);

    const date = refund.created_at.slice(0, 10);
    const day = daily.get(date) ?? {
      date,
      orderCount: 0,
      cancelledOrderCount: 0,
      grossRevenueCents: 0,
      refundsCents: 0,
    };
    day.refundsCents += toCents(refund.amount);
    daily.set(date, day);
  }

  const severityOrder: Record<string, number> = { critical: 4, error: 3, warning: 2, info: 1 };
  const importantFindings = [
    ...sortFindingsBySeverity(validation.findings).map((finding) => ({
      type: "validation" as const,
      ...(finding.recordId ? { recordId: finding.recordId } : {}),
      categoryOrMetric: finding.category,
      severity: finding.severity,
      expectedBaseline: finding.isExpectedBaseline ?? false,
      explanation: finding.message,
    })),
    ...validation.anomalies.map((anomaly) => ({
      type: "statistical_anomaly" as const,
      ...(anomaly.recordId ? { recordId: anomaly.recordId } : {}),
      categoryOrMetric: anomaly.metric,
      severity: anomaly.severity,
      expectedBaseline: false,
      explanation: anomaly.explanation,
    })),
  ]
    .sort((left, right) => {
      return (severityOrder[right.severity] ?? 0) - (severityOrder[left.severity] ?? 0);
    })
    .slice(0, 10);

  return {
    reportVersion: 1,
    metadata: {
      seed: dataset.metadata.seed,
      fixtureGeneratedAt: dataset.metadata.generatedAt,
      localOnly: true,
    },
    recordsAnalyzed: {
      total: validation.metadata.recordsAnalyzed,
      byType: {
        restaurants: dataset.restaurants.length,
        menuItems: dataset.menuItems.length,
        orders: dataset.orders.length,
        orderItems: dataset.orderItems.length,
        payments: dataset.payments.length,
        refunds: dataset.refunds.length,
        knownInvalidRows: dataset.invalidRows.length,
      },
    },
    validation: {
      findingCount: validation.findings.length,
      errorFindingCount:
        validation.summary.findingsBySeverity.error +
        validation.summary.findingsBySeverity.critical,
      warningCount: validation.summary.findingsBySeverity.warning,
      recordsWithValidationErrors: errorRecordKeys.size,
      recordsWithWarnings: warningRecordKeys.size,
      expectedBaselineFindingCount: validation.findings.filter(
        (finding) => finding.isExpectedBaseline,
      ).length,
      unexpectedFindingCount: validation.findings.filter((finding) => !finding.isExpectedBaseline)
        .length,
      findingsByCategory,
      findingsBySeverity: validation.summary.findingsBySeverity,
      findings: validation.findings,
    },
    statisticalAnomalies: {
      count: validation.anomalies.length,
      anomalies: validation.anomalies,
    },
    reconciliations: {
      orderTotals,
      payments,
      totalSettledPayments: fromCents(
        dataset.payments
          .filter((payment) => payment.status === "settled")
          .reduce((sum, payment) => sum + toCents(payment.amount), 0),
      ),
      totalRefunds: fromCents(
        dataset.refunds.reduce((sum, refund) => sum + toCents(refund.amount), 0),
      ),
    },
    summaries: {
      byRestaurant: Array.from(restaurants.values())
        .map(({ grossRevenueCents, settledPaymentsCents, refundsCents, ...summary }) => ({
          ...summary,
          grossRevenue: fromCents(grossRevenueCents),
          settledPayments: fromCents(settledPaymentsCents),
          refunds: fromCents(refundsCents),
        }))
        .sort((left, right) => left.restaurantId.localeCompare(right.restaurantId)),
      byDay: Array.from(daily.values())
        .map(({ grossRevenueCents, refundsCents, ...summary }) => ({
          ...summary,
          grossRevenue: fromCents(grossRevenueCents),
          refunds: fromCents(refundsCents),
        }))
        .sort((left, right) => left.date.localeCompare(right.date)),
    },
    importantFindings,
    assumptionsAndLimitations: [
      "This report is generated only from the deterministic, local synthetic fixture and does not read production data or call live services.",
      "Records analyzed counts each row in each fixture collection, including separately stored known-invalid rows; these may represent intentional corruptions rather than independent production records.",
      "Validation category counts count findings and distinct affected records within each category. The same record can appear in multiple categories, so category counts should not be summed to derive unique affected records.",
      "Records with validation errors counts distinct record-type/identifier pairs with error or critical findings. Warning records exclude records already counted as errors.",
      "Order-total reconciliation applies subtotal minus discount plus tax with a one-cent tolerance, matching the fixture validator's stated formula.",
      "Payment reconciliation compares settled payments with the gross total for paid or refunded orders. Cancelled and other order states are excluded; refunds are reported separately because a refund does not change the original captured payment.",
      "Daily revenue is grouped by order date and excludes cancelled orders. Refunds are grouped by refund date. Sparse fixture dates are not a meaningful production trend baseline.",
      "Statistical anomalies are heuristic flags, not confirmed data defects or fraud; the fixture is too small for strong statistical inference.",
    ],
  };
}
