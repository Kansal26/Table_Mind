import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyAdminAuth } from "./auth.server";
import { rateLimit } from "./rate-limit.server";
import { Resend } from "resend";
import { emailLayout, otpEmailHtml, getEmailFrom } from "./email.server";

const resend = process.env["RESEND_API_KEY"] ? new Resend(process.env["RESEND_API_KEY"]) : null;

// SHA-256 is sufficient for short-lived, rate-limited 6-digit OTPs
function hashOtp(code: string, salt: string): string {
  // Salt the OTP to prevent precomputed rainbow tables
  const payload = `${code}${salt}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function generateRandomCode(): string {
  // Use crypto.randomInt for cryptographically secure 6-digit OTPs
  return crypto.randomInt(100000, 1000000).toString();
}

async function sendOtpEmail(email: string, purpose: string, code: string) {
  if (!resend) {
    console.warn("OTP generated but RESEND_API_KEY not configured:", code);
    return;
  }

  let subject = "Your Verification Code";
  let heading = "Your Verification Code";
  let message = "Use the following code to verify your action.";
  let accentColor = "#1A2E4A";
  let warningText: string | undefined = undefined;

  switch (purpose) {
    case "change_password":
      subject = "Confirm your password change";
      heading = "Confirm your password change";
      message = "Enter this code to confirm you'd like to change your TableMind account password.";
      accentColor = "#1A2E4A";
      warningText =
        "If you didn't request this, you can safely ignore this email — your password won't be changed.";
      break;
    case "deactivate_account":
      subject = "Confirm account deactivation";
      heading = "Confirm account deactivation";
      message =
        "Enter this code to deactivate your restaurant account. Your QR codes will show as temporarily unavailable to customers until you sign back in to reactivate.";
      accentColor = "#C9622A";
      warningText =
        "If you didn't request this, ignore this email and consider changing your password.";
      break;
    case "delete_account":
      subject = "Confirm account deletion — this cannot be undone";
      heading = "Confirm permanent account deletion";
      message =
        "Enter this code to permanently delete your TableMind account, restaurant, menu, and all order history. This action cannot be undone.";
      accentColor = "#C0392B";
      warningText =
        "This will permanently erase all data with no recovery option. If you didn't request this, ignore this email immediately and change your password.";
      break;
    case "reactivate_account":
      subject = "Verify to reactivate your account";
      heading = "Welcome back";
      message =
        "It looks like your account was deactivated. Enter this code to reactivate your restaurant and dashboard access.";
      accentColor = "#0D7377";
      break;
  }

  const bodyHtml = otpEmailHtml({
    heading,
    message,
    code,
    accentColor,
    ...(warningText ? { warningText } : {}),
  });
  const html = emailLayout({
    previewText: subject,
    accentColor: accentColor,
    bodyHtml,
  });

  await resend.emails.send({
    from: getEmailFrom(),
    to: email,
    subject,
    html,
  });
}

export const generateAndSendOtpFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        token: z.string(),
        purpose: z.enum([
          "change_password",
          "delete_account",
          "deactivate_account",
          "reactivate_account",
        ]),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await verifyAdminAuth(data.token);

    // Rate limit: max 3 OTP requests per user per purpose per hour
    await rateLimit(user.id, `otp_${data.purpose}`, 3, 60 * 60 * 1000);

    // Invalidate previous unused OTPs for this purpose
    await supabaseAdmin
      .from("otp_verifications")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("purpose", data.purpose)
      .is("used_at", null);

    const code = generateRandomCode();
    const salt = crypto.randomBytes(16).toString("hex");
    const codeHash = hashOtp(code, salt);

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 10);

    const { error: insertError } = await supabaseAdmin.from("otp_verifications").insert({
      user_id: user.id,
      purpose: data.purpose,
      code_hash: codeHash,
      salt: salt,
      expires_at: expiresAt.toISOString(),
    });

    if (insertError) throw new Error("Failed to create OTP record");

    const userEmail = user.email;
    if (!userEmail) throw new Error("User has no email associated");

    await sendOtpEmail(userEmail, data.purpose, code);

    return { ok: true };
  });

export const verifyOtpFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        token: z.string(),
        purpose: z.enum([
          "change_password",
          "delete_account",
          "deactivate_account",
          "reactivate_account",
        ]),
        code: z.string().length(6),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await verifyAdminAuth(data.token);

    // Rate limit: max 10 verify attempts per user per 15 minutes
    await rateLimit(user.id, `verify_otp_${data.purpose}`, 10, 15 * 60 * 1000);

    // Find the most recent unconsumed, unused OTP for this user+purpose
    const { data: otps, error } = await supabaseAdmin
      .from("otp_verifications")
      .select("*")
      .eq("user_id", user.id)
      .eq("purpose", data.purpose)
      .is("used_at", null)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !otps || otps.length === 0 || !otps[0]) {
      return {
        verified: false,
        attemptsRemaining: 0,
        error: "No active OTP found. Please request a new one.",
      };
    }

    const otp = otps[0];

    if (new Date(otp.expires_at) < new Date()) {
      return {
        verified: false,
        attemptsRemaining: 0,
        error: "OTP expired. Please request a new one.",
      };
    }

    if (otp.attempts >= otp.max_attempts) {
      // Already maxed out, invalidate it
      await supabaseAdmin
        .from("otp_verifications")
        .update({ used_at: new Date().toISOString() })
        .eq("id", otp.id);
      return {
        verified: false,
        attemptsRemaining: 0,
        error: "Too many attempts. Please request a new OTP.",
      };
    }

    // Atomically increment attempts to prevent parallel guess races
    let newAttempts = otp.attempts + 1;
    const rpcRes = await supabaseAdmin.rpc("increment_otp_attempts", {
      p_otp_id: otp.id,
    });
    if (rpcRes && !rpcRes.error && typeof rpcRes.data === "number") {
      newAttempts = rpcRes.data;
    } else {
      await supabaseAdmin
        .from("otp_verifications")
        .update({ attempts: newAttempts })
        .eq("id", otp.id);
    }

    if (newAttempts > otp.max_attempts) {
      await supabaseAdmin
        .from("otp_verifications")
        .update({ used_at: new Date().toISOString() })
        .eq("id", otp.id);
      return {
        verified: false,
        attemptsRemaining: 0,
        error: "Too many attempts. Please request a new OTP.",
      };
    }

    // Compare code hashes using constant-time comparison to prevent timing attacks
    const codeHash = hashOtp(data.code, otp.salt);
    const hashBuffer = Buffer.from(codeHash, "hex");
    const expectedBuffer = Buffer.from(otp.code_hash, "hex");

    const matches =
      hashBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(hashBuffer, expectedBuffer);

    if (!matches) {
      const remaining = otp.max_attempts - newAttempts;
      if (remaining <= 0) {
        // Invalidate on hitting max attempts
        await supabaseAdmin
          .from("otp_verifications")
          .update({ used_at: new Date().toISOString() })
          .eq("id", otp.id);
        return {
          verified: false,
          attemptsRemaining: 0,
          error: "Too many attempts. Please request a new OTP.",
        };
      }
      return { verified: false, attemptsRemaining: remaining, error: "Incorrect code." };
    }

    // Success: mark as verified_at (do NOT burn with used_at or consumed_at yet)
    await supabaseAdmin
      .from("otp_verifications")
      .update({ verified_at: new Date().toISOString() })
      .eq("id", otp.id);

    return { verified: true };
  });

/**
 * Server-side helper to ensure an OTP was verified within the last 5 minutes
 * and has not already been consumed. Atomically consumes it.
 * Throws 403 if missing, expired, or already consumed.
 */
export async function consumeVerifiedOtp(userId: string, purpose: string): Promise<void> {
  // 1. Try atomic Postgres function if migration has been executed
  const { data: rpcSuccess, error: rpcError } = await supabaseAdmin.rpc("consume_verified_otp", {
    p_user_id: userId,
    p_purpose: purpose,
  });

  if (!rpcError && typeof rpcSuccess === "boolean") {
    if (!rpcSuccess) {
      throw new Error("403: Forbidden. Validated OTP required. Please verify an OTP first.");
    }
    return;
  }

  // 2. Fallback to atomic select-then-conditional-update query
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: rows, error: selectErr } = await supabaseAdmin
    .from("otp_verifications")
    .select("id")
    .eq("user_id", userId)
    .eq("purpose", purpose)
    .is("consumed_at", null)
    .is("used_at", null)
    .gte("verified_at", fiveMinutesAgo)
    .order("verified_at", { ascending: false })
    .limit(1);

  const target = rows?.[0];
  if (selectErr || !target) {
    throw new Error("403: Forbidden. Validated OTP required. Please verify an OTP first.");
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("otp_verifications")
    .update({
      consumed_at: new Date().toISOString(),
      used_at: new Date().toISOString(),
    })
    .eq("id", target.id)
    .is("consumed_at", null)
    .select("id")
    .single();

  if (updateErr || !updated) {
    throw new Error("403: Forbidden. Validated OTP required. Please verify an OTP first.");
  }
}
