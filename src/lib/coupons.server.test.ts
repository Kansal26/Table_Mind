import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSupabase = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock('@/integrations/supabase/client.server', () => ({
  supabaseAdmin: mockSupabase,
}));

import { evaluateCoupons } from './coupons.server';

describe('evaluateCoupons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('returns no discounts for empty carts', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'order-1',
                  user_id: 'user-1',
                  status: 'cart',
                  session: { tables: { restaurant_id: 'restaurant-1' } },
                },
                error: null,
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(evaluateCoupons('order-1', [], 0)).resolves.toEqual([]);
  });

  it('requires the minimum spend threshold and rejects guest first-order coupons', async () => {
    vi.setSystemTime(new Date('2025-01-10T12:00:00+05:30'));

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'order-1',
                  user_id: null,
                  status: 'cart',
                  session: { tables: { restaurant_id: 'restaurant-1' } },
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === 'coupons') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                data: [
                  {
                    id: 'cp-first',
                    restaurant_id: 'restaurant-1',
                    name: 'First order',
                    description: '10% off',
                    rule_json: { type: 'first_order', discount_pct: 10 },
                    valid_from: null,
                    valid_to: null,
                    active: true,
                  },
                  {
                    id: 'cp-min',
                    restaurant_id: 'restaurant-1',
                    name: 'Spend & save',
                    description: '10% off orders over ₹500',
                    rule_json: { type: 'min_spend', amount: 500, discount_pct: 10 },
                    valid_from: null,
                    valid_to: null,
                    active: true,
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const belowThreshold = await evaluateCoupons('order-1', [{ menu_item: { id: 'item-1', price: 200 }, qty: 2 }], 400);
    const exactThreshold = await evaluateCoupons('order-1', [{ menu_item: { id: 'item-1', price: 250 }, qty: 2 }], 500);

    expect(belowThreshold).toEqual([]);
    expect(exactThreshold).toEqual([
      expect.objectContaining({ id: 'cp-min', calculated_discount: 50 }),
    ]);
  });

  it('rejects expired and not-yet-active coupons', async () => {
    vi.setSystemTime(new Date('2025-01-12T12:00:00+05:30'));

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'order-1',
                  user_id: 'user-1',
                  status: 'cart',
                  session: { tables: { restaurant_id: 'restaurant-1' } },
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === 'coupons') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                data: [
                  {
                    id: 'cp-expired',
                    restaurant_id: 'restaurant-1',
                    name: 'Expired deal',
                    description: 'Already over',
                    rule_json: { type: 'min_spend', amount: 100, discount_pct: 10 },
                    valid_from: '2025-01-01T00:00:00+05:30',
                    valid_to: '2025-01-10T23:59:59+05:30',
                    active: true,
                  },
                  {
                    id: 'cp-future',
                    restaurant_id: 'restaurant-1',
                    name: 'Future deal',
                    description: 'Starts later',
                    rule_json: { type: 'min_spend', amount: 100, discount_pct: 10 },
                    valid_from: '2025-01-13T00:00:00+05:30',
                    valid_to: '2025-01-20T23:59:59+05:30',
                    active: true,
                  },
                  {
                    id: 'cp-valid',
                    restaurant_id: 'restaurant-1',
                    name: 'Live deal',
                    description: 'Valid now',
                    rule_json: { type: 'min_spend', amount: 100, discount_pct: 10 },
                    valid_from: '2025-01-01T00:00:00+05:30',
                    valid_to: '2025-01-31T23:59:59+05:30',
                    active: true,
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const eligible = await evaluateCoupons('order-1', [{ menu_item: { id: 'item-1', price: 200 }, qty: 1 }], 200);

    expect(eligible).toEqual([
      expect.objectContaining({ id: 'cp-valid', calculated_discount: 20 }),
    ]);
  });

  it('supports item-specific and time-window rules', async () => {
    const timeWindowCoupon = {
      id: 'cp-time',
      restaurant_id: 'restaurant-1',
      name: 'Lunch rush',
      description: '9AM to 11AM',
      rule_json: { type: 'time_window', start: '09:00', end: '11:00', discount_pct: 15 },
      valid_from: null,
      valid_to: null,
      active: true,
    };

    const itemCoupon = {
      id: 'cp-item',
      restaurant_id: 'restaurant-1',
      name: 'Starter discount',
      description: '10% off all paneer',
      rule_json: { type: 'item_specific', item_id: 'item-2', discount_pct: 10 },
      valid_from: null,
      valid_to: null,
      active: true,
    };

    vi.setSystemTime(new Date('2025-01-01T10:00:00+05:30'));

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'order-1',
                  user_id: 'user-1',
                  status: 'cart',
                  session: { tables: { restaurant_id: 'restaurant-1' } },
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === 'coupons') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                data: [timeWindowCoupon, itemCoupon],
                error: null,
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const eligible = await evaluateCoupons('order-1', [
      { menu_item: { id: 'item-2', price: 200 }, qty: 2 },
    ], 400);

    expect(eligible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'cp-time', calculated_discount: 60 }),
        expect.objectContaining({ id: 'cp-item', calculated_discount: 40 }),
      ]),
    );

    vi.useRealTimers();
  });
});
