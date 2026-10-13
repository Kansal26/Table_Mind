import type {
  SyntheticDataset,
  OrderRecord,
  OrderItemRecord,
  PaymentRecord,
  RefundRecord,
} from "./synthetic-dataset";

export type Severity = "info" | "warning" | "error" | "critical";

export type ValidationFinding = {
  severity: Severity;
  category:
    | "duplicate_id"
    | "missing_value"
    | "missing_required_field"
    | "broken_reference"
    | "invalid_data_type"
    | "invalid_total"
    | "payment_mismatch"
    | "refund_mismatch"
    | "invalid_status"
    | "unsupported_status"
    | "timestamp_issue"
    | "cross_restaurant"
    | "ambiguous_rule"
    | "not_evaluable"
    | "known_invalid_fixture";
  recordType:
    | "restaurant"
    | "menu_item"
    | "order"
    | "order_item"
    | "payment"
    | "refund"
    | "invalid_row"
    | "dataset";
  recordId?: string;
  recordIdentifier?: string;
  ruleId?: string;
  rule?: string;
  message: string;
  expected?: string | number | boolean | null;
  expectedCondition?: string | number | boolean | null;
  actual?: string | number | boolean | null;
  observedValue?: unknown;
  recommendation?: string;
  evaluationStatus?: "evaluated" | "not_evaluated" | "ambiguous";
  isExpectedBaseline?: boolean;
};

export type DataQualityFinding = ValidationFinding;

export type AnomalyThresholds = {
  minSamples: number;
  iqrMultiplier: number;
  zScoreThreshold: number;
  dailyRevenueZScoreThreshold: number;
};

export type StatisticalAnomaly = {
  metric: string;
  recordId?: string | undefined;
  restaurantId?: string | undefined;
  comparisonGroup?: string;
  value: number;
  baselineMedian: number;
  baselineMean: number;
  lowerBound?: number;
  upperBound?: number;
  zScore?: number;
  threshold?: number;
  method?: "IQR" | "z-score" | "rate-delta";
  severity: "info" | "warning" | "error";
  explanation: string;
};

const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  minSamples: 3,
  iqrMultiplier: 1.5,
  zScoreThreshold: 3,
  dailyRevenueZScoreThreshold: 2.5,
};

export type AnalyticsValidationReport = {
  metadata: {
    seed: number;
    generatedAt: string;
    recordsAnalyzed: number;
  };
  summary: {
    totalRestaurants: number;
    totalOrders: number;
    totalOrderItems: number;
    totalPayments: number;
    totalRefunds: number;
    findingsBySeverity: Record<Severity, number>;
    findingsByCategory: Record<string, number>;
  };
  findings: ValidationFinding[];
  anomalies: StatisticalAnomaly[];
  reconciliations: {
    totalGrossRevenue: number;
    totalPayments: number;
    totalRefunds: number;
    paidOrders: number;
    refundedOrders: number;
    mismatchedOrders: string[];
  };
};

const VALID_ORDER_STATUSES = new Set(["cart", "paid", "cancelled", "refunded"]);
const VALID_PAYMENT_STATUSES = new Set(["settled", "pending", "failed"]);
const VALID_PAYMENT_TYPES = new Set(["card", "upi", "cash"]);

function roundCurrency(amount: number) {
  return Number(amount.toFixed(2));
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeFinding(finding: ValidationFinding): ValidationFinding {
  const expectedCondition =
    finding.expectedCondition ??
    (typeof finding.expected === "undefined" ? null : finding.expected);
  const observedValue = finding.observedValue ?? finding.actual ?? null;
  const recordIdentifier = finding.recordIdentifier ?? finding.recordId ?? "unknown";
  const recommendation =
    finding.recommendation ??
    "Review the source record and compare it against the expected invariant for the relevant business rule.";

  return {
    ...finding,
    ruleId: finding.ruleId ?? finding.rule ?? finding.category,
    recordIdentifier,
    recordId: finding.recordId ?? recordIdentifier,
    expectedCondition,
    observedValue,
    recommendation,
    evaluationStatus: finding.evaluationStatus ?? "evaluated",
  };
}

function calculateExpectedTotal(order: OrderRecord) {
  return roundCurrency(order.subtotal - order.discount_amount + order.tax);
}

function listDuplicates<T extends { id: string }>(items: T[]) {
  const seen = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      duplicates.add(item.id);
    } else {
      seen.set(item.id, 1);
    }
  }
  return Array.from(duplicates);
}

