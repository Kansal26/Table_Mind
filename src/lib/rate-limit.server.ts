import { getRequest } from "@tanstack/react-start/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Fallback in-memory store in case of RPC failure or local offline environment
const memoryFallback = new Map<string, { count: number; resetAt: number }>();

/**
 * Resolves the client identifier:
 * - User ID when signed in
 * - Otherwise device token + cf-connecting-ip (falling back to x-forwarded-for)
 */
export function getClientIdentifier(opts?: {
  userId?: string | null | undefined;
  deviceToken?: string | null | undefined;
}): string {
  if (opts?.userId) {
    return `user:${opts.userId}`;
  }

  let ip = "unknown";
  try {
    const req = getRequest();
    if (req) {
      ip =
        req.headers.get("cf-connecting-ip")?.trim() ||
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip")?.trim() ||
        "unknown";
    }
  } catch {
    // Ignore context errors outside server handler
  }

  const device = opts?.deviceToken?.trim() || "guest";
  return `device:${device}:ip:${ip}`;
}

/**
 * Postgres-backed rate limiter using the atomic check_rate_limit RPC.
 * Throws 429 when the limit is exceeded.
 */
export async function rateLimit(
  identifier: string,
  action: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const key = `${action}:${identifier}`;
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  try {
    const { data: allowed, error } = await supabaseAdmin.rpc("check_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      // Fallback to in-memory if DB table/RPC is not yet migrated in current runtime
      return runMemoryFallback(key, limit, windowMs);
    }

    if (allowed === false) {
      throw new Error("429: Too Many Requests. Please try again later.");
    }
  } catch (err: any) {
    if (err.message?.startsWith("429:")) {
      throw err;
    }
    // Fallback gracefully on RPC connectivity issues
    return runMemoryFallback(key, limit, windowMs);
  }
}

function runMemoryFallback(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const record = memoryFallback.get(key);

  if (record) {
    if (now > record.resetAt) {
      memoryFallback.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      if (record.count >= limit) {
        throw new Error("429: Too Many Requests. Please try again later.");
      }
      record.count += 1;
    }
  } else {
    memoryFallback.set(key, { count: 1, resetAt: now + windowMs });
  }
}
