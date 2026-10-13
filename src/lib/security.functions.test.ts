import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSupabase = vi.hoisted(() => ({
  auth: {
    getUser: vi.fn(),
  },
  from: vi.fn(),
}));

vi.mock('@/integrations/supabase/client.server', () => ({
  supabaseAdmin: mockSupabase,
}));

import { requireRestaurantOwnership, verifyAdminAuth } from './auth.server';

describe('verifyAdminAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects missing tokens before contacting Supabase', async () => {
    await expect(verifyAdminAuth(undefined)).rejects.toThrow('401: Unauthorized. Missing access token.');
    expect(mockSupabase.auth.getUser).not.toHaveBeenCalled();
  });

  it('accepts valid admin JWTs and returns the user', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'owner-1', email: 'owner@example.com' } },
      error: null,
    });

    await expect(verifyAdminAuth('token-123')).resolves.toMatchObject({ id: 'owner-1' });
  });

  it('rejects invalid or expired tokens', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new Error('Expired token'),
    });

    await expect(verifyAdminAuth('expired-token')).rejects.toThrow('401: Unauthorized. Invalid or expired token.');
  });
});

describe('requireRestaurantOwnership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows an owner to access their restaurant', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'owner-1' } },
      error: null,
    });

    mockSupabase.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { id: 'restaurant-1', owner_id: 'owner-1' },
            error: null,
          }),
        }),
      }),
    });

    await expect(requireRestaurantOwnership('token-123', 'restaurant-1')).resolves.toMatchObject({ id: 'owner-1' });
  });

  it('rejects other users from managing a restaurant they do not own', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'owner-2' } },
      error: null,
    });

    mockSupabase.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { id: 'restaurant-1', owner_id: 'owner-1' },
            error: null,
          }),
        }),
      }),
    });

    await expect(requireRestaurantOwnership('token-123', 'restaurant-1')).rejects.toThrow('403: Forbidden. You do not own this restaurant.');
  });
});