function getSortedValues(values: number[]) {
  return [...values].sort((a, b) => a - b);
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const firstValue = sorted[0]!;
  if (sorted.length === 1) return firstValue;

  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  const lowerValue = sorted[lower] ?? firstValue;
  const upperValue = sorted[upper] ?? sorted[sorted.length - 1]!;
  return lowerValue * (1 - weight) + upperValue * weight;
}

export function detectStatisticalAnomaliesForMetric(
  values: number[],
  metric: string,
  restaurantId?: string,
  recordId?: string,
  thresholds: Partial<AnomalyThresholds> = {},
): StatisticalAnomaly[] {
  const config = { ...DEFAULT_ANOMALY_THRESHOLDS, ...thresholds };
  const cleanValues = values.filter((value) => Number.isFinite(value));
  if (cleanValues.length < config.minSamples) return [];

  const sorted = getSortedValues(cleanValues);
  const median = percentile(sorted, 0.5);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const lowerQuartile = q1 ?? median;
  const upperQuartile = q3 ?? median;
  const iqr = Math.max(0, upperQuartile - lowerQuartile);
  const mean = cleanValues.reduce((sum, item) => sum + item, 0) / cleanValues.length;
  const variance =
    cleanValues.reduce((sum, item) => sum + (item - mean) ** 2, 0) / cleanValues.length;
  const stdDev = Math.sqrt(variance);

  const lowerBound = lowerQuartile - config.iqrMultiplier * iqr;
  const upperBound = upperQuartile + config.iqrMultiplier * iqr;
  const anomalies: StatisticalAnomaly[] = [];

  if (!Number.isFinite(lowerBound) || !Number.isFinite(upperBound)) {
    return [];
  }

  for (const value of cleanValues) {
    if (value >= lowerBound && value <= upperBound) continue;

    let zScore: number | undefined;
    if (stdDev > 0) {
      zScore = Math.abs((value - mean) / stdDev);
    }

    const explanation =
      stdDev > 0 && zScore !== undefined
        ? `Value ${value} is outside the baseline range [${lowerBound.toFixed(2)}, ${upperBound.toFixed(2)}] (IQR multiplier ${config.iqrMultiplier}). This is a statistical flag only, not a confirmed defect; it is ${zScore.toFixed(2)} standard deviations from the mean.`
        : `Value ${value} is outside the baseline range [${lowerBound.toFixed(2)}, ${upperBound.toFixed(2)}] using the IQR rule. This is a statistical flag only, not a confirmed defect.`;

    const anomaly: StatisticalAnomaly = {
      metric,
      recordId: recordId ?? undefined,
      restaurantId,
      comparisonGroup: restaurantId ? `restaurant:${restaurantId}` : "overall",
      value,
      baselineMedian: median,
      baselineMean: mean,
      lowerBound,
      upperBound,
      zScore: zScore ?? 0,
      threshold: config.iqrMultiplier,
      method: "IQR",
      severity: stdDev > 0 && zScore !== undefined && zScore > config.zScoreThreshold ? "error" : "warning",
      explanation,
    };

    anomalies.push(anomaly);
  }

  return anomalies;
}

