# TableMind Server Function API Reference

This document catalogs every server function exposed by the TableMind application. All server functions are defined using TanStack Start's `createServerFn`, strictly validated with Zod, and executed on the server.

---

## 1. Diner Ordering & Session Functions

| Function Name | Auth Required | Input Schema Summary | Output | Rate Limit |
| :--- | :--- | :--- | :--- | :--- |
| `resolveTableFn` | None | `{ qrToken: string }` | Table metadata, restaurant branding, active session ID | 60 req / min |
| `joinSessionFn` | Diner Session | `{ qrToken: string, deviceToken: string, participantName?: string }` | Session participation record | 30 req / min |
| `fetchSessionParticipantsFn` | Diner Session | `{ qrToken: string }` | Array of active participants (name, device token, joined timestamp) | 60 req / min |
| `fetchCartFn` | Diner Session | `{ qrToken: string }` | Active order object and array of cart line items | 60 req / min |
| `addToCartFn` | Diner Session | `{ qrToken: string, menuItemId: string, qty: number, notes?: string, allergyOverrideAck?: boolean, deviceToken?: string }` | `{ orderId: string, requiresAllergyAck: boolean, message: string \| null }` | 60 req / min |
| `setLineQtyFn` | Diner Session | `{ qrToken: string, lineId: string, qty: number }` | `{ success: boolean }` | 60 req / min |
| `fetchBillFn` | Diner Session | `{ qrToken: string, orderId: string }` | Order breakdown (subtotal, tax, discounts, applied credits, total) and line items | 60 req / min |
| `getRecommendationsFn` | Diner Session | `{ qrToken: string }` | Up to 5 recommended menu items with personalized reason tags | 30 req / min |
| `createRazorpayOrderFn` | Diner Session | `{ qrToken: string, orderId: string }` | `{ order_id: string, amount: number, currency: "INR" }` | 15 req / min |
| `verifyRazorpayPaymentFn` | Diner Session | `{ qrToken: string, orderId: string, razorpay_order_id: string, razorpay_payment_id: string, razorpay_signature: string, guestEmail?: string }` | `{ success: boolean, receiptSent: boolean }` | 10 req / min |
| `payOrderFn` | Diner Session | `{ qrToken: string, orderId: string, guestEmail?: string }` | `{ success: boolean }` (allowed only for zero-total orders) | 10 req / min |
| `callWaiterFn` | Diner Session | `{ qrToken: string, callType: "waiter" \| "bill" \| "water" \| "assistance", notes?: string }` | `{ success: boolean, callId: string }` | 10 req / 5 min |
| `claimOrderFn` | Diner Account | `{ orderId: string }` | `{ success: boolean, pointsEarned: number }` | 10 req / min |

---

## 2. Voice & AI Functions

| Function Name | Auth Required | Input Schema Summary | Output | Rate Limit |
| :--- | :--- | :--- | :--- | :--- |
| `parseVoiceOrderFn` | Diner Session | `{ qrToken: string, transcript: string }` | `{ parsedItems: Array<{ menuItemId: string, name: string, qty: number, notes?: string }>, clarificationNeeded?: string }` | 20 req / min |

---

## 3. Promotions, Loyalty & Feedback Functions

| Function Name | Auth Required | Input Schema Summary | Output | Rate Limit |
| :--- | :--- | :--- | :--- | :--- |
| `fetchEligibleCouponsFn` | Diner Session | `{ qrToken: string, orderId: string }` | Array of eligible coupons with calculated discount amounts and best-offer recommendation | 30 req / min |
| `applyCouponFn` | Diner Session | `{ qrToken: string, orderId: string, couponCode: string }` | Updated order calculation with discount breakdown | 30 req / min |
| `getWalletBalanceFn` | Diner Account | `{}` | Current wallet points balance and transaction history | 60 req / min |
| `getLoyaltyDataFn` | Diner Session | `{ qrToken: string }` | Restaurant loyalty rules (points per rupee, minimum redemption threshold) | 60 req / min |
| `redeemPointsFn` | Diner Session | `{ qrToken: string, orderId: string, pointsToRedeem: number }` | Updated order with rupee discount applied | 20 req / min |
| `submitFeedbackFn` | None | `{ orderId: string, rating: number, dishRatings: Record<string, number>, comment?: string }` | `{ success: boolean, pointsAwarded: number }` | 10 req / min |
| `checkFeedbackExistsFn` | None | `{ orderId: string }` | `{ exists: boolean }` | 60 req / min |

---

## 4. Restaurant Owner Management Functions

