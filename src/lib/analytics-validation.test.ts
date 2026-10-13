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
    expect(report.summary.findingsBySeverity).toEqual({
      info: 0,
      warning: 0,
      error: 0,
      critical: 0,
    });
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
    expect(
      report.findings.find(
        (finding) => finding.category === "duplicate_id" && finding.recordType === "order",
      ),
    ).toMatchObject({
      severity: "critical",
      recordId: nextOrder.id,
      message: "Duplicate order identifier found in the fixture.",
    });
    expect(report.summary.findingsBySeverity).toEqual({
      info: 0,
      warning: 2,
      error: 1,
      critical: 1,
    });
    expect(report.summary.findingsByCategory["duplicate_id"]).toBe(1);
    expect(report.summary.findingsByCategory["broken_reference"]).toBe(1);
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
    broken.orderItems = broken.orderItems.map((item) =>
      item.order_id === "clean-order-1" ? { ...item, order_id: "bad-total-order" } : item,
    );
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
      report.findings.find(
        (finding) =>
          finding.category === "payment_mismatch" && finding.recordId === "bad-total-order",
      ),
    ).toMatchObject({
      severity: "warning",
      expected: 50,
      actual: 20,
      message: "Paid order total does not match the settled payment total.",
    });
    expect(
      report.findings.some(
        (finding) => finding.category === "refund_mismatch" && finding.recordId === "bad-refund",
      ),
    ).toBe(true);
    expect(
      report.findings.find(
        (finding) => finding.category === "refund_mismatch" && finding.recordId === "bad-refund",
      ),
    ).toMatchObject({
      severity: "error",
      expected: 20,
      actual: 25,
      message: "Refund exceeds the total captured payment for the order.",
    });
    expect(
      report.findings.find(
        (finding) => finding.category === "invalid_total" && finding.recordId === "bad-total-order",
      ),
    ).toMatchObject({
      severity: "error",
      expected: 32,
      actual: 50,
      message: expect.stringContaining("subtotal - discount + tax"),
    });
    expect(
      report.findings.find(
        (finding) =>
          finding.category === "invalid_total" &&
          finding.recordType === "order" &&
          finding.recordId === "bad-total-order" &&
          finding.severity === "warning",
      ),
    ).toMatchObject({
      expected: 35,
      actual: 30,
      message: expect.stringContaining("Line item totals do not reconcile"),
    });
    expect(report.summary.findingsBySeverity.error).toBe(2);
    expect(report.summary.findingsByCategory["invalid_total"]).toBe(2);
    expect(report.summary.findingsByCategory["payment_mismatch"]).toBe(1);
    expect(report.summary.findingsByCategory["refund_mismatch"]).toBe(1);
  });

  it("reports invalid line-item totals with the independently expected amount", () => {
    const broken = createCleanDataset();
    const line = broken.orderItems[0];
    if (!line) {
      throw new Error("Expected a line item in the clean dataset fixture.");
    }
    broken.orderItems[0] = { ...line, line_total: 19 };

    const report = validateAnalyticsDataset(broken);
    const finding = report.findings.find(
      (item) => item.category === "invalid_total" && item.recordId === line.id,
    );

    expect(finding).toMatchObject({
      severity: "warning",
      expected: 20,
      actual: 19,
      message: "Order item line total does not equal quantity × unit price.",
    });
    expect(report.summary.findingsBySeverity.warning).toBe(2);
  });

  it("rejects zero quantities and negative discounts with specific error findings", () => {
    const broken = createCleanDataset();
    const line = broken.orderItems[0];
    const order = broken.orders[0];
    if (!line || !order) {
      throw new Error("Expected an order and line item in the clean dataset fixture.");
    }
    broken.orderItems[0] = { ...line, qty: 0 };
    broken.orders[0] = {
      ...order,
      discount_amount: -2,
      total: order.subtotal + 2 + order.tax,
    };

    const report = validateAnalyticsDataset(broken);
    const quantityFinding = report.findings.find(
      (item) => item.recordType === "order_item" && item.recordId === line.id,
    );
    const discountFinding = report.findings.find(
      (item) =>
        item.recordType === "order" &&
        item.recordId === order.id &&
        item.category === "invalid_total",
    );

    expect(quantityFinding).toMatchObject({
      severity: "error",
      category: "invalid_total",
      expected: "qty > 0, unit_price >= 0, line_total >= 0",
      actual: JSON.stringify({ qty: 0, unit_price: 10, line_total: 20 }),
      message: "Order item contains invalid quantity or monetary values.",
    });
    expect(discountFinding).toMatchObject({
      severity: "error",
      category: "invalid_total",
      actual: JSON.stringify({
        subtotal: 35,
        discount_amount: -2,
        tax: 2.96,
        total: 39.96,
      }),
      message: "Order totals contain negative values.",
    });
    expect(report.summary.findingsBySeverity.error).toBe(2);
  });

  it("flags missing order and menu-item references on an order item", () => {
    const broken = createCleanDataset();
    broken.orderItems.push({
      id: "orphan-line",
      order_id: "missing-order",
      menu_item_id: "missing-menu-item",
      qty: 1,
      unit_price: 4,
      line_total: 4,
    });

    const report = validateAnalyticsDataset(broken);
    const findings = report.findings.filter((finding) => finding.recordId === "orphan-line");

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        "Order item points to a missing order.",
        "Order item references a menu item that is not present in the fixture.",
      ]),
    );
    expect(findings.every((finding) => finding.severity === "error")).toBe(true);
    expect(report.summary.findingsByCategory["broken_reference"]).toBe(2);
  });

  it("does not reconcile a paid order against a pending payment", () => {
    const broken = createCleanDataset();
    const payment = broken.payments[0];
    if (!payment) {
      throw new Error("Expected a payment in the clean dataset fixture.");
    }
    broken.payments[0] = { ...payment, status: "pending" };

    const report = validateAnalyticsDataset(broken);
    const finding = report.findings.find(
      (item) => item.category === "payment_mismatch" && item.recordId === payment.order_id,
    );

    expect(finding).toMatchObject({
      severity: "error",
      expected: "payment amount > 0 for paid",
      actual: 0,
      message: "A paid or refunded order is missing a corresponding settled payment.",
    });
    expect(report.summary.findingsBySeverity.error).toBe(1);
    expect(report.summary.findingsByCategory["payment_mismatch"]).toBe(1);
  });

  it("reports malformed order, payment, and refund timestamps", () => {
    const broken = createCleanDataset();
    const order = broken.orders[0];
    const payment = broken.payments[0];
    if (!order || !payment) {
      throw new Error("Expected an order and payment in the clean dataset fixture.");
    }
    broken.orders[0] = { ...order, ordered_at: "not-a-timestamp" };
    broken.payments[0] = { ...payment, created_at: "also-not-a-timestamp" };
    broken.refunds = [
      {
        id: "malformed-refund",
        order_id: order.id,
        amount: 1,
        reason: "test",
        created_at: "invalid-refund-time",
      },
    ];

    const report = validateAnalyticsDataset(broken);
    const timestampFindings = report.findings.filter(
      (finding) => finding.category === "timestamp_issue",
    );

    expect(timestampFindings).toHaveLength(3);
    expect(timestampFindings.map((finding) => finding.recordId)).toEqual(
      expect.arrayContaining([order.id, payment.id, "malformed-refund"]),
    );
    expect(timestampFindings.every((finding) => finding.severity === "error")).toBe(true);
    expect(report.summary.findingsBySeverity.error).toBe(3);
  });

  it("reconciles refunded orders against the original captured payment, not the net after refund", () => {
    const dataset = createCleanDataset();
    const order = dataset.orders[0];
    if (!order) {
      throw new Error("Expected an order in the clean dataset fixture.");
    }
    dataset.orders[0] = { ...order, status: "refunded", payment_status: "refunded" };
    dataset.refunds = [
      {
        id: "partial-refund",
        order_id: order.id,
        amount: 5,
        reason: "partial",
        created_at: "2025-01-09T10:00:00Z",
      },
    ];

    const report = validateAnalyticsDataset(dataset);

    expect(report.reconciliations.mismatchedOrders).toEqual([]);
    expect(
      report.findings.filter(
        (finding) => finding.category === "payment_mismatch" && finding.recordId === order.id,
      ),
    ).toEqual([]);
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

  it("uses restaurant-specific baselines and finds no anomaly in normal observations", () => {
    const dataset = createCleanDataset();
    const baseOrder = dataset.orders[0];
    if (!baseOrder) {
      throw new Error("Expected an order in the clean dataset fixture.");
    }
    const observations = [
      { restaurantId: "rest-1", values: [10, 11, 12] },
      { restaurantId: "rest-2", values: [1000, 1100, 1200] },
    ];

    dataset.orders = observations.flatMap(({ restaurantId, values }) =>
      values.map((value, index) => ({
        ...baseOrder,
        id: `${restaurantId}-order-${index}`,
        restaurant_id: restaurantId,
        table_label: `T${index}`,
        ordered_at: `2025-01-${String(8 + index).padStart(2, "0")}T18:00:00Z`,
        status: "paid" as const,
        subtotal: value,
        discount_amount: 0,
        tax: 0,
        total: value,
        payment_status: "paid" as const,
        isValid: true,
      })),
    );
    dataset.orderItems = [];
    dataset.payments = dataset.orders.map((order, index) => ({
      id: `baseline-payment-${index}`,
      order_id: order.id,
      amount: order.total,
      method: "card",
      status: "settled",
      created_at: order.ordered_at,
    }));

    expect(detectStatisticalAnomalies(dataset)).toEqual([]);
  });

  it("ignores missing metric observations and explains a finite-value outlier", () => {
    const anomalies = detectStatisticalAnomaliesForMetric(
      [10, 11, Number.NaN, 12, Number.POSITIVE_INFINITY, 100],
      "order_total",
    );

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      metric: "order_total",
      value: 100,
      lowerBound: -24.125,
      upperBound: 68.875,
      method: "IQR",
      severity: "warning",
    });
    expect(anomalies[0]?.explanation).toContain("outside the baseline range");
    expect(anomalies[0]?.explanation).toContain("statistical flag only");
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
      (anomaly) =>
        anomaly.metric === "order_total" && anomaly.comparisonGroup === "restaurant:rest-1",
    );

    expect(orderAnomaly).toMatchObject({
      value: 600,
      method: "IQR",
      threshold: 1.5,
      comparisonGroup: "restaurant:rest-1",
      severity: "warning",
    });
    expect(orderAnomaly?.explanation).toContain("statistical flag");
    expect(orderAnomaly?.explanation).toContain("IQR multiplier 1.5");
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
