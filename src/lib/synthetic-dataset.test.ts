import { describe, expect, it } from "vitest";

import { createSyntheticDataset } from "./synthetic-dataset";

describe("synthetic dataset", () => {
  it("is deterministic and sized for meaningful QA work", () => {
    const dataset = createSyntheticDataset();

    expect(dataset.metadata.seed).toBe(20250120);
    expect(dataset.restaurants).toHaveLength(3);
    expect(dataset.menuItems).toHaveLength(8);
    expect(dataset.orders).toHaveLength(8);
    expect(dataset.invalidRows).toHaveLength(4);
    expect(dataset.metadata.localOnly).toBe(true);
  });

  it("keeps normal and corrupt records separate and explicit", () => {
    const dataset = createSyntheticDataset();

    expect(dataset.orders.every((order) => order.isValid === true)).toBe(true);
    expect(dataset.invalidRows.every((row) => row.isValid === false)).toBe(true);
    expect(dataset.invalidRows.map((row) => row.invalidReason)).toEqual(
      expect.arrayContaining([
        "negative subtotal",
        "tax exceeds subtotal",
        "refund without payment",
        "future-dated order",
      ]),
    );
  });

  it("matches the independently specified operational totals", () => {
    const dataset = createSyntheticDataset();

    expect(dataset.summary.validOrderCount).toBe(8);
    expect(dataset.summary.invalidOrderCount).toBe(4);
    expect(dataset.summary.paidOrderCount).toBe(5);
    expect(dataset.summary.cancelledOrderCount).toBe(1);
    expect(dataset.summary.totalGrossRevenue).toBeCloseTo(760.98, 2);
    expect(dataset.summary.totalRefunds).toBeCloseTo(82.7, 2);
    expect(dataset.orders.filter((order) => order.status === "refunded")).toHaveLength(2);
  });
});
