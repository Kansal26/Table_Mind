import { describe, expect, it } from "vitest";

import { syntheticDataset } from "./synthetic-dataset";
import { createAnalyticsReport } from "./analytics-report";

describe("analytics report", () => {
  it("includes deterministic record counts, validation summaries, reconciliations, and trends", () => {
    const first = createAnalyticsReport(syntheticDataset);
    const second = createAnalyticsReport(syntheticDataset);

    expect(first).toEqual(second);
    expect(first.recordsAnalyzed.total).toBe(
      Object.values(first.recordsAnalyzed.byType).reduce((total, count) => total + count, 0),
    );
    expect(first.validation.findingCount).toBe(first.validation.findings.length);
    expect(first.validation.errorFindingCount).toBe(
      first.validation.findingsBySeverity.error + first.validation.findingsBySeverity.critical,
    );
    expect(first.statisticalAnomalies.count).toBe(first.statisticalAnomalies.anomalies.length);
    expect(first.reconciliations.orderTotals.evaluated).toBe(syntheticDataset.orders.length);
    expect(first.reconciliations.payments.evaluated).toBe(
      syntheticDataset.orders.filter(
        (order) => order.status === "paid" || order.status === "refunded",
      ).length,
    );
    expect(first.summaries.byRestaurant).toHaveLength(syntheticDataset.restaurants.length);
    expect(first.summaries.byDay.length).toBeGreaterThan(0);
    expect(first.assumptionsAndLimitations.length).toBeGreaterThan(0);
    expect(first.importantFindings.some((finding) => finding.expectedBaseline)).toBe(true);
  });

  it("reports distinct records separately from finding counts by category", () => {
    const report = createAnalyticsReport(syntheticDataset);
    const lineTotalFindings = report.validation.findingsByCategory["invalid_total"];
    const knownInvalidFindings = report.validation.findingsByCategory["known_invalid_fixture"];

    expect(lineTotalFindings).toEqual({ findingCount: 8, distinctRecordCount: 8 });
    expect(knownInvalidFindings).toEqual({ findingCount: 4, distinctRecordCount: 4 });
    expect(report.validation.recordsWithValidationErrors).toBe(2);
    expect(report.validation.recordsWithWarnings).toBe(10);
    expect(report.validation.expectedBaselineFindingCount).toBeGreaterThan(0);
    expect(report.validation.unexpectedFindingCount).toBe(
      report.validation.findings.filter((finding) => !finding.isExpectedBaseline).length,
    );
  });
});