function detectRestaurantDailyRevenueAnomalies(dataset: SyntheticDataset, thresholds: AnomalyThresholds) {
  const validOrders = dataset.orders.filter((order) => order.isValid !== false);
  const dailyRevenueByRestaurant = new Map<string, { date: string; total: number }[]>();

  for (const order of validOrders) {
    const orderDate = order.ordered_at.slice(0, 10);
    const list = dailyRevenueByRestaurant.get(order.restaurant_id) ?? [];
    list.push({ date: orderDate, total: order.total });
    dailyRevenueByRestaurant.set(order.restaurant_id, list);
  }

  const anomalies: StatisticalAnomaly[] = [];

  for (const [restaurantId, records] of dailyRevenueByRestaurant.entries()) {
    const values = records.map((entry) => entry.total);
    if (values.length < thresholds.minSamples) continue;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) continue;

    for (const record of records) {
      const zScore = Math.abs((record.total - mean) / stdDev);
      if (zScore <= thresholds.dailyRevenueZScoreThreshold) continue;

      anomalies.push({
        metric: "daily_revenue_change",
        restaurantId,
        comparisonGroup: `restaurant:${restaurantId}`,
        value: record.total,
        baselineMedian: median(values),
        baselineMean: mean,
        zScore,
        threshold: thresholds.dailyRevenueZScoreThreshold,
        method: "z-score",
        severity: zScore > thresholds.zScoreThreshold ? "error" : "warning",
        explanation: `Daily revenue for ${record.date} in ${restaurantId} is ${zScore.toFixed(2)} standard deviations from the restaurant mean; this is a statistical flag and should be checked against context before concluding a defect.`,
      });
    }
  }

  return anomalies;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1] ?? sorted[0]!;
    const right = sorted[mid] ?? sorted[sorted.length - 1]!;
    return (left + right) / 2;
  }
  return sorted[mid] ?? sorted[0]!;
}

function detectPaymentGapAnomalies(dataset: SyntheticDataset, thresholds: AnomalyThresholds) {
  const values: { orderId: string; restaurantId: string; gap: number }[] = [];
  for (const order of dataset.orders.filter((item) => item.isValid !== false)) {
    const paymentTotal = dataset.payments
      .filter((payment) => payment.order_id === order.id)
      .reduce((sum, payment) => sum + payment.amount, 0);
    const gap = Math.abs(paymentTotal - order.total);
    if (gap > 0) values.push({ orderId: order.id, restaurantId: order.restaurant_id, gap });
  }

  if (values.length < thresholds.minSamples) return [];
  const gaps = values.map((entry) => entry.gap);
  const result = detectStatisticalAnomaliesForMetric(gaps, "payment_gap", undefined, undefined, thresholds);
  return result.map((anomaly) => {
    const match = values.find((entry) => entry.gap === anomaly.value);
    return {
      ...anomaly,
      metric: "payment_gap",
      recordId: match?.orderId,
      restaurantId: match?.restaurantId,
      comparisonGroup: match ? `restaurant:${match.restaurantId}` : "overall",
      explanation: `Payment variance for order ${match?.orderId ?? "unknown"} is ${anomaly.value.toFixed(2)} versus the baseline; this is a statistical flag, not a confirmed accounting defect.`,
    };
  });
}

export function detectExplainableAnomalies(
  dataset: SyntheticDataset,
  thresholds: Partial<AnomalyThresholds> = {},
): StatisticalAnomaly[] {
  const config = { ...DEFAULT_ANOMALY_THRESHOLDS, ...thresholds };
  const validOrders = dataset.orders.filter((order) => order.isValid !== false);
  const anomalies: StatisticalAnomaly[] = [];

  const orderTotalsByRestaurant = new Map<string, number[]>();
  for (const order of validOrders) {
    const list = orderTotalsByRestaurant.get(order.restaurant_id) ?? [];
    list.push(order.total);
    orderTotalsByRestaurant.set(order.restaurant_id, list);
  }

  for (const [restaurantId, values] of orderTotalsByRestaurant.entries()) {
    anomalies.push(...detectStatisticalAnomaliesForMetric(values, "order_total", restaurantId, undefined, config));
  }

  const quantityValues: number[] = [];
  for (const order of validOrders) {
    const orderQty = dataset.orderItems
      .filter((item) => item.order_id === order.id)
      .reduce((sum, item) => sum + item.qty, 0);
    quantityValues.push(orderQty);
  }
  anomalies.push(...detectStatisticalAnomaliesForMetric(quantityValues, "order_quantity", undefined, undefined, config));

  const refundValues = dataset.refunds.map((refund) => refund.amount);
  if (refundValues.length >= config.minSamples) {
    anomalies.push(...detectStatisticalAnomaliesForMetric(refundValues, "refund_amount", undefined, undefined, config));
  }

  const cancellationValues = validOrders.map((order) => (order.status === "cancelled" ? 1 : 0));
  if (cancellationValues.length >= config.minSamples) {
    anomalies.push(...detectStatisticalAnomaliesForMetric(cancellationValues, "cancellation_flag", undefined, undefined, config));
  }

  anomalies.push(...detectRestaurantDailyRevenueAnomalies(dataset, config));
  anomalies.push(...detectPaymentGapAnomalies(dataset, config));

  return anomalies.filter((anomaly) => Number.isFinite(anomaly.value));
}

