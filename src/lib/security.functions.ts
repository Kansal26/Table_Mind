import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyAdminAuth } from "./auth.server";
import { rateLimit } from "./rate-limit.server";
import { consumeVerifiedOtp } from "./otp.functions";

export const changePasswordFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        token: z.string(),
        newPassword: z.string().min(6).max(100),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await verifyAdminAuth(data.token);
    await consumeVerifiedOtp(user.id, "change_password");
    rateLimit(user.id, "change_password", 5, 60 * 60 * 1000);

    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: data.newPassword,
    });

    if (error) {
      console.error("[changePasswordFn] Error updating password:", error);
      throw new Error(`Failed to update password: ${error.message}`);
    }

    return { success: true };
  });

export const deactivateAccountFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ token: z.string() }).parse(data))
  .handler(async ({ data }) => {
    const user = await verifyAdminAuth(data.token);
    await consumeVerifiedOtp(user.id, "deactivate_account");
    rateLimit(user.id, "deactivate_account", 5, 24 * 60 * 60 * 1000);

    const { error } = await supabaseAdmin
      .from("restaurants")
      .update({ is_active: false, deactivated_at: new Date().toISOString() })
      .eq("owner_id", user.id);

    if (error) throw error;
    return { success: true };
  });

export const reactivateAccountFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ token: z.string() }).parse(data))
  .handler(async ({ data }) => {
    const user = await verifyAdminAuth(data.token);
    await consumeVerifiedOtp(user.id, "reactivate_account");
    rateLimit(user.id, "reactivate_account", 5, 24 * 60 * 60 * 1000);

    const { error } = await supabaseAdmin
      .from("restaurants")
      .update({ is_active: true, deactivated_at: null })
      .eq("owner_id", user.id);

    if (error) throw error;
    return { success: true };
  });

export const deleteAccountFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ token: z.string() }).parse(data))
  .handler(async ({ data }) => {
    const user = await verifyAdminAuth(data.token);
    await consumeVerifiedOtp(user.id, "delete_account");
    rateLimit(user.id, "delete_account", 3, 24 * 60 * 60 * 1000);

    // Call the Postgres RPC function to atomically delete all restaurant data
    const { error: rpcError } = await supabaseAdmin.rpc("delete_restaurant_account", {
      owner_id_param: user.id,
    });

    if (rpcError) {
      console.error("[deleteAccountFn] RPC Error:", rpcError);
      throw new Error(`Database Error: ${rpcError.message}`);
    }

    // Delete user from auth.users via Supabase Admin API
    const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (deleteUserError) {
      console.warn(
        "[deleteAccountFn] Supabase Auth threw an error, but account was likely deleted:",
        deleteUserError,
      );
      // We don't throw here because GoTrue sometimes throws 500 / AuthRetryableFetchError
      // even when the user is successfully deleted. Since the RPC already succeeded,
      // the restaurant data is completely gone.
    }

    return { success: true };
  });
