import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Test UUIDs
// ---------------------------------------------------------------------------
const OWNER_1_ID = "00000000-0000-4000-a000-000000000001";
const OWNER_2_ID = "00000000-0000-4000-a000-000000000002";
const USER_1_ID = "00000000-0000-4000-a000-000000000003";
const USER_2_ID = "00000000-0000-4000-a000-000000000004";

const RESTAURANT_1_ID = "10000000-0000-4000-a000-000000000001";
const RESTAURANT_2_ID = "10000000-0000-4000-a000-000000000002";

const TABLE_1_ID = "20000000-0000-4000-a000-000000000001";
const ORDER_1_ID = "30000000-0000-4000-a000-000000000001";
const MENU_ITEM_1_ID = "40000000-0000-4000-a000-000000000001";

const QR_TOKEN = "valid-qr-token-123";

// ---------------------------------------------------------------------------
// Context & Mocks
// ---------------------------------------------------------------------------
let currentContextUserId = USER_1_ID;

const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: {
      getUser: vi.fn(),
    },
  },
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validatorFn = (d: any) => d;
    const builder = {
      middleware: () => builder,
      validator: (v: any) => {
        validatorFn = v;
        return builder;
      },
      handler: (h: any) => {
        return async (args: any) => {
          const validated = validatorFn(args?.data !== undefined ? args.data : args);
          return await h({
            data: validated,
            context: { userId: currentContextUserId },
          });
        };
      },
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabase,
}));

vi.mock("./ordering.server", () => ({
  resolveTableId: vi.fn().mockResolvedValue(TABLE_1_ID),
  requireOwnedOrder: vi.fn(),
  recalcTotals: vi.fn().mockResolvedValue(undefined),
  requireSessionScope: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
}));

vi.mock("./wallet.server", () => ({
  getWalletBalance: vi.fn().mockResolvedValue(500),
  processFeedbackSubmission: vi
    .fn()
    .mockResolvedValue({ creditEarned: 50, pointsValue: 50, isLoyaltyEnabled: true }),
}));