export function detectStatisticalAnomalies(dataset: SyntheticDataset, thresholds: Partial<AnomalyThresholds> = {}) {
  return detectExplainableAnomalies(dataset, thresholds);
}

export function validateAnalyticsDataset(dataset: SyntheticDataset): AnalyticsValidationReport {
  const findings: ValidationFinding[] = [];

  const orders = dataset.orders;
  const menuItems = dataset.menuItems;
  const orderItems = dataset.orderItems;
  const payments = dataset.payments;
  const refunds = dataset.refunds;

  const duplicatedOrderIds = listDuplicates(orders);
  const duplicatedMenuItemIds = listDuplicates(menuItems);
  const duplicatedPaymentIds = listDuplicates(payments);
  const duplicatedRefundIds = listDuplicates(refunds);

  for (const id of duplicatedOrderIds) {
    findings.push({
      severity: "critical",
      category: "duplicate_id",
      recordType: "order",
      recordId: id,
      message: "Duplicate order identifier found in the fixture.",
      expected: "unique order id",
      actual: id,
    });
  }

  for (const id of duplicatedMenuItemIds) {
    findings.push({
      severity: "critical",
      category: "duplicate_id",
      recordType: "menu_item",
      recordId: id,
      message: "Duplicate menu item identifier found in the fixture.",
      expected: "unique menu item id",
      actual: id,
    });
  }

  for (const id of duplicatedPaymentIds) {
    findings.push({
      severity: "critical",
      category: "duplicate_id",
      recordType: "payment",
      recordId: id,
      message: "Duplicate payment identifier found in the fixture.",
      expected: "unique payment id",
      actual: id,
    });
  }

  for (const id of duplicatedRefundIds) {
    findings.push({
      severity: "critical",
      category: "duplicate_id",
      recordType: "refund",
      recordId: id,
      message: "Duplicate refund identifier found in the fixture.",
      expected: "unique refund id",
      actual: id,
    });
  }

  for (const restaurant of dataset.restaurants) {
    if (!restaurant.id || !restaurant.name) {
      findings.push({
        severity: "error",
        category: "missing_value",
        recordType: "restaurant",
        recordId: restaurant.id || "unknown-restaurant",
        message: "Restaurant record is missing required identity or name information.",
        expected: "non-empty id and name",
        actual: JSON.stringify({ id: restaurant.id, name: restaurant.name }),
      });
    }
  }

  const restaurantIds = new Set(dataset.restaurants.map((restaurant) => restaurant.id));

  for (const order of orders) {
    if (!order.id || !order.restaurant_id) {
      findings.push({
        severity: "error",
        category: "missing_value",
        recordType: "order",
        recordId: order.id || "unknown-order",
        message: "Order is missing a required identifier or restaurant reference.",
        expected: "order.id and order.restaurant_id",
        actual: JSON.stringify({ id: order.id, restaurant_id: order.restaurant_id }),
      });
      continue;
    }

    if (!restaurantIds.has(order.restaurant_id)) {
      findings.push({
        severity: "error",
        category: "broken_reference",
        recordType: "order",
        recordId: order.id,
        message: "Order references a restaurant that is not present in the fixture.",
        expected: `restaurant id present in dataset: ${Array.from(restaurantIds).join(", ") || "none"}`,
        actual: order.restaurant_id,
      });
    }

    if (!VALID_ORDER_STATUSES.has(order.status)) {
      findings.push({
        severity: "error",
        category: "invalid_status",
        recordType: "order",
        recordId: order.id,
        message: "Order status is outside the schema-supported set.",
        expected: Array.from(VALID_ORDER_STATUSES).join(", "),
        actual: order.status,
      });
    }

    const orderedAt = parseDate(order.ordered_at);
    const validationMoment = parseDate(dataset.metadata.generatedAt);
    if (!orderedAt) {
      findings.push({
        severity: "error",
        category: "timestamp_issue",
        recordType: "order",
        recordId: order.id,
        message: "Order timestamp is not valid ISO-8601.",
        expected: "valid ISO-8601 timestamp",
        actual: order.ordered_at,
      });
    } else if (validationMoment && orderedAt > validationMoment) {
      findings.push({
        severity: "warning",
        category: "timestamp_issue",
        recordType: "order",
        recordId: order.id,
        message: "Order timestamp is in the future relative to the fixture generation date.",
        expected: `ordered_at <= ${dataset.metadata.generatedAt}`,
        actual: order.ordered_at,
      });
    }

    if (order.subtotal < 0 || order.discount_amount < 0 || order.tax < 0 || order.total < 0) {
      findings.push({
        severity: "error",
        category: "invalid_total",
        recordType: "order",
        recordId: order.id,
        message: "Order totals contain negative values.",
        expected: "non-negative subtotal, discount, tax, and total",
        actual: JSON.stringify({
          subtotal: order.subtotal,
          discount_amount: order.discount_amount,
          tax: order.tax,
          total: order.total,
        }),
      });
    }

    const expectedTotal = calculateExpectedTotal(order);
    if (Math.abs(expectedTotal - order.total) > 0.01) {
      findings.push({
        severity: "error",
        category: "invalid_total",
        recordType: "order",
        recordId: order.id,
        message:
          "Order total does not match the independently expected total formula subtotal - discount + tax.",
        expected: expectedTotal,
        actual: order.total,
      });
    }

    const orderItemLines = orderItems.filter((item) => item.order_id === order.id);
    const expectedLineTotal = roundCurrency(
      orderItemLines.reduce((sum, line) => sum + line.line_total, 0),
    );
    if (
      orderItemLines.length > 0 &&
      Math.abs(expectedLineTotal - order.subtotal) > 0.01 &&
      order.isValid !== false
    ) {
      findings.push({
        severity: "warning",
        category: "invalid_total",
        recordType: "order",
        recordId: order.id,
        message:
          "Line item totals do not reconcile to the order subtotal; this indicates a potential data-quality issue or missing adjustments.",
        expected: expectedLineTotal,
        actual: order.subtotal,
      });
    }

    const paymentTotal = payments
      .filter((payment) => payment.order_id === order.id)
      .reduce((sum, payment) => sum + payment.amount, 0);
    if (order.status === "paid" || order.status === "refunded") {
      if (paymentTotal <= 0) {
        findings.push({
          severity: "error",
          category: "payment_mismatch",
          recordType: "order",
          recordId: order.id,
          message: "A paid or refunded order is missing a corresponding payment record.",
          expected: `payment amount > 0 for ${order.status}`,
          actual: paymentTotal,
        });
      }
      if (Math.abs(paymentTotal - order.total) > 0.01 && order.status === "paid") {
        findings.push({
          severity: "warning",
          category: "payment_mismatch",
          recordType: "order",
          recordId: order.id,
          message: "Paid order total does not match the settled payment total.",
          expected: order.total,
          actual: paymentTotal,
        });
      }
    }

    const refundTotal = refunds
      .filter((refund) => refund.order_id === order.id)
      .reduce((sum, refund) => sum + refund.amount, 0);
    if (order.status === "refunded") {
      if (refundTotal <= 0) {
        findings.push({
          severity: "warning",
          category: "refund_mismatch",
          recordType: "order",
          recordId: order.id,
          message: "Refunded order does not have an associated refund record.",
          expected: "at least one non-zero refund",
          actual: refundTotal,
        });
      }
      if (refundTotal > paymentTotal + 0.01) {
        findings.push({
          severity: "error",
          category: "refund_mismatch",
          recordType: "order",
          recordId: order.id,
          message: "Refund amount exceeds the total payment captured for the order.",
          expected: paymentTotal,
          actual: refundTotal,
        });
      }
    }
  }

  for (const item of orderItems) {
    if (!item.id || !item.order_id || !item.menu_item_id) {
      findings.push({
        severity: "error",
        category: "missing_value",
        recordType: "order_item",
        recordId: item.id || "unknown-order-item",
        message: "Order item is missing a required identifier or reference.",
        expected: "order_item.id, order_id, and menu_item_id",
        actual: JSON.stringify({
          id: item.id,
          order_id: item.order_id,
          menu_item_id: item.menu_item_id,
        }),
      });
      continue;
    }

    const orderExists = orders.some((order) => order.id === item.order_id);
    if (!orderExists) {
      findings.push({
        severity: "error",
        category: "broken_reference",
        recordType: "order_item",
        recordId: item.id,
        message: "Order item points to a missing order.",
        expected: "item.order_id to exist in orders",
        actual: item.order_id,
      });
    }

    const menuItem = menuItems.find((candidate) => candidate.id === item.menu_item_id);
    if (!menuItem) {
      findings.push({
        severity: "error",
        category: "broken_reference",
        recordType: "order_item",
        recordId: item.id,
        message: "Order item references a menu item that is not present in the fixture.",
        expected: "menu_item_id to exist in menuItems",
        actual: item.menu_item_id,
      });
      continue;
    }

    const parentOrder = orders.find((order) => order.id === item.order_id);
    if (parentOrder && menuItem.restaurant_id !== parentOrder.restaurant_id) {
      findings.push({
        severity: "error",
        category: "cross_restaurant",
        recordType: "order_item",
        recordId: item.id,
        message: "Order item belongs to a different restaurant than the order itself.",
        expected: parentOrder.restaurant_id,
        actual: menuItem.restaurant_id,
      });
    }

    if (item.qty <= 0 || item.unit_price < 0 || item.line_total < 0) {
      findings.push({
        severity: "error",
        category: "invalid_total",
        recordType: "order_item",
        recordId: item.id,
        message: "Order item contains invalid quantity or monetary values.",
        expected: "qty > 0, unit_price >= 0, line_total >= 0",
        actual: JSON.stringify({
          qty: item.qty,
          unit_price: item.unit_price,
          line_total: item.line_total,
        }),
      });
    }

    if (Math.abs(item.unit_price * item.qty - item.line_total) > 0.01) {
      findings.push({
        severity: "warning",
        category: "invalid_total",
        recordType: "order_item",
        recordId: item.id,
        message: "Order item line total does not equal quantity × unit price.",
        expected: item.unit_price * item.qty,
        actual: item.line_total,
      });
    }
  }

  for (const payment of payments) {
    if (!payment.id || !payment.order_id) {
      findings.push({
        severity: "error",
        category: "missing_value",
        recordType: "payment",
        recordId: payment.id || "unknown-payment",
        message: "Payment record is missing a required identifier or order reference.",
        expected: "payment.id and payment.order_id",
        actual: JSON.stringify({ id: payment.id, order_id: payment.order_id }),
      });
      continue;
    }

    if (!VALID_PAYMENT_TYPES.has(payment.method)) {
      findings.push({
        severity: "error",
        category: "invalid_status",
        recordType: "payment",
        recordId: payment.id,
        message: "Payment method is outside the supported values.",
        expected: Array.from(VALID_PAYMENT_TYPES).join(", "),
        actual: payment.method,
      });
    }

    if (!VALID_PAYMENT_STATUSES.has(payment.status)) {
      findings.push({
        severity: "error",
        category: "invalid_status",
        recordType: "payment",
        recordId: payment.id,
        message: "Payment status is outside the supported values.",
        expected: Array.from(VALID_PAYMENT_STATUSES).join(", "),
        actual: payment.status,
      });
    }

    const parentOrder = orders.find((order) => order.id === payment.order_id);
    if (!parentOrder) {
      findings.push({
        severity: "error",
        category: "broken_reference",
        recordType: "payment",
        recordId: payment.id,
        message: "Payment is attached to an order that does not exist.",
        expected: "payment.order_id to exist in orders",
        actual: payment.order_id,
      });
      continue;
    }

    const paymentDate = parseDate(payment.created_at);
    const orderDate = parseDate(parentOrder.ordered_at);
    if (paymentDate && orderDate && paymentDate < orderDate) {
      findings.push({
        severity: "warning",
        category: "timestamp_issue",
        recordType: "payment",
        recordId: payment.id,
        message: "Payment timestamp occurs before the order was created.",
        expected: `payment.created_at >= ${parentOrder.ordered_at}`,
        actual: payment.created_at,
      });
    }

    if (payment.amount < 0) {
      findings.push({
        severity: "error",
        category: "payment_mismatch",
        recordType: "payment",
        recordId: payment.id,
        message: "Payment amount is negative.",
        expected: "amount >= 0",
        actual: payment.amount,
      });
    }
  }

  for (const refund of refunds) {
    if (!refund.id || !refund.order_id) {
      findings.push({
        severity: "error",
        category: "missing_value",
        recordType: "refund",
        recordId: refund.id || "unknown-refund",
        message: "Refund record is missing a required identifier or order reference.",
        expected: "refund.id and refund.order_id",
        actual: JSON.stringify({ id: refund.id, order_id: refund.order_id }),
      });
      continue;
    }

    const parentOrder = orders.find((order) => order.id === refund.order_id);
    if (!parentOrder) {
      findings.push({
        severity: "error",
        category: "broken_reference",
        recordType: "refund",
        recordId: refund.id,
        message: "Refund is attached to an order that does not exist.",
        expected: "refund.order_id to exist in orders",
        actual: refund.order_id,
      });
      continue;
    }

    const paymentTotal = payments
      .filter((payment) => payment.order_id === refund.order_id)
      .reduce((sum, payment) => sum + payment.amount, 0);

    if (refund.amount <= 0) {
      findings.push({
        severity: "error",
        category: "refund_mismatch",
        recordType: "refund",
        recordId: refund.id,
        message: "Refund amount must be positive.",
        expected: "amount > 0",
        actual: refund.amount,
      });
    }

    if (refund.amount > paymentTotal + 0.01) {
      findings.push({
        severity: "error",
        category: "refund_mismatch",
        recordType: "refund",
        recordId: refund.id,
        message: "Refund exceeds the total captured payment for the order.",
        expected: paymentTotal,
        actual: refund.amount,
      });
    }

    const refundDate = parseDate(refund.created_at);
    const orderDate = parseDate(parentOrder.ordered_at);
    if (refundDate && orderDate && refundDate < orderDate) {
      findings.push({
        severity: "warning",
        category: "timestamp_issue",
        recordType: "refund",
        recordId: refund.id,
        message: "Refund timestamp occurs before the order date.",
        expected: `refund.created_at >= ${parentOrder.ordered_at}`,
        actual: refund.created_at,
      });
    }
  }

  for (const invalidRow of dataset.invalidRows) {
    findings.push({
      severity:
        invalidRow.invalidReason === "negative subtotal" ||
        invalidRow.invalidReason === "tax exceeds subtotal"
          ? "error"
          : "warning",
      category: "known_invalid_fixture",
      recordType:
        invalidRow.table === "orders"
          ? "order"
          : invalidRow.table === "payments"
            ? "payment"
            : "refund",
      recordId: invalidRow.id,
      message: `Known invalid fixture for validation tests: ${invalidRow.invalidReason}.`,
      expected: "validator should catch this fixture as invalid",
      actual: invalidRow.invalidReason,
      isExpectedBaseline: true,
    });
  }

  const findingsBySeverity: Record<Severity, number> = {
    info: 0,
    warning: 0,
    error: 0,
    critical: 0,
  };
  const findingsByCategory: Record<string, number> = {};

  for (const finding of findings) {
    findingsBySeverity[finding.severity] += 1;
    findingsByCategory[finding.category] = (findingsByCategory[finding.category] ?? 0) + 1;
  }

  const totalGrossRevenue = roundCurrency(
    orders
      .filter((order) => order.status !== "cancelled")
      .reduce((sum, order) => sum + order.total, 0),
  );

  const totalPayments = roundCurrency(payments.reduce((sum, payment) => sum + payment.amount, 0));
  const totalRefunds = roundCurrency(refunds.reduce((sum, refund) => sum + refund.amount, 0));

  const reconciledMismatches = orders.filter((order) => {
    const paymentTotal = payments
      .filter((payment) => payment.order_id === order.id)
      .reduce((sum, payment) => sum + payment.amount, 0);
    const refundTotal = refunds
      .filter((refund) => refund.order_id === order.id)
      .reduce((sum, refund) => sum + refund.amount, 0);
    const expected = order.status === "paid" ? order.total : Math.max(0, order.total - refundTotal);
    return Math.abs(paymentTotal - expected) > 0.01;
  });

  const normalizedFindings = findings.map(normalizeFinding);

  const report: AnalyticsValidationReport = {
    metadata: {
      seed: dataset.metadata.seed,
      generatedAt: dataset.metadata.generatedAt,
      recordsAnalyzed:
        dataset.restaurants.length +
        dataset.orders.length +
        dataset.menuItems.length +
        dataset.orderItems.length +
        dataset.payments.length +
        dataset.refunds.length +
        dataset.invalidRows.length,
    },
    summary: {
      totalRestaurants: dataset.restaurants.length,
      totalOrders: dataset.orders.length,
      totalOrderItems: dataset.orderItems.length,
      totalPayments: dataset.payments.length,
      totalRefunds: dataset.refunds.length,
      findingsBySeverity,
      findingsByCategory,
    },
    findings: normalizedFindings,
    anomalies: detectStatisticalAnomalies(dataset),
    reconciliations: {
      totalGrossRevenue,
      totalPayments,
      totalRefunds,
      paidOrders: orders.filter((order) => order.status === "paid").length,
      refundedOrders: orders.filter((order) => order.status === "refunded").length,
      mismatchedOrders: reconciledMismatches.map((order) => order.id),
    },
  };

  return report;
}

