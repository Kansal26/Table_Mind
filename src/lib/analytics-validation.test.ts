import { describe, expect, it } from "vitest";

import { syntheticDataset, type SyntheticDataset } from "./synthetic-dataset";
import {
  createExpectedCleanSubset,
  detectExplainableAnomalies,
  detectStatisticalAnomalies,
  detectStatisticalAnomaliesForMetric,
  validateAnalyticsDataset,
  validateDataQuality,
} from "./analytics-validation";

function createCleanDataset(): SyntheticDataset {
  return {
    ...syntheticDataset,
    restaurants: [
      { id: "rest-1", name: "Atlas Bistro", city: "Boston", active: true },
      { id: "rest-2", name: "Harbor Table", city: "Seattle", active: true },
    ],
    menuItems: [
      {
        id: "mi-clean-1",
        restaurant_id: "rest-1",
        name: "Soup",
        price: 10,
        category: "Starters",
        active: true,
      },
      {
        id: "mi-clean-2",
        restaurant_id: "rest-1",
        name: "Salad",
        price: 15,
        category: "Starters",
        active: true,
      },
      {
        id: "mi-clean-3",
        restaurant_id: "rest-2",
        name: "Rice Bowl",
        price: 18,
        category: "Mains",
        active: true,
      },
    ],
    orders: [
      {
        id: "clean-order-1",
        restaurant_id: "rest-1",
        table_label: "A1",
        ordered_at: "2025-01-08T18:10:00Z",
        status: "paid",
        subtotal: 35,
        discount_amount: 0,
        tax: 2.96,
        total: 37.96,
        payment_status: "paid",
        isValid: true,
      },
      {
        id: "clean-order-2",
        restaurant_id: "rest-2",
        table_label: "B2",
        ordered_at: "2025-01-10T18:40:00Z",
        status: "paid",
        subtotal: 18,
        discount_amount: 2,
        tax: 1.36,
        total: 17.36,
        payment_status: "paid",
        isValid: true,
      },
    ],
    orderItems: [
      {
        id: "clean-line-1",
        order_id: "clean-order-1",
        menu_item_id: "mi-clean-1",
        qty: 2,
        unit_price: 10,
        line_total: 20,
      },
      {
        id: "clean-line-2",
        order_id: "clean-order-1",
        menu_item_id: "mi-clean-2",
        qty: 1,
        unit_price: 15,
        line_total: 15,
      },
      {
        id: "clean-line-3",
        order_id: "clean-order-2",
        menu_item_id: "mi-clean-3",
        qty: 1,
        unit_price: 18,
        line_total: 18,
      },
    ],
    payments: [
      {
        id: "clean-payment-1",
        order_id: "clean-order-1",
        amount: 37.96,
        method: "card",
        status: "settled",
        created_at: "2025-01-08T18:40:00Z",
      },
      {
        id: "clean-payment-2",
        order_id: "clean-order-2",
        amount: 17.36,
        method: "upi",
        status: "settled",
        created_at: "2025-01-10T19:00:00Z",
      },
    ],
    refunds: [],
    invalidRows: [],
  };
}