// Helper to construct fluent query mocks
function chainMock(result: any, error: any = null) {
  const chain: any = {};
  for (const method of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "neq",
    "in",
    "gt",
    "lt",
    "gte",
    "lte",
    "order",
    "limit",
    "ilike",
    "not",
    "or",
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue({ data: result, error });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: result, error });
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Phase 3: Cross-Tenant & Cross-User Authorization Boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    mockSupabase.auth.getUser.mockReset();
    currentContextUserId = USER_1_ID;
  });

  // -------------------------------------------------------------------------
  // 1. Kitchen status & Kitchen load ownership
  // -------------------------------------------------------------------------
  describe("Kitchen Operations - Cross-restaurant isolation", () => {
    it("updateKitchenStatusFn: rejects if admin tries to update an order belonging to another restaurant", async () => {
      // Admin is OWNER 2 (owns Restaurant 2)
      mockSupabase.auth.getUser.mockResolvedValue({
        data: { user: { id: OWNER_2_ID } },
        error: null,
      });

      // Order belongs to Restaurant 1
      const orderChain = chainMock({
        id: ORDER_1_ID,
        sessions: { tables: { restaurant_id: RESTAURANT_1_ID } },
      });
      // Restaurant lookup for ownership check
      const restaurantChain = chainMock({
        id: RESTAURANT_1_ID,
        owner_id: OWNER_1_ID, // Owned by Owner 1, NOT Owner 2
      });

      mockSupabase.from
        .mockReturnValueOnce(orderChain) // order session->table lookup
        .mockReturnValueOnce(restaurantChain); // ownership check

      const { updateKitchenStatusFn } = await import("./admin.functions");

      await expect(
        updateKitchenStatusFn({
          data: {
            token: "owner-2-token",
            orderId: ORDER_1_ID,
            status: "preparing",
          },
        }),
      ).rejects.toThrow("403: Forbidden. You do not own this restaurant.");
    });

    it("getKitchenLoadFn: rejects if admin tries to fetch load for a restaurant they don't own", async () => {
      mockSupabase.auth.getUser.mockResolvedValue({
        data: { user: { id: OWNER_2_ID } },
        error: null,
      });

      // Restaurant 1 is owned by Owner 1
      const restaurantChain = chainMock({
        id: RESTAURANT_1_ID,
        owner_id: OWNER_1_ID,
      });
      mockSupabase.from.mockReturnValueOnce(restaurantChain);

      const { getKitchenLoadFn } = await import("./admin.functions");

      await expect(
        getKitchenLoadFn({
          data: {
            token: "owner-2-token",
            restaurantId: RESTAURANT_1_ID,
          },
        }),
      ).rejects.toThrow("403: Forbidden. You do not own this restaurant.");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Menu Item Upsert - Cross-restaurant isolation & ID hijacking prevention
  // -------------------------------------------------------------------------
  describe("Menu Items - Hijack prevention in upsertMenuItemFn", () => {
    it("upsertMenuItemFn: rejects if admin modifies a menu item belonging to another restaurant", async () => {
      // Admin is Owner 2
      mockSupabase.auth.getUser.mockResolvedValue({
        data: { user: { id: OWNER_2_ID } },
        error: null,
      });

      // Existing item belongs to Restaurant 1
      const existingItemChain = chainMock({
        restaurant_id: RESTAURANT_1_ID,
      });
      // Ownership check against Restaurant 1
      const restaurantChain = chainMock({
        id: RESTAURANT_1_ID,
        owner_id: OWNER_1_ID, // Owned by Owner 1!
      });

      mockSupabase.from
        .mockReturnValueOnce(existingItemChain) // lookup existing item
        .mockReturnValueOnce(restaurantChain); // check ownership

      const { upsertMenuItemFn } = await import("./menu.functions");

      await expect(
        upsertMenuItemFn({
          data: {
            token: "owner-2-token",
            id: MENU_ITEM_1_ID,
            restaurant_id: RESTAURANT_2_ID, // Attacker claims it's their restaurant
            name: "Hacked Item",
            description: "Hacked",
            price: 100,
            category: "Mains",
            image_url: null,
            allergens: [],
            dietary_tags: [],
            prep_time_min: null,
            badge: null,
            is_featured: false,
            sort_order: 1,
            available: true,
          },
        }),
      ).rejects.toThrow("403: Forbidden. You do not own this restaurant.");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Claim Order - Cross-user protection
  // -------------------------------------------------------------------------
  describe("Claim Order - Cross-user order hijacking prevention", () => {
    it("claimOrderFn: rejects if order has already been claimed by a different user", async () => {
      const { requireOwnedOrder } = await import("./ordering.server");
      // Order belongs to table, but already claimed by USER 1
      (requireOwnedOrder as any).mockResolvedValue({
        id: ORDER_1_ID,
        status: "cart",
        user_id: USER_1_ID,
      });

      // Caller is USER 2
      currentContextUserId = USER_2_ID;

      const { claimOrderFn } = await import("./account.functions");

      await expect(
        claimOrderFn({
          data: {
            qrToken: QR_TOKEN,
            orderId: ORDER_1_ID,
          },
        }),
      ).rejects.toThrow("This order has already been claimed by another user.");
    });

    it("claimOrderFn: rejects if order is not in cart or paid status", async () => {
      const { requireOwnedOrder } = await import("./ordering.server");
      (requireOwnedOrder as any).mockResolvedValue({
        id: ORDER_1_ID,
        status: "cancelled",
        user_id: null,
      });

      currentContextUserId = USER_1_ID;

      const { claimOrderFn } = await import("./account.functions");

      await expect(
        claimOrderFn({
          data: {
            qrToken: QR_TOKEN,
            orderId: ORDER_1_ID,
          },
        }),
      ).rejects.toThrow("Only orders in cart or paid status can be claimed.");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Loyalty & Points - Cross-user points redemption and feedback protection
  // -------------------------------------------------------------------------
  describe("Wallet & Feedback - Cross-user points protection", () => {
    it("redeemPointsFn: rejects if order belongs to a different user", async () => {
      const { requireOwnedOrder } = await import("./ordering.server");
      // Order belongs to USER 1
      (requireOwnedOrder as any).mockResolvedValue({
        id: ORDER_1_ID,
        status: "cart",
        user_id: USER_1_ID,
      });

      // Caller is USER 2
      currentContextUserId = USER_2_ID;

      const { redeemPointsFn } = await import("./wallet.functions");

      await expect(
        redeemPointsFn({
          data: {
            qrToken: QR_TOKEN,
            orderId: ORDER_1_ID,
            pointsRedeemed: 100,
          },
        }),
      ).rejects.toThrow("Unauthorized: Order does not belong to you");
    });

    it("submitFeedbackFn: rejects if order belongs to a different user", async () => {
      const { requireOwnedOrder } = await import("./ordering.server");
      // Order is paid, but belongs to USER 1
      (requireOwnedOrder as any).mockResolvedValue({
        id: ORDER_1_ID,
        status: "paid",
        user_id: USER_1_ID,
      });

      // Caller is USER 2
      currentContextUserId = USER_2_ID;

      const { submitFeedbackFn } = await import("./wallet.functions");

      await expect(
        submitFeedbackFn({
          data: {
            qrToken: QR_TOKEN,
            orderId: ORDER_1_ID,
            rating: 5,
            comment: "Great food!",
          },
        }),
      ).rejects.toThrow("Unauthorized: Order does not belong to you");
    });

    it("submitFeedbackFn: rejects if order is not paid", async () => {
      const { requireOwnedOrder } = await import("./ordering.server");
      (requireOwnedOrder as any).mockResolvedValue({
        id: ORDER_1_ID,
        status: "cart",
        user_id: USER_1_ID,
      });

      currentContextUserId = USER_1_ID;

      const { submitFeedbackFn } = await import("./wallet.functions");

      await expect(
        submitFeedbackFn({
          data: {
            qrToken: QR_TOKEN,
            orderId: ORDER_1_ID,
            rating: 5,
          },
        }),
      ).rejects.toThrow("Can only feedback on paid orders");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Input bounds: coupons, waiter reason, feedback comment & answers
  // -------------------------------------------------------------------------
  describe("Zod validation boundaries", () => {
    it("createCouponFn: rejects discount_pct < 1 or > 100", async () => {
      const { createCouponFn } = await import("./coupons.functions");

      await expect(
        createCouponFn({
          data: {
            token: "owner-token",
            restaurantId: RESTAURANT_1_ID,
            name: "Invalid Coupon",
            description: "Test",
            rule_json: {
              type: "first_order",
              discount_pct: 150, // Exceeds 100%
            },
          },
        }),
      ).rejects.toThrow();

      await expect(
        createCouponFn({
          data: {
            token: "owner-token",
            restaurantId: RESTAURANT_1_ID,
            name: "Invalid Coupon",
            description: "Test",
            rule_json: {
              type: "first_order",
              discount_pct: 0, // Less than 1%
            },
          },
        }),
      ).rejects.toThrow();
    });

    it("callWaiterFn: rejects reason longer than 200 characters", async () => {
      const { callWaiterFn } = await import("./waiter.functions");

      await expect(
        callWaiterFn({
          data: {
            qrToken: QR_TOKEN,
            reason: "a".repeat(201),
          },
        }),
      ).rejects.toThrow();
    });

    it("submitFeedbackFn: rejects comment longer than 1000 characters or structuredAnswers > 10 keys", async () => {
      const { submitFeedbackFn } = await import("./wallet.functions");

      // Too long comment
      await expect(
        submitFeedbackFn({
          data: {
            qrToken: QR_TOKEN,
            orderId: ORDER_1_ID,
            rating: 5,
            comment: "x".repeat(1001),
          },
        }),
      ).rejects.toThrow();

      // Too many answer keys (>10)
      const answers: Record<string, string> = {};
      for (let i = 0; i < 11; i++) {
        answers[`q_${i}`] = "answer";
      }

      await expect(
        submitFeedbackFn({
          data: {
            qrToken: QR_TOKEN,
            orderId: ORDER_1_ID,
            rating: 5,
            structuredAnswers: answers,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
