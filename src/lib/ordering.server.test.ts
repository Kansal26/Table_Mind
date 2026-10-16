import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSupabase, mockWalletBalance } = vi.hoisted(() => ({
  mockSupabase: {
    from: vi.fn(),
    auth: { getUser: vi.fn() },
    rpc: vi.fn(),
  },
  mockWalletBalance: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabase,
}));

vi.mock("./wallet.server", () => ({
  getWalletBalance: mockWalletBalance,
}));

vi.mock("./coupons.server", () => ({
  evaluateCoupons: vi.fn(),
}));

import { evaluateCoupons } from "./coupons.server";
import { normalizeQrToken, recalcTotals } from "./ordering.server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizeQrToken", () => {
  it("normalizes encoded, trimmed, and whitespace-padded values", () => {
    expect(normalizeQrToken("  %7Babc%7D  ")).toBe("{abc}");
    expect(normalizeQrToken("  sample-table  ")).toBe("sample-table");
    expect(normalizeQrToken("")).toBeNull();
    expect(normalizeQrToken("a".repeat(201))).toBeNull();
  });

  it("keeps malformed percent-encoding safe and avoids empty tokens", () => {
    expect(normalizeQrToken("%E0%A4%A")).toBe("%E0%A4%A");
    expect(normalizeQrToken("   ")).toBeNull();
  });
});

describe("recalcTotals", () => {
  it("returns zero totals for empty carts", async () => {
    vi.mocked(evaluateCoupons).mockResolvedValue([]);

    let updatePayload: Record<string, unknown> | null = null;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "order_items") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }

      if (table === "order_discounts") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
          insert: async () => ({ data: null, error: null }),
        };
      }

      if (table === "orders") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  user_id: null,
                  points_redeemed: 0,
                  sessions: { tables: { restaurant_id: "restaurant-1" } },
                },
                error: null,
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              updatePayload = payload;
              return { error: null };
            },
          }),
        };
      }

      if (table === "restaurants") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { tax_rate: 0.05 }, error: null }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    await recalcTotals("order-empty");

    expect(updatePayload).toMatchObject({
      subtotal: 0,
      tax: 0,
      discount_amount: 0,
      credits_applied: 0,
      total: 0,
      points_redeemed: 0,
    });
  });

  it("applies coupon discounts, loyalty credits, and tax to the final total", async () => {
    const lines = [
      {
        id: "line-1",
        qty: 2,
        menu_item: { id: "item-1", name: "Butter Naan", price: 120 },
      },
      {
        id: "line-2",
        qty: 1,
        menu_item: { id: "item-2", name: "Paneer Tikka", price: 240 },
      },
    ];

    vi.mocked(evaluateCoupons).mockResolvedValue([
      {
        id: "coupon-1",
        restaurant_id: "restaurant-1",
        name: "Lunch combo",
        description: "10% off",
        rule_json: { type: "min_spend", amount: 300, discount_pct: 10 },
        valid_from: null,
        valid_to: null,
        active: true,
        calculated_discount: 48,
      },
    ]);

    mockWalletBalance.mockResolvedValue(120);

    let updatePayload: Record<string, unknown> | null = null;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "order_items") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: lines.map((line) => ({
                  id: line.id,
                  qty: line.qty,
                  menu_items: { id: line.menu_item.id, price: line.menu_item.price },
                })),
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "order_discounts") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
          insert: async () => ({ data: null, error: null }),
        };
      }

      if (table === "orders") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  user_id: "user-1",
                  points_redeemed: 30,
                  sessions: { tables: { restaurant_id: "restaurant-1" } },
                },
                error: null,
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              updatePayload = payload;
              return { error: null };
            },
          }),
        };
      }

      if (table === "loyalty_settings") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  points_per_rupee: 2,
                  min_order_value_to_redeem: 200,
                  max_points_redeemable_per_order: 100,
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "restaurants") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { tax_rate: 0.085 }, error: null }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    await recalcTotals("order-1");

    expect(vi.mocked(evaluateCoupons)).toHaveBeenCalledWith("order-1", expect.any(Array), 480);
    expect(mockWalletBalance).toHaveBeenCalledWith("user-1", "restaurant-1");
    expect(updatePayload).toMatchObject({
      subtotal: 480,
      discount_amount: 48,
      credits_applied: 60,
      points_redeemed: 30,
      total: 403.62,
      tax: 31.62,
    });
  });
});
