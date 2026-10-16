import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    from: vi.fn(),
    auth: {
      getUser: vi.fn(),
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

vi.mock("./ordering.server", () => ({
  requireSessionScope: vi.fn(),
  findCartOrder: vi.fn(),
  recalcTotals: vi.fn(),
  loadOrderLines: vi.fn(),
  recordSessionActivity: vi.fn(),
}));

import { requireSessionScope } from "./ordering.server";
import { fetchSessionParticipantsFn } from "./ordering.functions";
import { fetchAdminCouponsFn } from "./coupons.functions";
import { fetchAdminMenuFn } from "./menu.functions";
import { updateBrandingFn } from "./branding.functions";
import { registerRestaurantFn } from "./registration.functions";

describe("fetchSessionParticipantsFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty list if qrToken cannot be resolved to a session", async () => {
    vi.mocked(requireSessionScope).mockResolvedValue(null);

    const result = await fetchSessionParticipantsFn({ data: { qrToken: "invalid-qr" } });
    expect(result).toEqual([]);
  });

  it("fetches session participants via supabaseAdmin for a valid session scope", async () => {
    vi.mocked(requireSessionScope).mockResolvedValue({
      sessionId: "session-123",
      tableId: "table-1",
      restaurantId: "restaurant-1",
    });

    const mockParticipants = [
      { id: "p1", session_id: "session-123", guest_name: "Alice", device_token: "d1" },
    ];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "session_participants") {
        return {
          select: () => ({
            eq: (field: string, val: string) => {
              expect(field).toBe("session_id");
              expect(val).toBe("session-123");
              return Promise.resolve({ data: mockParticipants, error: null });
            },
          }),
        };
      }
      return {};
    });

    const result = await fetchSessionParticipantsFn({ data: { qrToken: "valid-qr" } });
    expect(result).toEqual(mockParticipants);
  });
});

describe("fetchAdminCouponsFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches coupons using supabaseAdmin after ownership check", async () => {
    const ownerId = "owner-1";
    const restaurantId = "11111111-1111-4111-8111-111111111111";

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: ownerId } },
      error: null,
    });

    const mockCoupons = [{ id: "coupon-1", code: "WELCOME10", restaurant_id: restaurantId }];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "restaurants") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: restaurantId, owner_id: ownerId },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "coupons") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: mockCoupons,
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    const result = await fetchAdminCouponsFn({
      data: { token: "valid-token", restaurantId },
    });
    expect(result).toEqual(mockCoupons);
  });
});

describe("fetchAdminMenuFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches menu items using supabaseAdmin after ownership check", async () => {
    const ownerId = "owner-1";
    const restaurantId = "11111111-1111-4111-8111-111111111111";

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: ownerId } },
      error: null,
    });

    const mockItems = [{ id: "item-1", name: "Dish 1", restaurant_id: restaurantId }];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "restaurants") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: restaurantId, owner_id: ownerId },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "menu_items") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  order: () => ({
                    order: async () => ({
                      data: mockItems,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const result = await fetchAdminMenuFn({
      data: { token: "valid-token", restaurantId },
    });
    expect(result).toEqual(mockItems);
  });
});

describe("updateBrandingFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates restaurant branding using supabaseAdmin after ownership check", async () => {
    const ownerId = "owner-1";
    const restaurantId = "11111111-1111-4111-8111-111111111111";

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: ownerId } },
      error: null,
    });

    let updatedPayload: Record<string, unknown> | null = null;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "restaurants") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: restaurantId, owner_id: ownerId },
                error: null,
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            updatedPayload = payload;
            return {
              eq: async () => ({ error: null }),
            };
          },
        };
      }
      return {};
    });

    const result = await updateBrandingFn({
      data: {
        token: "valid-token",
        restaurantId,
        tagline: "Fine dining reinvented",
      },
    });

    expect(result).toEqual({ ok: true });
    expect(updatedPayload).toEqual({ tagline: "Fine dining reinvented" });
  });
});

describe("registerRestaurantFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates restaurant and tables via supabaseAdmin with unique qr_tokens", async () => {
    const ownerId = "owner-1";

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: ownerId, email: "owner@example.com" } },
      error: null,
    });

    const insertedTables: any[] = [];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "restaurants") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: { id: "new-rest-uuid-1111" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "tables") {
        return {
          insert: async (rows: any[]) => {
            insertedTables.push(...rows);
            return { error: null };
          },
        };
      }
      return {};
    });

    const result = await registerRestaurantFn({
      data: {
        token: "owner-token",
        name: "Artisan Kitchen",
        city: "Seattle",
        address: "100 Pike St",
        numTables: 3,
      },
    });

    expect(result).toEqual({ ok: true, restaurantId: "new-rest-uuid-1111" });
    expect(insertedTables.length).toBe(3);
    expect(insertedTables[0].qr_token).toBeDefined();
    expect(insertedTables[0].restaurant_id).toBe("new-rest-uuid-1111");
  });
});
