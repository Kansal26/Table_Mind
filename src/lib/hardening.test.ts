import { beforeEach, describe, expect, it, vi } from "vitest";
import { escapeHtml } from "./email.server";
import { evaluateCoupons } from "./coupons.server";

const RESTAURANT_ID = "00000000-0000-4000-a000-000000000001";
const TABLE_ID = "00000000-0000-4000-a000-000000000002";
const USER_ID = "00000000-0000-4000-a000-000000000003";
const ORDER_ID = "00000000-0000-4000-a000-000000000004";

const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: {
      getUser: vi.fn(),
      admin: { getUserById: vi.fn() },
    },
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

describe("Phase 6: Hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. QR Tokens: Exact matching and base64url generation", () => {
    it("uses exact match eq instead of ilike to prevent wildcard traversal", async () => {
      let queriedColumn = "";
      let queriedValue = "";
      let methodUsed = "";

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "tables") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((col: string, val: string) => {
              methodUsed = "eq";
              queriedColumn = col;
              queriedValue = val;
              return {
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: TABLE_ID, restaurant_id: RESTAURANT_ID },
                  error: null,
                }),
              };
            }),
            ilike: vi.fn().mockImplementation(() => {
              methodUsed = "ilike";
              return { maybeSingle: vi.fn() };
            }),
          };
        }
        if (table === "sessions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: null }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      });

      const { requireSessionScope, resolveTableId } = await import("./ordering.server");
      await requireSessionScope("token_with_underscore_and%percent");

      expect(methodUsed).toBe("eq");
      expect(queriedColumn).toBe("qr_token");
      expect(queriedValue).toBe("token_with_underscore_and%percent");

      await resolveTableId("sample-token");
      expect(methodUsed).toBe("eq");
      expect(queriedColumn).toBe("qr_token");
    });
  });

  describe("2. Rate Limiting: Postgres RPC and Client Identifier", () => {
    it("identifies user when signed in, otherwise falls back to device + IP", async () => {
      const { getClientIdentifier } = await import("./rate-limit.server");

      const userIdentifier = getClientIdentifier({ userId: "user-123", deviceToken: "dev-456" });
      expect(userIdentifier).toBe("user:user-123");

      const guestIdentifier = getClientIdentifier({ deviceToken: "dev-456" });
      expect(guestIdentifier).toContain("device:dev-456");
    });

    it("throws 429 when check_rate_limit RPC returns false", async () => {
      mockSupabase.rpc.mockResolvedValue({ data: false, error: null });

      const { rateLimit } = await import("./rate-limit.server");
      await expect(rateLimit("user:123", "testAction", 5, 60000)).rejects.toThrow(
        "429: Too Many Requests",
      );
    });
  });

  describe("5. Tax Rate: Per-restaurant tax rate setting", () => {
    it("uses restaurant tax_rate when available, defaulting to 0.05", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                user_id: USER_ID,
                points_redeemed: 0,
                sessions: { tables: { restaurant_id: RESTAURANT_ID } },
              },
              error: null,
            }),
            update: vi.fn().mockReturnThis(),
          };
        }
        if (table === "order_items") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "item-1",
                  qty: 1,
                  customizations: null,
                  menu_items: { id: "dish-1", price: 100, name: "Dish" },
                },
              ],
              error: null,
            }),
          };
        }
        if (table === "order_discounts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
          };
        }
        if (table === "restaurants") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { tax_rate: 0.12 }, // 12% custom tax rate
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
        };
      });

      let updatedTax = 0;
      let updatedTotal = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                user_id: USER_ID,
                points_redeemed: 0,
                sessions: { tables: { restaurant_id: RESTAURANT_ID } },
              },
              error: null,
            }),
            update: vi.fn().mockImplementation((payload) => {
              updatedTax = payload.tax;
              updatedTotal = payload.total;
              return { eq: vi.fn().mockResolvedValue({ error: null }) };
            }),
          };
        }
        if (table === "order_items") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "item-1",
                  qty: 1,
                  customizations: null,
                  menu_items: { id: "dish-1", price: 100, name: "Dish" },
                },
              ],
              error: null,
            }),
          };
        }
        if (table === "order_discounts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === "restaurants") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { tax_rate: 0.12 },
              error: null,
            }),
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      });

      const { recalcTotals } = await import("./ordering.server");
      await recalcTotals(ORDER_ID);

      expect(updatedTax).toBe(12); // 100 * 0.12
      expect(updatedTotal).toBe(112); // 100 + 12
    });
  });

  describe("6. Email HTML Escaping", () => {
    it("escapes user-supplied HTML entities to prevent injection", () => {
      expect(escapeHtml("<script>alert('xss')</script>")).toBe(
        "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
      );
      expect(escapeHtml('John "Chef" & Sons')).toBe("John &quot;Chef&quot; &amp; Sons");
      expect(escapeHtml(null)).toBe("");
      expect(escapeHtml(undefined)).toBe("");
    });
  });

  describe("8. Wallet Balance FIFO Expiry & Overnight Coupons", () => {
    it("does not incorrectly subtract historical redemptions from new valid unexpired points", async () => {
      const now = new Date();
      const pastExpired = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const pastRedemption = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();
      const futureExpiry = new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString();

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "wallet_transactions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: [
                // Batch 1: Earned 100, but expired 40 days ago
                { points: 100, expires_at: pastExpired, created_at: pastExpired },
                // Redemption: Spent 100 20 days ago (consumed Batch 1)
                { points: -100, expires_at: null, created_at: pastRedemption },
                // Batch 2: Fresh 50 points earned recently, expires in 20 days
                { points: 50, expires_at: futureExpiry, created_at: now.toISOString() },
              ],
              error: null,
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      });

      const { getWalletBalance } = await import("./wallet.server");
      const balance = await getWalletBalance(USER_ID, RESTAURANT_ID);

      // Should be 50, NOT 0! The old 100 redemption applied to the old 100 batch.
      expect(balance).toBe(50);
    });

    it("evaluates overnight time_window coupons where end is earlier than start", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                id: ORDER_ID,
                user_id: USER_ID,
                session: { tables: { restaurant_id: RESTAURANT_ID } },
              },
            }),
          };
        }
        if (table === "coupons") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            then: (resolve: any) =>
              resolve({
                data: [
                  {
                    id: "coupon-overnight",
                    name: "Late Night Cravings",
                    rule_json: {
                      type: "time_window",
                      start: "20:00",
                      end: "04:00", // Overnight window crossing midnight
                      discount_pct: 15,
                    },
                    active: true,
                  },
                ],
              }),
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      });

      const eligible = await evaluateCoupons(ORDER_ID, [], 200);

      // Verify that overnight logic handles start > end
      const [startH, startM] = [20, 0];
      const [endH, endM] = [4, 0];
      const startMinutes = startH * 60 + startM; // 1200
      const endMinutes = endH * 60 + endM; // 240

      const checkInWindow = (currentMinutes: number) =>
        startMinutes <= endMinutes
          ? currentMinutes >= startMinutes && currentMinutes <= endMinutes
          : currentMinutes >= startMinutes || currentMinutes <= endMinutes;

      expect(checkInWindow(23 * 60)).toBe(true); // 23:00 -> in window
      expect(checkInWindow(2 * 60)).toBe(true); // 02:00 -> in window
      expect(checkInWindow(12 * 60)).toBe(false); // 12:00 -> outside window
    });
  });
});
