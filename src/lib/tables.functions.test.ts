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

import { fetchAdminTablesFn } from "./tables.functions";

describe("fetchAdminTablesFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests", async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new Error("Invalid token"),
    });

    await expect(
      fetchAdminTablesFn({
        data: {
          token: "invalid-token",
          restaurantId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    ).rejects.toThrow("401: Unauthorized. Invalid or expired token.");
  });

  it("rejects non-owner callers from reading restaurant tables", async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: "user-attacker" } },
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
      fetchAdminTablesFn({
        data: {
          token: "attacker-token",
          restaurantId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    ).rejects.toThrow("403: Forbidden. You do not own this restaurant.");
  });

  it("allows verified owner to read tables including qr_token via supabaseAdmin", async () => {
    const ownerId = "owner-123";
    const restaurantId = "11111111-1111-4111-8111-111111111111";

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: ownerId } },
      error: null,
    });

    const expectedTables = [
      {
        id: "table-1",
        restaurant_id: restaurantId,
        label: "Table 1",
        qr_token: "rest-t1-abc123",
        seat_count: 4,
        is_active: true,
        created_at: new Date().toISOString(),
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
      if (table === "tables") {
        return {
          select: (columns: string) => {
            expect(columns).toBe("*");
            return {
              eq: (field: string, val: string) => {
                expect(field).toBe("restaurant_id");
                expect(val).toBe(restaurantId);
                return {
                  order: async () => ({
                    data: expectedTables,
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

    const result = await fetchAdminTablesFn({
      data: {
        token: "valid-owner-token",
        restaurantId,
      },
    });

    expect(result).toEqual(expectedTables);
    expect(result[0]?.qr_token).toBe("rest-t1-abc123");
  });
});
