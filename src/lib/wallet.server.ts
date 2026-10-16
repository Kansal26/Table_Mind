import { supabaseAdmin } from "@/integrations/supabase/client.server";

export async function getWalletBalance(userId: string, restaurantId: string): Promise<number> {
  const { data: txs, error } = await (supabaseAdmin as any)
    .from("wallet_transactions")
    .select("points, expires_at, created_at")
    .eq("user_id", userId)
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  if (!txs || txs.length === 0) return 0;

  // Separate positive (earned) batches and sum total redemptions
  const earnedBatches: { points: number; expires_at: string | null }[] = [];
  let totalRedeemed = 0;

  for (const tx of txs) {
    const pts = Number(tx.points) || 0;
    if (pts > 0) {
      earnedBatches.push({ points: pts, expires_at: tx.expires_at });
    } else if (pts < 0) {
      totalRedeemed += Math.abs(pts);
    }
  }

  // FIFO consumption of earned batches against totalRedeemed
  const now = new Date();
  let activeBalance = 0;

  for (const batch of earnedBatches) {
    if (totalRedeemed >= batch.points) {
      // Entire batch was consumed by past redemptions
      totalRedeemed -= batch.points;
    } else {
      // Batch partially or wholly remaining
      const unredeemedInBatch = batch.points - totalRedeemed;
      totalRedeemed = 0;

      // Check if this remaining portion has expired
      const isExpired = batch.expires_at ? new Date(batch.expires_at) <= now : false;
      if (!isExpired) {
        activeBalance += unredeemedInBatch;
      }
    }
  }

  return Math.max(0, activeBalance);
}

export async function deductWallet(
  userId: string,
  pointsToRedeem: number,
  reason: string,
  orderId: string,
  restaurantId: string,
) {
  if (pointsToRedeem <= 0) return;

  // Idempotency guard: if a deduction for this order already exists, skip.
  const { data: existing, error: existError } = await (supabaseAdmin as any)
    .from("wallet_transactions")
    .select("id")
    .eq("order_id", orderId)
    .lt("points", 0)
    .limit(1)
    .maybeSingle();
  if (existError) throw existError;
  if (existing) return; // already deducted for this order

  const current = await getWalletBalance(userId, restaurantId);
  if (current < pointsToRedeem) throw new Error("Insufficient points balance");

  // Insert transaction
  const { error: txError } = await (supabaseAdmin as any).from("wallet_transactions").insert({
    user_id: userId,
    restaurant_id: restaurantId,
    amount: 0,
    points: -pointsToRedeem,
    reason,
    order_id: orderId,
  });
  if (txError) throw txError;
}

export async function processFeedbackSubmission(
  orderId: string,
  userId: string,
  rating: number,
  comment?: string,
  structuredAnswers?: any,
) {
  // Get the order to find the restaurant_id via sessions -> tables
  const { data: order, error: orderError } = await (supabaseAdmin as any)
    .from("orders")
    .select("id, sessions!inner(tables!inner(restaurant_id))")
    .eq("id", orderId)
    .single();

  if (orderError || !order) throw orderError || new Error("Order not found");
  const restaurantId = (order as any).sessions?.tables?.restaurant_id;
  if (!restaurantId) throw new Error("Restaurant not found for order");

  // Check loyalty settings
  const { data: settings } = await (supabaseAdmin as any)
    .from("loyalty_settings")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  const isLoyaltyEnabled = settings && settings.enabled;
  let creditEarned = 0;

  if (isLoyaltyEnabled) {
    if (rating >= 1 && rating <= 5) {
      creditEarned += settings.points_for_rating || 0;
    }
    if (comment && comment.trim().length > 10) {
      creditEarned += settings.points_for_comment || 0;
    }
    if (structuredAnswers && typeof structuredAnswers === "object") {
      const answersCount = Object.keys(structuredAnswers).length;
      creditEarned += answersCount * (settings.points_for_question || 0);
    }
    // Cap total points awarded per order
    const MAX_POINTS_PER_ORDER = 500;
    creditEarned = Math.min(creditEarned, MAX_POINTS_PER_ORDER);
  }

  // 1. Insert feedback row
  const { error: feedbackError } = await (supabaseAdmin as any).from("feedback").insert({
    order_id: orderId,
    rating,
    comment: comment ?? null,
    structured_answers: structuredAnswers ?? null,
    credit_awarded: creditEarned, // Repurposing this column to store points awarded
  });

  if (feedbackError) {
    if (feedbackError.code === "23505") {
      throw new Error("409_CONFLICT");
    }
    throw feedbackError;
  }

  // 2. Add points transaction if earned
  if (isLoyaltyEnabled && creditEarned > 0) {
    let expiresAt = null;
    if (settings.points_expiry_days) {
      const date = new Date();
      date.setDate(date.getDate() + settings.points_expiry_days);
      expiresAt = date.toISOString();
    }

    await (supabaseAdmin as any).from("wallet_transactions").insert({
      user_id: userId,
      restaurant_id: restaurantId,
      amount: 0,
      points: creditEarned,
      reason: "Feedback reward",
      order_id: orderId,
      expires_at: expiresAt,
    });
  }

  // For the frontend to show value
  const pointsPerRupee = settings?.points_per_rupee || 0;

  return {
    creditEarned,
    pointsValue: creditEarned * pointsPerRupee,
    isLoyaltyEnabled,
  };
}
