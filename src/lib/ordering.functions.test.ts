import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Test UUIDs (valid UUID v4 format)
// ---------------------------------------------------------------------------
const ORDER_ID = "00000000-0000-4000-a000-000000000001";
const SESSION_ID = "00000000-0000-4000-a000-000000000002";
const TABLE_ID = "00000000-0000-4000-a000-000000000003";
const RESTAURANT_ID = "00000000-0000-4000-a000-000000000004";
const USER_ID = "00000000-0000-4000-a000-000000000005";
const QR_TOKEN = "qr-test-token";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const { mockSupabase, mockRazorpay } = vi.hoisted(() => ({
  mockSupabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: {
      getUser: vi.fn(),
      admin: { getUserById: vi.fn() },
    },
  },
  mockRazorpay: {
    orders: { create: vi.fn() },
    payments: { fetch: vi.fn() },
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

vi.mock("razorpay", () => ({
  default: vi.fn().mockImplementation(() => mockRazorpay),
}));

// Minimal mock for ordering.server helpers
vi.mock("./ordering.server", () => ({
  resolveTableId: vi.fn().mockResolvedValue(TABLE_ID),
  requireOwnedOrder: vi.fn(),
  recalcTotals: vi.fn(),
  requireSessionScope: vi.fn(),
  findCartOrder: vi.fn(),
  loadOrderLines: vi.fn(),
  ensureCartOrder: vi.fn(),
}));

vi.mock("./wallet.server", () => ({
  deductWallet: vi.fn(),
  getWalletBalance: vi.fn().mockResolvedValue(0),
}));

vi.mock("./email.server", () => ({
  sendNewOrderNotification: vi.fn(),
  sendGuestReceiptEmail: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a chain mock for supabase (from → select → eq → … → single/maybeSingle) */
function chainMock(result: any) {
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
  chain.single = vi.fn().mockResolvedValue({ data: result, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: result, error: null });
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("payOrderFn – non-zero order rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    mockSupabase.rpc.mockReset();
    mockRazorpay.orders.create.mockReset();
    mockRazorpay.payments.fetch.mockReset();
    process.env["RAZORPAY_KEY_SECRET"] = "test_secret_key_for_tests";
    process.env["VITE_RAZORPAY_KEY_ID"] = "rzp_test_key";
  });

  it("rejects paying a non-zero order via payOrderFn", async () => {
    const { requireOwnedOrder, recalcTotals } = await import("./ordering.server");
    (requireOwnedOrder as any).mockResolvedValue({
      id: ORDER_ID,
      status: "cart",
      subtotal: 500,
      tax: 42.5,
      total: 542.5,
      session_id: SESSION_ID,
    });
    (recalcTotals as any).mockResolvedValue(undefined);

    // After recalcTotals, the re-fetch returns a non-zero total
    const recalcedChain = chainMock({
      total: 542.5,
      credits_applied: 0,
      points_redeemed: 0,
      user_id: null,
      session_id: SESSION_ID,
      sessions: { tables: { restaurant_id: RESTAURANT_ID } },
    });
    mockSupabase.from.mockReturnValue(recalcedChain);

    const { payOrderFn } = await import("./ordering.functions");

    await expect(
      payOrderFn({
        data: { qrToken: QR_TOKEN, orderId: ORDER_ID },
      }),
    ).rejects.toThrow("non-zero balance");
  });

  it("allows paying a zero-total order via payOrderFn", async () => {
    const { requireOwnedOrder, recalcTotals } = await import("./ordering.server");
    (requireOwnedOrder as any).mockResolvedValue({
      id: ORDER_ID,
      status: "cart",
      subtotal: 0,
      tax: 0,
      total: 0,
      session_id: SESSION_ID,
    });
    (recalcTotals as any).mockResolvedValue(undefined);

    const recalcedChain = chainMock({
      total: 0,
      credits_applied: 0,
      points_redeemed: 0,
      user_id: null,
      session_id: SESSION_ID,
      sessions: { tables: { restaurant_id: RESTAURANT_ID } },
    });
    mockSupabase.from.mockReturnValue(recalcedChain);
    mockSupabase.rpc.mockResolvedValue({ data: 1, error: null });

    const { payOrderFn } = await import("./ordering.functions");

    const result = await payOrderFn({
      data: { qrToken: QR_TOKEN, orderId: ORDER_ID },
    });
    expect(result).toEqual({ ok: true });
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      "complete_payment",
      expect.objectContaining({ p_order_id: ORDER_ID }),
    );
  });
});

describe("verifyRazorpayPaymentFn – replay and amount checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    mockSupabase.rpc.mockReset();
    mockRazorpay.orders.create.mockReset();
    mockRazorpay.payments.fetch.mockReset();
    process.env["RAZORPAY_KEY_SECRET"] = "test_secret_key_for_tests";
    process.env["VITE_RAZORPAY_KEY_ID"] = "rzp_test_key";
  });

  it("rejects if razorpay_order_id doesn't match the stored one", async () => {
    const { requireOwnedOrder, recalcTotals } = await import("./ordering.server");
    (requireOwnedOrder as any).mockResolvedValue({
      id: ORDER_ID,
      status: "cart",
      subtotal: 500,
      tax: 42.5,
      total: 542.5,
      session_id: SESSION_ID,
      discount_amount: 0,
      credits_applied: 0,
    });
    (recalcTotals as any).mockResolvedValue(undefined);

    // The stored razorpay_order_id is different from what the client sent
    const storedChain = chainMock({
      razorpay_order_id: "order_STORED_ONE",
      amount_paise: 54250,
    });
    mockSupabase.from.mockReturnValue(storedChain);

    const { verifyRazorpayPaymentFn } = await import("./ordering.functions");

    await expect(
      verifyRazorpayPaymentFn({
        data: {
          qrToken: QR_TOKEN,
          orderId: ORDER_ID,
          razorpay_order_id: "order_DIFFERENT",
          razorpay_payment_id: "pay_123",
          razorpay_signature: "abc",
        },
      }),
    ).rejects.toThrow("mismatch");
  });

  it("rejects if Razorpay API returns wrong amount", async () => {
    const crypto = await import("crypto");
    const { requireOwnedOrder, recalcTotals } = await import("./ordering.server");
    (requireOwnedOrder as any).mockResolvedValue({
      id: ORDER_ID,
      status: "cart",
      subtotal: 500,
      tax: 42.5,
      total: 542.5,
      session_id: SESSION_ID,
      discount_amount: 0,
      credits_applied: 0,
    });
    (recalcTotals as any).mockResolvedValue(undefined);

    const rpOrderId = "order_CORRECT";
    const rpPaymentId = "pay_123";
    const storedAmountPaise = 54250;

    // Stored order matches
    const storedChain = chainMock({
      razorpay_order_id: rpOrderId,
      amount_paise: storedAmountPaise,
    });
    mockSupabase.from.mockReturnValue(storedChain);

    // Generate a valid signature
    const body = rpOrderId + "|" + rpPaymentId;
    const sig = crypto
      .createHmac("sha256", "test_secret_key_for_tests")
      .update(body)
      .digest("hex");

    // Razorpay API returns a WRONG amount
    mockRazorpay.payments.fetch.mockResolvedValue({
      status: "captured",
      amount: 99999, // wrong!
      order_id: rpOrderId,
    });

    const { verifyRazorpayPaymentFn } = await import("./ordering.functions");

    await expect(
      verifyRazorpayPaymentFn({
        data: {
          qrToken: QR_TOKEN,
          orderId: ORDER_ID,
          razorpay_order_id: rpOrderId,
          razorpay_payment_id: rpPaymentId,
          razorpay_signature: sig,
        },
      }),
    ).rejects.toThrow("amount does not match");
  });

  it("double verify deducts points only once (complete_payment returns 0 on second call)", async () => {
    const crypto = await import("crypto");
    const { requireOwnedOrder, recalcTotals } = await import("./ordering.server");

    // First call: order is 'cart', complete_payment returns 1
    // Second call: order is already 'paid', returns early
    (requireOwnedOrder as any)
      .mockResolvedValueOnce({
        id: ORDER_ID,
        status: "cart",
        subtotal: 500,
        tax: 42.5,
        total: 542.5,
        session_id: SESSION_ID,
        discount_amount: 0,
        credits_applied: 0,
      })
      .mockResolvedValueOnce({
        id: ORDER_ID,
        status: "paid",
        subtotal: 500,
        tax: 42.5,
        total: 542.5,
        session_id: SESSION_ID,
        discount_amount: 0,
        credits_applied: 0,
      });
    (recalcTotals as any).mockResolvedValue(undefined);

    const rpOrderId = "order_CORRECT";
    const rpPaymentId = "pay_456";

    // Build valid signature
    const body = rpOrderId + "|" + rpPaymentId;
    const sig = crypto
      .createHmac("sha256", "test_secret_key_for_tests")
      .update(body)
      .digest("hex");

    // Stored order
    const storedChain = chainMock({
      razorpay_order_id: rpOrderId,
      amount_paise: 54250,
    });

    // Updated order after recalc (for points)
    const updatedChain = chainMock({
      credits_applied: 0,
      points_redeemed: 100,
      user_id: USER_ID,
      sessions: { tables: { restaurant_id: RESTAURANT_ID } },
    });

    // Alternate mocks for from() calls:
    // 1st from("orders") → storedChain (stored razorpay data)
    // 2nd from("orders") → updatedChain (recalced order)
    // Then table/restaurant queries for emails
    const emailChain = chainMock(null);
    mockSupabase.from
      .mockReturnValueOnce(storedChain) // stored order check
      .mockReturnValueOnce(updatedChain) // recalced order
      .mockReturnValueOnce(emailChain) // tables
      .mockReturnValueOnce(emailChain); // restaurants

    mockRazorpay.payments.fetch.mockResolvedValue({
      status: "captured",
      amount: 54250,
      order_id: rpOrderId,
    });

    // First call: complete_payment returns 1 (flipped)
    mockSupabase.rpc.mockResolvedValueOnce({ data: 1, error: null });

    const { verifyRazorpayPaymentFn } = await import("./ordering.functions");

    // First call succeeds
    const result1 = await verifyRazorpayPaymentFn({
      data: {
        qrToken: QR_TOKEN,
        orderId: ORDER_ID,
        razorpay_order_id: rpOrderId,
        razorpay_payment_id: rpPaymentId,
        razorpay_signature: sig,
      },
    });
    expect(result1).toEqual({ ok: true });
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1);

    // Second call: order is now 'paid', returns early without rpc
    const result2 = await verifyRazorpayPaymentFn({
      data: {
        qrToken: QR_TOKEN,
        orderId: ORDER_ID,
        razorpay_order_id: rpOrderId,
        razorpay_payment_id: rpPaymentId,
        razorpay_signature: sig,
      },
    });
    expect(result2).toEqual({ ok: true });
    // rpc should NOT have been called again
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("concurrent verify where order is not yet marked paid in memory: second rpc call returns 0", async () => {
    const { requireOwnedOrder, recalcTotals } = await import("./ordering.server");
    (requireOwnedOrder as any).mockReset();
    (requireOwnedOrder as any).mockResolvedValue({
      id: ORDER_ID,
      status: "cart",
      subtotal: 500,
      tax: 42.5,
      total: 542.5,
      session_id: SESSION_ID,
      discount_amount: 0,
      credits_applied: 0,
    });
    (recalcTotals as any).mockResolvedValue(undefined);

    const rpOrderId = "order_CONCURRENT";
    const rpPaymentId = "pay_789";

    const body = rpOrderId + "|" + rpPaymentId;
    const sig = crypto
      .createHmac("sha256", "test_secret_key_for_tests")
      .update(body)
      .digest("hex");

    const storedChain = chainMock({
      razorpay_order_id: rpOrderId,
      amount_paise: 54250,
    });
    const updatedChain = chainMock({
      credits_applied: 0,
      points_redeemed: 50,
      user_id: USER_ID,
      sessions: { tables: { restaurant_id: RESTAURANT_ID } },
    });

    // 1st call: stored order, updated order, table (null stops email)
    // 2nd call: stored order, updated order (then rpc returns 0 -> returns immediately)
    const emailChain = chainMock(null);
    mockSupabase.from
      .mockReturnValueOnce(storedChain)
      .mockReturnValueOnce(updatedChain)
      .mockReturnValueOnce(emailChain)
      .mockReturnValueOnce(storedChain)
      .mockReturnValueOnce(updatedChain);

    mockRazorpay.payments.fetch.mockResolvedValue({
      status: "captured",
      amount: 54250,
      order_id: rpOrderId,
    });

    mockSupabase.rpc
      .mockResolvedValueOnce({ data: 1, error: null }) // 1st caller flips payment
      .mockResolvedValueOnce({ data: 0, error: null }); // 2nd caller sees already paid (0 rows affected)

    const { verifyRazorpayPaymentFn } = await import("./ordering.functions");

    const res1 = await verifyRazorpayPaymentFn({
      data: {
        qrToken: QR_TOKEN,
        orderId: ORDER_ID,
        razorpay_order_id: rpOrderId,
        razorpay_payment_id: rpPaymentId,
        razorpay_signature: sig,
      },
    });
    expect(res1).toEqual({ ok: true });

    const res2 = await verifyRazorpayPaymentFn({
      data: {
        qrToken: QR_TOKEN,
        orderId: ORDER_ID,
        razorpay_order_id: rpOrderId,
        razorpay_payment_id: rpPaymentId,
        razorpay_signature: sig,
      },
    });
    expect(res2).toEqual({ ok: true });
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(2);
  });
});

describe("createRazorpayOrderFn – stores amount on order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    mockSupabase.rpc.mockReset();
    mockRazorpay.orders.create.mockReset();
    mockRazorpay.payments.fetch.mockReset();
    process.env["RAZORPAY_KEY_SECRET"] = "test_secret_key_for_tests";
    process.env["VITE_RAZORPAY_KEY_ID"] = "rzp_test_key";
  });

  it("calls recalcTotals and stores razorpay_order_id + amount_paise", async () => {
    const { requireOwnedOrder, recalcTotals } = await import("./ordering.server");
    (requireOwnedOrder as any).mockReset();
    (requireOwnedOrder as any).mockResolvedValue({
      id: ORDER_ID,
      status: "cart",
      subtotal: 500,
      tax: 42.5,
      total: 542.5,
      session_id: SESSION_ID,
    });
    (recalcTotals as any).mockResolvedValue(undefined);

    // After recalcTotals, fetch fresh total
    const freshChain = chainMock({ total: 542.5 });
    // Update chain for storing razorpay data
    const updateChain = chainMock(null);

    mockSupabase.from
      .mockReturnValueOnce(freshChain) // fetch fresh total
      .mockReturnValueOnce(updateChain); // store razorpay data

    mockRazorpay.orders.create.mockResolvedValue({
      id: "order_rp_123",
      amount: 54250,
      currency: "INR",
    });

    const { createRazorpayOrderFn } = await import("./ordering.functions");

    const result = await createRazorpayOrderFn({
      data: { qrToken: QR_TOKEN, orderId: ORDER_ID },
    });

    expect(result).toEqual({
      order_id: "order_rp_123",
      amount: 54250,
      currency: "INR",
    });
    expect(recalcTotals).toHaveBeenCalledWith(ORDER_ID);

    // Verify that update was called to store razorpay data
    expect(mockSupabase.from).toHaveBeenCalledWith("orders");
  });

  it("rejects if order is already paid", async () => {
    const { requireOwnedOrder } = await import("./ordering.server");
    (requireOwnedOrder as any).mockResolvedValue({
      id: ORDER_ID,
      status: "paid",
      subtotal: 500,
      tax: 42.5,
      total: 542.5,
      session_id: SESSION_ID,
    });

    const { createRazorpayOrderFn } = await import("./ordering.functions");

    await expect(
      createRazorpayOrderFn({
        data: { qrToken: QR_TOKEN, orderId: ORDER_ID },
      }),
    ).rejects.toThrow("already paid");
  });
});
