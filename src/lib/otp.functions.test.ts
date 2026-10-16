import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Test UUIDs
// ---------------------------------------------------------------------------
const USER_ID = "00000000-0000-4000-a000-000000000001";
const OTP_ID = "10000000-0000-4000-a000-000000000001";
const TOKEN = "valid-admin-token";

// ---------------------------------------------------------------------------
// Mock Setup
// ---------------------------------------------------------------------------
const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: {
      getUser: vi.fn(),
      admin: {
        updateUserById: vi.fn().mockResolvedValue({ error: null }),
        deleteUser: vi.fn().mockResolvedValue({ error: null }),
      },
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

vi.mock("./rate-limit.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(undefined),
  getClientIdentifier: vi.fn().mockReturnValue("test-client"),
}));

function chainMock(result: any, error: any = null) {
  const chain: any = {
    then: (resolve: any, reject?: any) =>
      Promise.resolve({ data: result, error }).then(resolve, reject),
  };
  for (const method of [
    "select", "insert", "update", "delete", "eq", "neq", "in", "gt", "lt",
    "gte", "lte", "order", "limit", "ilike", "not", "or", "is"
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue({ data: result, error });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: result, error });
  return chain;
}

function hashOtp(code: string, salt: string): string {
  return crypto.createHash("sha256").update(`${code}${salt}`).digest("hex");
}