describe("analytics validation", () => {
  it("exposes a reusable dataset-level validation interface and finding metadata", () => {
    const report = validateDataQuality(createCleanDataset());
    expect(report.findings.length).toBeGreaterThanOrEqual(0);
    const firstFinding = report.findings[0];
    if (firstFinding) {
      expect(firstFinding.ruleId ?? firstFinding.category).toBeTruthy();
      expect(firstFinding.recordIdentifier ?? firstFinding.recordId).toBeTruthy();
      expect(firstFinding.expectedCondition ?? firstFinding.expected ?? null).not.toBeUndefined();
      expect(firstFinding.recommendation).toBeTruthy();
    }
  });

  it("accepts a clean local fixture without integrity findings", () => {
    const cleanDataset = createCleanDataset();
    const report = validateAnalyticsDataset(cleanDataset);

    expect(report.findings.filter((finding) => !finding.isExpectedBaseline)).toEqual([]);
    expect(report.reconciliations.mismatchedOrders).toEqual([]);
  });

  it("flags duplicate identifiers and broken references", () => {
    const broken = createCleanDataset();
    const nextOrder = broken.orders[1];
    if (!nextOrder) {
      throw new Error("Expected at least two orders in test fixture.");
    }
    broken.orders.push({
      ...broken.orders[0],
      id: nextOrder.id,
    } as (typeof broken.orders)[number]);
    broken.orderItems.push({
      id: "bad-line",
      order_id: "missing-order",
      menu_item_id: "mi-clean-1",
      qty: 1,
      unit_price: 9,
      line_total: 9,
    });

    const report = validateAnalyticsDataset(broken);
    const hasDuplicateOrderId = report.findings.some(
      (finding) => finding.category === "duplicate_id" && finding.recordType === "order",
    );
    const hasBrokenReference = report.findings.some(
      (finding) => finding.category === "broken_reference" && finding.recordId === "bad-line",
    );

    expect(hasDuplicateOrderId).toBe(true);
    expect(hasBrokenReference).toBe(true);
  });

  it("detects known invalid fixtures from the committed dataset", () => {
    const report = validateAnalyticsDataset(syntheticDataset);
    const reasons = report.findings
      .filter((finding) => finding.category === "known_invalid_fixture")
      .map((finding) => finding.actual);

    expect(reasons).toEqual(
      expect.arrayContaining([
        "negative subtotal",
        "tax exceeds subtotal",
        "refund without payment",
        "future-dated order",
      ]),
    );
  });

  it("flags incorrect totals and payment/refund mismatches", () => {
    const broken = createCleanDataset();
    broken.orders[0] = {
      ...broken.orders[0],
      id: "bad-total-order",
      restaurant_id: "rest-1",
      table_label: "A1",
      ordered_at: "2025-01-08T18:10:00Z",
      status: "paid",
      subtotal: 30,
      discount_amount: 0,
      tax: 2,
      total: 50,
      payment_status: "paid",
      isValid: true,
    };
    broken.payments[0] = {
      ...broken.payments[0],
      id: "bad-payment",
      order_id: "bad-total-order",
      amount: 20,
      method: "card",
      status: "settled",
      created_at: "2025-01-08T18:40:00Z",
    };
    broken.refunds = [
      {
        id: "bad-refund",
        order_id: "bad-total-order",
        amount: 25,
        reason: "over_refund",
        created_at: "2025-01-09T10:00:00Z",
      },
    ];

    const report = validateAnalyticsDataset(broken);
    expect(
      report.findings.some(
        (finding) => finding.category === "invalid_total" && finding.recordId === "bad-total-order",
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (finding) =>
          finding.category === "payment_mismatch" && finding.recordId === "bad-total-order",
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (finding) => finding.category === "refund_mismatch" && finding.recordId === "bad-refund",
      ),
    ).toBe(true);
  });

  it("flags invalid timestamps and cross-restaurant inconsistencies", () => {
    const broken = createCleanDataset();
    broken.orders[0] = {
      ...broken.orders[0],
      id: "bad-time-order",
      restaurant_id: "rest-1",
      table_label: "A1",
      ordered_at: "2099-01-01T00:00:00Z",
      status: "paid",
      subtotal: 35,
      discount_amount: 0,
      tax: 2.96,
      total: 37.96,
      payment_status: "paid",
      isValid: true,
    };
    broken.orderItems.push({
      id: "cross-restaurant-line",
      order_id: "bad-time-order",
      menu_item_id: "mi-clean-3",
      qty: 1,
      unit_price: 12,
      line_total: 12,
    });

    const report = validateAnalyticsDataset(broken);
    expect(
      report.findings.some(
        (finding) =>
          finding.category === "timestamp_issue" && finding.recordId === "bad-time-order",
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (finding) =>
          finding.category === "cross_restaurant" && finding.recordId === "cross-restaurant-line",
      ),
    ).toBe(true);
  });

  it("detects anomalies with deterministic rules and ignores zero-variance or tiny samples", () => {
    const outlierDataset = createCleanDataset();
    const baseOrder = outlierDataset.orders[0];
    if (!baseOrder) {
      throw new Error("Expected at least one base order in the test fixture.");
    }
    outlierDataset.orders = [
      {
        ...baseOrder,
        id: "o-1",
        total: 100,
        restaurant_id: "rest-1",
        table_label: "A1",
        ordered_at: "2025-01-08T18:10:00Z",
        status: "paid",
        subtotal: 100,
        discount_amount: 0,
        tax: 0,
        payment_status: "paid",
        isValid: true,
      },
      {
        ...baseOrder,
        id: "o-2",
        total: 110,
        restaurant_id: "rest-1",
        table_label: "A2",
        ordered_at: "2025-01-08T18:11:00Z",
        status: "paid",
        subtotal: 110,
        discount_amount: 0,
        tax: 0,
        payment_status: "paid",
        isValid: true,
      },
      {
        ...baseOrder,
        id: "o-3",
        total: 105,
        restaurant_id: "rest-1",
        table_label: "A3",
        ordered_at: "2025-01-08T18:12:00Z",
        status: "paid",
        subtotal: 105,
        discount_amount: 0,
        tax: 0,
        payment_status: "paid",
        isValid: true,
      },
      {
        ...baseOrder,
        id: "o-4",
        total: 120,
        restaurant_id: "rest-1",
        table_label: "A4",
        ordered_at: "2025-01-08T18:13:00Z",
        status: "paid",
        subtotal: 120,
        discount_amount: 0,
        tax: 0,
        payment_status: "paid",
        isValid: true,
      },
      {
        ...baseOrder,
        id: "o-5",
        total: 600,
        restaurant_id: "rest-1",
        table_label: "A5",
        ordered_at: "2025-01-08T18:14:00Z",
        status: "paid",
        subtotal: 600,
        discount_amount: 0,
        tax: 0,
        payment_status: "paid",
        isValid: true,
      },
    ];
    outlierDataset.orderItems = [
      {
        id: "o-1-line",
        order_id: "o-1",
        menu_item_id: "mi-clean-1",
        qty: 1,
        unit_price: 100,
        line_total: 100,
      },
      {
        id: "o-2-line",
        order_id: "o-2",
        menu_item_id: "mi-clean-1",
        qty: 1,
        unit_price: 110,
        line_total: 110,
      },
      {
        id: "o-3-line",
        order_id: "o-3",
        menu_item_id: "mi-clean-1",
        qty: 1,
        unit_price: 105,
        line_total: 105,
      },
      {
        id: "o-4-line",
        order_id: "o-4",
        menu_item_id: "mi-clean-1",
        qty: 1,
        unit_price: 120,
        line_total: 120,
      },
      {
        id: "o-5-line",
        order_id: "o-5",
        menu_item_id: "mi-clean-1",
        qty: 1,
        unit_price: 600,
        line_total: 600,
      },
    ];
    outlierDataset.payments = outlierDataset.orders.map((order, index) => ({
      id: `pay-${index}`,
      order_id: order.id,
      amount: order.total,
      method: "card",
      status: "settled",
      created_at: order.ordered_at,
    }));

    const firstReport = detectStatisticalAnomalies(outlierDataset);
    const secondReport = detectStatisticalAnomalies(outlierDataset);
    expect(firstReport).toEqual(secondReport);
    expect(firstReport.some((item) => item.metric === "order_total" && item.value === 600)).toBe(
      true,
    );

    const normal = detectStatisticalAnomaliesForMetric([5, 5, 5], "order_total");
    const tinySample = detectStatisticalAnomaliesForMetric([10, 11, 12], "order_total");
    expect(normal).toEqual([]);
    expect(tinySample).toEqual([]);
  });

  it("uses explainable, configurable statistical thresholds for known anomalies", () => {
    const dataset = createCleanDataset();
    const baseOrder = dataset.orders[0];
    if (!baseOrder) {
      throw new Error("Expected at least one base order in the clean dataset fixture.");
    }

    dataset.orders = [
      {
        ...baseOrder,
        id: "x-1",
        restaurant_id: "rest-1",
        table_label: "A1",
        ordered_at: "2025-01-08T18:10:00Z",
        status: "paid",
        subtotal: 100,
        discount_amount: 0,
        tax: 0,
        total: 100,
        payment_status: "paid",
        isValid: true,
      },
      {
        ...baseOrder,
        id: "x-2",
        restaurant_id: "rest-1",
        table_label: "A2",
        ordered_at: "2025-01-08T18:11:00Z",
        status: "paid",
        subtotal: 110,
        discount_amount: 0,
        tax: 0,
        total: 110,
        payment_status: "paid",
        isValid: true,
      },
      {
        ...baseOrder,
        id: "x-3",
        restaurant_id: "rest-1",
        table_label: "A3",
        ordered_at: "2025-01-08T18:12:00Z",
        status: "paid",
        subtotal: 105,
        discount_amount: 0,
        tax: 0,
        total: 105,
        payment_status: "paid",
        isValid: true,
      },
      {
        ...baseOrder,
        id: "x-4",
        restaurant_id: "rest-1",
        table_label: "A4",
        ordered_at: "2025-01-08T18:13:00Z",
        status: "paid",
        subtotal: 120,
        discount_amount: 0,
        tax: 0,
        total: 120,
        payment_status: "paid",
        isValid: true,
      },
      {
        ...baseOrder,
        id: "x-5",
        restaurant_id: "rest-1",
        table_label: "A5",
        ordered_at: "2025-01-08T18:14:00Z",
        status: "paid",
        subtotal: 600,
        discount_amount: 0,
        tax: 0,
        total: 600,
        payment_status: "paid",
        isValid: true,
      },
    ];
    dataset.payments = dataset.orders.map((order, index) => ({
      id: `pay-x-${index}`,
      order_id: order.id,
      amount: order.total,
      method: "card",
      status: "settled",
      created_at: order.ordered_at,
    }));

    const anomalies = detectExplainableAnomalies(dataset, {
      minSamples: 3,
      iqrMultiplier: 1.5,
      zScoreThreshold: 3,
      dailyRevenueZScoreThreshold: 2.5,
    });

    const orderAnomaly = anomalies.find(
      (anomaly) => anomaly.metric === "order_total" && anomaly.comparisonGroup === "restaurant:rest-1",
    );

    expect(orderAnomaly).toBeDefined();
    expect(orderAnomaly?.method).toBe("IQR");
    expect(orderAnomaly?.threshold).toBe(1.5);
    expect(orderAnomaly?.explanation).toContain("statistical flag");
  });

  it("reuses committed fixtures for a deterministic report object", () => {
    const cleaned = createExpectedCleanSubset(syntheticDataset);
    const report = validateAnalyticsDataset(cleaned);
    expect(report.metadata.seed).toBe(syntheticDataset.metadata.seed);
    expect(report.summary.totalOrders).toBeGreaterThan(0);
    expect(report.findings.some((finding) => finding.category === "known_invalid_fixture")).toBe(
      false,
    );
  });
});
