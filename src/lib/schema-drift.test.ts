import { beforeEach, describe, expect, it, vi } from "vitest";

const RESTAURANT_ID = "00000000-0000-4000-a000-000000000001";
const ORDER_ID = "00000000-0000-4000-a000-000000000002";
const USER_ID = "00000000-0000-4000-a000-000000000003";
const SESSION_ID = "00000000-0000-4000-a000-000000000004";
const ITEM_ID = "00000000-0000-4000-a000-000000000005";

const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    from: vi.fn(),
  },
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validatorFn = (d: any) => d;
    const builder = {
      validator: (v: any) => {
        validatorFn = v;
        return builder;
      },
      handler: (h: any) => {
        return async (args: any) => {
          const validated = validatorFn(args?.data !== undefined ? args.data : args);
          return await h({ data: validated });
        };
      },
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabase,
}));

describe("Phase 5: Schema Drift & Broken Features", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("processFeedbackSubmission in wallet.server.ts", () => {
    it("derives restaurant_id via sessions -> tables and inserts live-schema columns", async () => {
      let insertedFeedback: any = null;
      let insertedTx: any = null;

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                id: ORDER_ID,
                sessions: {
                  tables: {
                    restaurant_id: RESTAURANT_ID,
                  },
                },
              },
              error: null,
            }),
          };
        }
        if (table === "loyalty_settings") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                enabled: true,
                points_for_rating: 10,
                points_for_comment: 15,
                points_for_question: 5,
                points_expiry_days: 30,
                points_per_rupee: 0.1,
              },
              error: null,
            }),
          };
        }
        if (table === "feedback") {
          return {
            insert: vi.fn().mockImplementation((payload) => {
              insertedFeedback = payload;
              return { error: null };
            }),
          };
        }
        if (table === "wallet_transactions") {
          return {
            insert: vi.fn().mockImplementation((payload) => {
              insertedTx = payload;
              return { error: null };
            }),
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      });

      const { processFeedbackSubmission } = await import("./wallet.server");
      const res = await processFeedbackSubmission(
        ORDER_ID,
        USER_ID,
        5,
        "Delicious food and exceptional ambiance!",
        { speed: "Fast", service: "Great" },
      );

      expect(res.creditEarned).toBe(35); // 10 (rating) + 15 (comment > 10 chars) + 2*5 (2 questions)
      expect(insertedFeedback).toEqual({
        order_id: ORDER_ID,
        rating: 5,
        comment: "Delicious food and exceptional ambiance!",
        structured_answers: { speed: "Fast", service: "Great" },
        credit_awarded: 35,
      });
      expect(insertedTx.points).toBe(35);
      expect(insertedTx.user_id).toBe(USER_ID);
      expect(insertedTx.restaurant_id).toBe(RESTAURANT_ID);
    });
  });

  describe("customizations nullability in ordering.server.ts", () => {
    it("handles null, string, and object customizations without throwing", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "order_items") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "line-1",
                  qty: 1,
                  customizations: null,
                  menu_items: {
                    id: "item-1",
                    name: "Dish 1",
                    price: 100,
                    category: "Mains",
                    allergens: [],
                    dietary_tags: [],
                    available: true,
                    image_url: null,
                  },
                },
                {
                  id: "line-2",
                  qty: 2,
                  customizations: "Extra spicy",
                  menu_items: {
                    id: "item-2",
                    name: "Dish 2",
                    price: 150,
                    category: "Mains",
                    allergens: [],
                    dietary_tags: [],
                    available: true,
                    image_url: null,
                  },
                },
                {
                  id: "line-3",
                  qty: 1,
                  customizations: { notes: "No onions" },
                  menu_items: {
                    id: "item-3",
                    name: "Dish 3",
                    price: 200,
                    category: "Mains",
                    allergens: [],
                    dietary_tags: [],
                    available: true,
                    image_url: null,
                  },
                },
              ],
              error: null,
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      });

      const { loadOrderLines } = await import("./ordering.server");
      const lines = await loadOrderLines(ORDER_ID);

      expect(lines).toHaveLength(3);
      expect(lines[0]!.customizations).toBeNull();
      expect(lines[1]!.customizations).toEqual({ notes: "Extra spicy" });
      expect(lines[2]!.customizations).toEqual({ notes: "No onions" });
    });
  });

  describe("recommendation_logs wiring in ordering.functions.ts", () => {
    it("updates added_to_cart = true when item is added to cart", async () => {
      let updatedTable: string | null = null;
      let updatePayload: any = null;
      const updateEqs: Record<string, any> = {};

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "menu_items") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: ITEM_ID, price: 250 },
              error: null,
            }),
          };
        }
        if (table === "order_items") {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        if (table === "recommendation_logs") {
          return {
            update: vi.fn().mockImplementation((payload) => {
              updatedTable = "recommendation_logs";
              updatePayload = payload;
              return {
                eq: vi.fn().mockImplementation((col, val) => {
                  updateEqs[col] = val;
                  return {
                    eq: vi.fn().mockImplementation((col2, val2) => {
                      updateEqs[col2] = val2;
                      return Promise.resolve({ error: null });
                    }),
                  };
                }),
              };
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          update: vi.fn().mockReturnThis(),
        };
      });

      vi.mock("./ordering.server", async (importOriginal) => {
        const actual = await importOriginal<any>();
        return {
          ...actual,
          requireSessionScope: vi.fn().mockResolvedValue({
            sessionId: SESSION_ID,
            tableId: "table-1",
            restaurantId: RESTAURANT_ID,
          }),
          ensureCartOrder: vi.fn().mockResolvedValue(ORDER_ID),
          recordSessionActivity: vi.fn().mockResolvedValue(undefined),
          recalcTotals: vi.fn().mockResolvedValue(undefined),
        };
      });

      const { addToCartFn } = await import("./ordering.functions");
      const res = await addToCartFn({
        data: {
          qrToken: "test-qr",
          menuItemId: ITEM_ID,
          qty: 1,
        },
      } as any);

      expect(res.orderId).toBe(ORDER_ID);
      expect(updatedTable).toBe("recommendation_logs");
      expect(updatePayload).toEqual({ added_to_cart: true });
      expect(updateEqs["session_id"]).toBe(SESSION_ID);
      expect(updateEqs["item_id"]).toBe(ITEM_ID);
    });
  });
});