| Function Name | Auth Required | Input Schema Summary | Output | Rate Limit |
| :--- | :--- | :--- | :--- | :--- |
| `getOwnerRestaurantFn` | Owner JWT | `{}` | Authenticated owner's restaurant profile, settings, and active tables | 60 req / min |
| `fetchLiveOrdersFn` | Owner JWT | `{ status?: string }` | Live order cards with customer details, item quantities, and timestamps | 60 req / min |
| `updateKitchenStatusFn` | Owner JWT | `{ orderId: string, status: "pending" \| "preparing" \| "served" \| "completed" }` | `{ success: boolean }` | 60 req / min |
| `getKitchenLoadFn` | Owner JWT | `{}` | Current open ticket count and load rating (`"low"` \| `"medium"` \| `"high"`) | 60 req / min |
| `forceCloseSessionFn` | Owner JWT | `{ sessionId: string }` | `{ success: boolean }` | 20 req / min |
| `fetchAdminTablesFn` | Owner JWT | `{}` | List of tables with QR tokens and active session statuses | 60 req / min |
| `createTableFn` | Owner JWT | `{ tableNumber: number, label: string, capacity?: number }` | Created table record with generated QR token | 20 req / min |
| `toggleTableFn` | Owner JWT | `{ tableId: string, isActive: boolean }` | Updated table record | 30 req / min |
| `regenerateQrTokenFn` | Owner JWT | `{ tableId: string }` | Table record with freshly generated cryptographically secure QR token | 10 req / min |
| `fetchAdminMenuFn` | Owner JWT | `{}` | Full menu catalog including soft-deleted items and categories | 60 req / min |
| `upsertMenuItemFn` | Owner JWT | `{ id?: string, name: string, category: string, price: number, allergens: string[], dietary_tags: string[], available: boolean, description?: string, image_url?: string }` | Saved menu item record | 30 req / min |
| `softDeleteMenuItemFn` | Owner JWT | `{ id: string }` | `{ success: boolean }` | 30 req / min |
| `updateBrandingFn` | Owner JWT | `{ name?: string, tagline?: string, logo_url?: string, banner_url?: string, primary_color?: string }` | Updated restaurant profile | 20 req / min |
| `fetchAdminCouponsFn` | Owner JWT | `{}` | All coupons created for the restaurant | 60 req / min |
| `createCouponFn` | Owner JWT | `{ code: string, discount_type: "flat" \| "percentage", discount_value: number, min_order_value?: number, max_discount?: number, start_time?: string, end_time?: string }` | Created coupon record | 20 req / min |
| `toggleCouponFn` | Owner JWT | `{ couponId: string, isActive: boolean }` | Updated coupon record | 30 req / min |
| `getLoyaltySettingsFn` | Owner JWT | `{}` | Restaurant loyalty configuration | 60 req / min |
| `updateLoyaltySettingsFn` | Owner JWT | `{ is_enabled: boolean, points_per_rupee: number, min_redeem_points: number, feedback_points: number }` | Updated loyalty configuration | 20 req / min |
| `fetchAdminWaiterCallsFn` | Owner JWT | `{}` | Active and pending waiter assistance requests | 60 req / min |
| `acknowledgeWaiterCallFn` | Owner JWT | `{ callId: string }` | `{ success: boolean }` | 60 req / min |
| `resolveWaiterCallFn` | Owner JWT | `{ callId: string }` | `{ success: boolean }` | 60 req / min |
| `fetchAnalyticsFn` | Owner JWT | `{ period: "day" \| "week" \| "month" }` | Revenue totals, order counts, average ticket size, and top-selling dishes | 30 req / min |
| `exportOrdersFn` | Owner JWT | `{ startDate?: string, endDate?: string }` | Formatted array of order records for CSV export | 10 req / min |
| `exportRevenueSummaryFn` | Owner JWT | `{ period: string }` | Daily/weekly revenue aggregations for CSV export | 10 req / min |
| `exportDishFeedbackFn` | Owner JWT | `{}` | Aggregated ratings and diner comments per dish for CSV export | 10 req / min |
| `exportCouponsFn` | Owner JWT | `{}` | Coupon redemption stats for CSV export | 10 req / min |

---

## 5. Security & Authentication Functions

| Function Name | Auth Required | Input Schema Summary | Output | Rate Limit |
| :--- | :--- | :--- | :--- | :--- |
| `registerRestaurantFn` | None | `{ name: string, email: string, password: string, tableCount: number }` | `{ restaurantId: string, ownerId: string }` | 5 req / hour |
| `generateAndSendOtpFn` | Owner JWT | `{ action: "password_change" \| "deactivate_account" \| "delete_account" }` | `{ success: boolean, message: string }` | 3 req / 10 min |
| `verifyOtpFn` | Owner JWT | `{ action: string, otp: string }` | `{ verified: boolean, verificationToken?: string }` | 5 attempts / 5 min |
| `changePasswordFn` | Owner JWT (OTP-gated) | `{ currentPassword: string, newPassword: string, verificationToken: string }` | `{ success: boolean }` | 5 req / hour |
| `deactivateAccountFn` | Owner JWT (OTP-gated) | `{ verificationToken: string }` | `{ success: boolean }` | 3 req / hour |
| `reactivateAccountFn` | None | `{ email: string, password: string }` | `{ success: boolean }` | 5 req / hour |
| `deleteAccountFn` | Owner JWT (OTP-gated) | `{ verificationToken: string }` | `{ success: boolean }` | 2 req / day |