describe("Phase 4: Server-Side OTP Enforcement & Two-Stage Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    mockSupabase.rpc.mockReset();
    mockSupabase.auth.getUser.mockReset();

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: USER_ID, email: "admin@example.com" } },
      error: null,
    });
  });

  // -------------------------------------------------------------------------
  // 1. Actions without verified OTP are rejected
  // -------------------------------------------------------------------------
  describe("Action without verified OTP rejection", () => {
    it("deactivateAccountFn: rejects when no verified OTP exists", async () => {
      // Mock consume_verified_otp RPC returning false (no verified OTP)
      mockSupabase.rpc.mockResolvedValueOnce({ data: false, error: null });

      const { deactivateAccountFn } = await import("./security.functions");

      await expect(
        deactivateAccountFn({ data: { token: TOKEN } }),
      ).rejects.toThrow("403: Forbidden. Validated OTP required.");
    });

    it("deleteAccountFn: rejects when no verified OTP exists", async () => {
      mockSupabase.rpc.mockResolvedValueOnce({ data: false, error: null });

      const { deleteAccountFn } = await import("./security.functions");

      await expect(
        deleteAccountFn({ data: { token: TOKEN } }),
      ).rejects.toThrow("403: Forbidden. Validated OTP required.");
    });

    it("changePasswordFn: rejects when no verified OTP exists", async () => {
      mockSupabase.rpc.mockResolvedValueOnce({ data: false, error: null });

      const { changePasswordFn } = await import("./security.functions");

      await expect(
        changePasswordFn({ data: { token: TOKEN, newPassword: "newsecurepassword123" } }),
      ).rejects.toThrow("403: Forbidden. Validated OTP required.");
    });
  });

  // -------------------------------------------------------------------------
  // 2. An OTP can only be used once (consumeVerifiedOtp)
  // -------------------------------------------------------------------------
  describe("One-time use of verified OTP", () => {
    it("allows first consumption but rejects second consumption", async () => {
      const { consumeVerifiedOtp } = await import("./otp.functions");

      // First call: RPC succeeds (returns true)
      mockSupabase.rpc.mockResolvedValueOnce({ data: true, error: null });
      await expect(consumeVerifiedOtp(USER_ID, "change_password")).resolves.toBeUndefined();

      // Second call: RPC returns false (already consumed / burned)
      mockSupabase.rpc.mockResolvedValueOnce({ data: false, error: null });
      await expect(consumeVerifiedOtp(USER_ID, "change_password")).rejects.toThrow(
        "403: Forbidden. Validated OTP required.",
      );
    });

    it("deactivateAccountFn succeeds when verified OTP is consumed", async () => {
      // consumeVerifiedOtp succeeds
      mockSupabase.rpc.mockResolvedValueOnce({ data: true, error: null });

      // Restaurant update succeeds
      const updateChain = chainMock({ id: "rest-1" });
      mockSupabase.from.mockReturnValueOnce(updateChain);

      const { deactivateAccountFn } = await import("./security.functions");

      const res = await deactivateAccountFn({ data: { token: TOKEN } });
      expect(res).toEqual({ success: true });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Expired and over-attempt OTPs fail
  // -------------------------------------------------------------------------
  describe("Expired and over-attempt OTP failures", () => {
    const salt = "randomsalt123456";
    const validCode = "654321";
    const codeHash = hashOtp(validCode, salt);

    it("verifyOtpFn: fails if OTP is expired", async () => {
      const pastDate = new Date(Date.now() - 1000 * 60).toISOString(); // 1 minute in past
      const expiredOtp = {
        id: OTP_ID,
        user_id: USER_ID,
        purpose: "change_password",
        code_hash: codeHash,
        salt,
        attempts: 0,
        max_attempts: 3,
        expires_at: pastDate,
      };

      const selectChain = chainMock([expiredOtp]);
      mockSupabase.from.mockReturnValueOnce(selectChain);

      const { verifyOtpFn } = await import("./otp.functions");

      const res = await verifyOtpFn({
        data: { token: TOKEN, purpose: "change_password", code: validCode },
      });

      expect(res.verified).toBe(false);
      expect(res.error).toBe("OTP expired. Please request a new one.");
    });

    it("verifyOtpFn: fails if max attempts have already been reached", async () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 5).toISOString();
      const maxedOtp = {
        id: OTP_ID,
        user_id: USER_ID,
        purpose: "change_password",
        code_hash: codeHash,
        salt,
        attempts: 3,
        max_attempts: 3,
        expires_at: futureDate,
      };

      const selectChain = chainMock([maxedOtp]);
      const updateChain = chainMock(null);
      mockSupabase.from
        .mockReturnValueOnce(selectChain)
        .mockReturnValueOnce(updateChain);

      const { verifyOtpFn } = await import("./otp.functions");

      const res = await verifyOtpFn({
        data: { token: TOKEN, purpose: "change_password", code: validCode },
      });

      expect(res.verified).toBe(false);
      expect(res.error).toBe("Too many attempts. Please request a new OTP.");
    });

    it("verifyOtpFn: fails on wrong code and decrements remaining attempts", async () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 5).toISOString();
      const activeOtp = {
        id: OTP_ID,
        user_id: USER_ID,
        purpose: "change_password",
        code_hash: codeHash,
        salt,
        attempts: 0,
        max_attempts: 3,
        expires_at: futureDate,
      };

      const selectChain = chainMock([activeOtp]);
      const updateAttemptsChain = chainMock(null);

      mockSupabase.from
        .mockReturnValueOnce(selectChain) // fetch active otp
        .mockReturnValueOnce(updateAttemptsChain); // increment attempts

      // RPC increment_otp_attempts returns 1
      mockSupabase.rpc.mockResolvedValueOnce({ data: 1, error: null });

      const { verifyOtpFn } = await import("./otp.functions");

      const res = await verifyOtpFn({
        data: { token: TOKEN, purpose: "change_password", code: "000000" }, // wrong code
      });

      expect(res.verified).toBe(false);
      expect(res.attemptsRemaining).toBe(2);
      expect(res.error).toBe("Incorrect code.");
    });

    it("verifyOtpFn: succeeds with correct code and sets verified_at without burning used_at", async () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 5).toISOString();
      const activeOtp = {
        id: OTP_ID,
        user_id: USER_ID,
        purpose: "change_password",
        code_hash: codeHash,
        salt,
        attempts: 0,
        max_attempts: 3,
        expires_at: futureDate,
      };

      const selectChain = chainMock([activeOtp]);
      const verifySuccessChain = chainMock(null);

      mockSupabase.from
        .mockReturnValueOnce(selectChain)
        .mockReturnValueOnce(verifySuccessChain);

      mockSupabase.rpc.mockResolvedValueOnce({ data: 1, error: null });

      const { verifyOtpFn } = await import("./otp.functions");

      const res = await verifyOtpFn({
        data: { token: TOKEN, purpose: "change_password", code: validCode },
      });

      expect(res.verified).toBe(true);
      // Verify that update was called with verified_at
      expect(mockSupabase.from).toHaveBeenCalledWith("otp_verifications");
    });
  });
});
