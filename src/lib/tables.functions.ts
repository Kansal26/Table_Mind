import crypto from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireRestaurantOwnership } from "./auth.server";
import { rateLimit } from "./rate-limit.server";

export const fetchAdminTablesFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ token: z.string(), restaurantId: z.string().uuid() }).parse(data),
  )
  .handler(async ({ data }) => {
    await requireRestaurantOwnership(data.token, data.restaurantId);

    const { data: tables, error } = await supabaseAdmin
      .from("tables")
      .select("*")
      .eq("restaurant_id", data.restaurantId)
      .order("label", { ascending: true });

    if (error) throw error;
    return tables || [];
  });

export const toggleTableFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ token: z.string(), tableId: z.string().uuid(), is_active: z.boolean() }).parse(data),
  )
  .handler(async ({ data }) => {
    // Need to verify ownership
    const { data: table } = await supabaseAdmin
      .from("tables")
      .select("restaurant_id")
      .eq("id", data.tableId)
      .single();
    if (!table) throw new Error("Table not found");
    const user = await requireRestaurantOwnership(data.token, table.restaurant_id);
    rateLimit(user.id, "toggleTable", 200, 15 * 60 * 1000);

    const { error } = await supabaseAdmin
      .from("tables")
      .update({ is_active: data.is_active })
      .eq("id", data.tableId);
    if (error) throw error;
    return { ok: true };
  });

export const createTableFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        token: z.string(),
        restaurantId: z.string().uuid(),
        label: z.string().min(1),
        seat_count: z.number().min(1),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await requireRestaurantOwnership(data.token, data.restaurantId);
    const qrToken = crypto.randomBytes(16).toString("base64url");

    const { error } = await supabaseAdmin.from("tables").insert({
      restaurant_id: data.restaurantId,
      label: data.label,
      seat_count: data.seat_count,
      qr_token: qrToken,
      is_active: true,
    });

    if (error) throw error;
    return { ok: true, qrToken };
  });

export const regenerateQrTokenFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ token: z.string(), tableId: z.string().uuid() }).parse(data),
  )
  .handler(async ({ data }) => {
    const { data: table } = await supabaseAdmin
      .from("tables")
      .select("restaurant_id")
      .eq("id", data.tableId)
      .single();
    if (!table) throw new Error("Table not found");
    const user = await requireRestaurantOwnership(data.token, table.restaurant_id);
    await rateLimit(user.id, "regenerateQrToken", 50, 15 * 60 * 1000);

    const newQrToken = crypto.randomBytes(16).toString("base64url");
    const { error } = await supabaseAdmin
      .from("tables")
      .update({ qr_token: newQrToken })
      .eq("id", data.tableId);

    if (error) throw error;
    return { ok: true, qrToken: newQrToken };
  });
