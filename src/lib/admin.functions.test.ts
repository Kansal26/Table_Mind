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

import { getOwnerRestaurantFn, fetchLiveOrdersFn } from "./admin.functions";

describe("getOwnerRestaurantFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated calls", async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new Error("Invalid JWT"),
    });

    await expect(getOwnerRestaurantFn({ data: { token: "bad-token" } })).rejects.toThrow(
      "401: Unauthorized. Invalid or expired token.",
    );
  });

  it("returns the restaurant owned by user via supabaseAdmin", async () => {
    const ownerId = "owner-uuid-123";
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: ownerId } },
      error: null,
    });

    const expectedRestaurant = {
      id: "restaurant-uuid-456",
      name: "The Grand Bistro",
      owner_id: ownerId,
      deactivated_at: null,
      is_active: true,
    };

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "restaurants") {
        return {
          select: (cols: string) => {
            expect(cols).toBe("*");
            return {
              eq: (field: string, val: string) => {
                expect(field).toBe("owner_id");
                expect(val).toBe(ownerId);
                return {
                  maybeSingle: async () => ({
                    data: expectedRestaurant,
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      return {};
    });

    const result = await getOwnerRestaurantFn({ data: { token: "valid-token" } });
    expect(result).toEqual(expectedRestaurant);
    expect(result?.owner_id).toBe(ownerId);
    expect(result?.deactivated_at).toBeNull();
  });
});

describe("fetchLiveOrdersFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enforces restaurant ownership before returning orders", async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: "attacker-user" } },
      error: null,
    });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "restaurants") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: "11111111-1111-4111-8111-111111111111", owner_id: "legit-owner" },
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    await expect(
      fetchLiveOrdersFn({
        data: {
          token: "attacker-token",
          restaurantId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    ).rejects.toThrow("403: Forbidden. You do not own this restaurant.");
  });

  it("fetches live orders via supabaseAdmin when owner is verified", async () => {
    const ownerId = "owner-1";
    const restaurantId = "11111111-1111-4111-8111-111111111111";

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: ownerId } },
      error: null,
    });

    const mockOrders = [
      {
        id: "order-1",
        created_at: new Date().toISOString(),
        kitchen_status: "received",
      },
    ];

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
      if (table === "orders") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                or: () => ({
                  order: async () => ({
                    data: mockOrders,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const result = await fetchLiveOrdersFn({
      data: {
        token: "valid-token",
        restaurantId,
      },
    });

    expect(result).toEqual(mockOrders);
  });
});