export function validateDataQuality(dataset: SyntheticDataset): AnalyticsValidationReport {
  return validateAnalyticsDataset(dataset);
}

export function validateDataset(dataset: SyntheticDataset): AnalyticsValidationReport {
  return validateAnalyticsDataset(dataset);
}

export function buildValidationReport(dataset: SyntheticDataset): AnalyticsValidationReport {
  return validateAnalyticsDataset(dataset);
}

export function createAnalyticsValidationJson(dataset: SyntheticDataset) {
  return JSON.stringify(validateAnalyticsDataset(dataset), null, 2);
}

export function createExpectedCleanSubset(dataset: SyntheticDataset) {
  const cleanOrderIds = dataset.orders
    .filter((order) => order.isValid && order.status !== "cancelled")
    .map((order) => order.id);

  return {
    ...dataset,
    orders: dataset.orders.filter((order) => cleanOrderIds.includes(order.id)),
    payments: dataset.payments.filter((payment) => cleanOrderIds.includes(payment.order_id)),
    refunds: dataset.refunds.filter((refund) => cleanOrderIds.includes(refund.order_id)),
    invalidRows: [],
  };
}

export function describeAnomaly(anomaly: StatisticalAnomaly) {
  return `${anomaly.metric}: ${anomaly.value} vs median ${anomaly.baselineMedian.toFixed(2)}; ${anomaly.explanation}`;
}

export function sortFindingsBySeverity(findings: ValidationFinding[]) {
  const order = { critical: 4, error: 3, warning: 2, info: 1 };
  return [...findings].sort((left, right) => {
    const diff = order[right.severity] - order[left.severity];
    if (diff !== 0) return diff;
    return (left.recordId ?? "").localeCompare(right.recordId ?? "");
  });
}
