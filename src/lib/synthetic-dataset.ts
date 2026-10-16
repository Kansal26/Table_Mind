export type OrderStatus = "cart" | "paid" | "cancelled" | "refunded";
export type PaymentStatus = "paid" | "refunded" | "failed" | "pending" | "not_required";

export type RestaurantFixture = {
  id: string;
  name: string;
  city: string;
  active: boolean;
};

export type MenuItemFixture = {
  id: string;
  restaurant_id: string;
  name: string;
  price: number;
  category: string;
  active: boolean;
};

export type OrderRecord = {
  id: string;
  restaurant_id: string;
  table_label: string;
  ordered_at: string;
  status: OrderStatus;
  subtotal: number;
  discount_amount: number;
  tax: number;
  total: number;
  payment_status: PaymentStatus;
  isValid: boolean;
  invalidReason?: string;
};

export type OrderItemRecord = {
  id: string;
  order_id: string;
  menu_item_id: string;
  qty: number;
  unit_price: number;
  line_total: number;
};

export type PaymentRecord = {
  id: string;
  order_id: string;
  amount: number;
  method: "card" | "upi" | "cash";
  status: "settled" | "pending" | "failed";
  created_at: string;
};

export type RefundRecord = {
  id: string;
  order_id: string;
  amount: number;
  reason: string;
  created_at: string;
};

export type InvalidRecord = {
  id: string;
  table: "orders" | "payments" | "refunds";
  isValid: false;
  invalidReason: string;
  record: Record<string, unknown>;
};

export type SyntheticDataset = {
  metadata: {
    seed: number;
    purpose: string;
    localOnly: true;
    normalRecordCount: number;
    invalidRecordCount: number;
    generatedAt: string;
    notes: string[];
  };
  restaurants: RestaurantFixture[];
  menuItems: MenuItemFixture[];
  orders: OrderRecord[];
  orderItems: OrderItemRecord[];
  payments: PaymentRecord[];
  refunds: RefundRecord[];
  invalidRows: InvalidRecord[];
  summary: {
    validOrderCount: number;
    invalidOrderCount: number;
    totalGrossRevenue: number;
    totalRefunds: number;
    paidOrderCount: number;
    cancelledOrderCount: number;
  };
};

function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

function createDeterministicRng(seed: number) {
  let current = seed >>> 0;
  return () => {
    current = (1664525 * current + 1013904223) >>> 0;
    return current / 4294967296;
  };
}

export function createSyntheticDataset(): SyntheticDataset {
  const seed = 20250120;
  const rng = createDeterministicRng(seed);

  const restaurants: RestaurantFixture[] = [
    { id: "rest-1", name: "Olive & Ember", city: "Portland", active: true },
    { id: "rest-2", name: "Harbor Table", city: "Seattle", active: true },
    { id: "rest-3", name: "Saffron Lane", city: "Austin", active: true },
  ];

  const menuItems: MenuItemFixture[] = [
    {
      id: "mi-1",
      restaurant_id: "rest-1",
      name: "Sourdough & Butter",
      price: 7.5,
      category: "Starters",
      active: true,
    },
    {
      id: "mi-2",
      restaurant_id: "rest-1",
      name: "Burrata Toast",
      price: 13.0,
      category: "Starters",
      active: true,
    },
    {
      id: "mi-3",
      restaurant_id: "rest-1",
      name: "Lemon Chicken",
      price: 24.0,
      category: "Mains",
      active: true,
    },
    {
      id: "mi-4",
      restaurant_id: "rest-2",
      name: "Miso Greens",
      price: 9.0,
      category: "Starters",
      active: true,
    },
    {
      id: "mi-5",
      restaurant_id: "rest-2",
      name: "Salmon Bowl",
      price: 21.0,
      category: "Mains",
      active: true,
    },
    {
      id: "mi-6",
      restaurant_id: "rest-2",
      name: "Coconut Rice",
      price: 6.0,
      category: "Sides",
      active: true,
    },
    {
      id: "mi-7",
      restaurant_id: "rest-3",
      name: "Paneer Tikka",
      price: 16.0,
      category: "Starters",
      active: true,
    },
    {
      id: "mi-8",
      restaurant_id: "rest-3",
      name: "Cumin Lamb",
      price: 28.0,
      category: "Mains",
      active: true,
    },
  ];

  const orders: OrderRecord[] = [
    {
      id: "ord-1001",
      restaurant_id: "rest-1",
      table_label: "A1",
      ordered_at: "2025-01-08T18:10:00Z",
      status: "paid",
      subtotal: 84.25,
      discount_amount: 10.0,
      tax: 6.13,
      total: 80.38,
      payment_status: "paid",
      isValid: true,
    },
    {
      id: "ord-1002",
      restaurant_id: "rest-2",
      table_label: "B3",
      ordered_at: "2025-01-10T19:40:00Z",
      status: "paid",
      subtotal: 97.8,
      discount_amount: 5.0,
      tax: 7.96,
      total: 100.76,
      payment_status: "paid",
      isValid: true,
    },
    {
      id: "ord-1003",
      restaurant_id: "rest-1",
      table_label: "C2",
      ordered_at: "2025-01-12T13:05:00Z",
      status: "refunded",
      subtotal: 128.2,
      discount_amount: 0,
      tax: 10.98,
      total: 139.18,
      payment_status: "refunded",
      isValid: true,
    },
    {
      id: "ord-1004",
      restaurant_id: "rest-3",
      table_label: "D1",
      ordered_at: "2025-01-14T20:15:00Z",
      status: "cancelled",
      subtotal: 62.4,
      discount_amount: 0,
      tax: 0,
      total: 62.4,
      payment_status: "not_required",
      isValid: true,
    },
    {
      id: "ord-1005",
      restaurant_id: "rest-2",
      table_label: "E5",
      ordered_at: "2025-01-15T17:50:00Z",
      status: "paid",
      subtotal: 149.25,
      discount_amount: 15.0,
      tax: 11.33,
      total: 145.58,
      payment_status: "paid",
      isValid: true,
    },
    {
      id: "ord-1006",
      restaurant_id: "rest-3",
      table_label: "F2",
      ordered_at: "2025-01-16T12:25:00Z",
      status: "paid",
      subtotal: 73.55,
      discount_amount: 0,
      tax: 5.95,
      total: 79.5,
      payment_status: "paid",
      isValid: true,
    },
    {
      id: "ord-1007",
      restaurant_id: "rest-1",
      table_label: "G4",
      ordered_at: "2025-01-18T21:15:00Z",
      status: "paid",
      subtotal: 110.9,
      discount_amount: 8.0,
      tax: 8.77,
      total: 111.67,
      payment_status: "paid",
      isValid: true,
    },
    {
      id: "ord-1008",
      restaurant_id: "rest-2",
      table_label: "H6",
      ordered_at: "2025-01-19T18:00:00Z",
      status: "refunded",
      subtotal: 95.75,
      discount_amount: 0,
      tax: 8.16,
      total: 103.91,
      payment_status: "refunded",
      isValid: true,
    },
  ];

  const payments: PaymentRecord[] = [
    {
      id: "pay-1001",
      order_id: "ord-1001",
      amount: 80.38,
      method: "card",
      status: "settled",
      created_at: "2025-01-08T18:40:00Z",
    },
    {
      id: "pay-1002",
      order_id: "ord-1002",
      amount: 100.76,
      method: "upi",
      status: "settled",
      created_at: "2025-01-10T20:00:00Z",
    },
    {
      id: "pay-1003",
      order_id: "ord-1003",
      amount: 139.18,
      method: "card",
      status: "settled",
      created_at: "2025-01-12T13:40:00Z",
    },
    {
      id: "pay-1005",
      order_id: "ord-1005",
      amount: 145.58,
      method: "card",
      status: "settled",
      created_at: "2025-01-15T18:10:00Z",
    },
    {
      id: "pay-1006",
      order_id: "ord-1006",
      amount: 79.5,
      method: "cash",
      status: "settled",
      created_at: "2025-01-16T12:50:00Z",
    },
    {
      id: "pay-1007",
      order_id: "ord-1007",
      amount: 111.67,
      method: "upi",
      status: "settled",
      created_at: "2025-01-18T21:40:00Z",
    },
    {
      id: "pay-1008",
      order_id: "ord-1008",
      amount: 103.91,
      method: "card",
      status: "settled",
      created_at: "2025-01-19T18:25:00Z",
    },
  ];

  const refunds: RefundRecord[] = [
    {
      id: "ref-1003",
      order_id: "ord-1003",
      amount: 54.3,
      reason: "customer_requested",
      created_at: "2025-01-13T09:15:00Z",
    },
    {
      id: "ref-1008",
      order_id: "ord-1008",
      amount: 28.4,
      reason: "quality_issue",
      created_at: "2025-01-20T10:10:00Z",
    },
  ];

  const orderItems: OrderItemRecord[] = [
    {
      id: "li-1001",
      order_id: "ord-1001",
      menu_item_id: "mi-1",
      qty: 2,
      unit_price: 7.5,
      line_total: 15.0,
    },
    {
      id: "li-1002",
      order_id: "ord-1001",
      menu_item_id: "mi-3",
      qty: 2,
      unit_price: 24.0,
      line_total: 48.0,
    },
    {
      id: "li-1003",
      order_id: "ord-1001",
      menu_item_id: "mi-2",
      qty: 1,
      unit_price: 13.0,
      line_total: 13.0,
    },
    {
      id: "li-1004",
      order_id: "ord-1002",
      menu_item_id: "mi-4",
      qty: 2,
      unit_price: 9.0,
      line_total: 18.0,
    },
    {
      id: "li-1005",
      order_id: "ord-1002",
      menu_item_id: "mi-5",
      qty: 2,
      unit_price: 21.0,
      line_total: 42.0,
    },
    {
      id: "li-1006",
      order_id: "ord-1002",
      menu_item_id: "mi-6",
      qty: 4,
      unit_price: 6.0,
      line_total: 24.0,
    },
    {
      id: "li-1007",
      order_id: "ord-1003",
      menu_item_id: "mi-1",
      qty: 1,
      unit_price: 7.5,
      line_total: 7.5,
    },
    {
      id: "li-1008",
      order_id: "ord-1003",
      menu_item_id: "mi-3",
      qty: 3,
      unit_price: 24.0,
      line_total: 72.0,
    },
    {
      id: "li-1009",
      order_id: "ord-1003",
      menu_item_id: "mi-2",
      qty: 2,
      unit_price: 13.0,
      line_total: 26.0,
    },
    {
      id: "li-1010",
      order_id: "ord-1004",
      menu_item_id: "mi-7",
      qty: 2,
      unit_price: 16.0,
      line_total: 32.0,
    },
    {
      id: "li-1011",
      order_id: "ord-1004",
      menu_item_id: "mi-8",
      qty: 1,
      unit_price: 28.0,
      line_total: 28.0,
    },
    {
      id: "li-1012",
      order_id: "ord-1005",
      menu_item_id: "mi-4",
      qty: 3,
      unit_price: 9.0,
      line_total: 27.0,
    },
    {
      id: "li-1013",
      order_id: "ord-1005",
      menu_item_id: "mi-5",
      qty: 3,
      unit_price: 21.0,
      line_total: 63.0,
    },
    {
      id: "li-1014",
      order_id: "ord-1005",
      menu_item_id: "mi-6",
      qty: 2,
      unit_price: 6.0,
      line_total: 12.0,
    },
    {
      id: "li-1015",
      order_id: "ord-1006",
      menu_item_id: "mi-7",
      qty: 2,
      unit_price: 16.0,
      line_total: 32.0,
    },
    {
      id: "li-1016",
      order_id: "ord-1006",
      menu_item_id: "mi-8",
      qty: 1,
      unit_price: 28.0,
      line_total: 28.0,
    },
    {
      id: "li-1017",
      order_id: "ord-1007",
      menu_item_id: "mi-2",
      qty: 2,
      unit_price: 13.0,
      line_total: 26.0,
    },
    {
      id: "li-1018",
      order_id: "ord-1007",
      menu_item_id: "mi-3",
      qty: 2,
      unit_price: 24.0,
      line_total: 48.0,
    },
    {
      id: "li-1019",
      order_id: "ord-1007",
      menu_item_id: "mi-1",
      qty: 3,
      unit_price: 7.5,
      line_total: 22.5,
    },
    {
      id: "li-1020",
      order_id: "ord-1008",
      menu_item_id: "mi-4",
      qty: 2,
      unit_price: 9.0,
      line_total: 18.0,
    },
    {
      id: "li-1021",
      order_id: "ord-1008",
      menu_item_id: "mi-5",
      qty: 2,
      unit_price: 21.0,
      line_total: 42.0,
    },
    {
      id: "li-1022",
      order_id: "ord-1008",
      menu_item_id: "mi-6",
      qty: 2,
      unit_price: 6.0,
      line_total: 12.0,
    },
  ];

  const invalidRows: InvalidRecord[] = [
    {
      id: "bad-1",
      table: "orders",
      isValid: false,
      invalidReason: "negative subtotal",
      record: {
        id: "ord-invalid-1",
        restaurant_id: "rest-1",
        ordered_at: "2025-01-08T18:00:00Z",
        status: "paid",
        subtotal: -10,
        discount_amount: 0,
        tax: 1.2,
        total: 0.5,
      },
    },
    {
      id: "bad-2",
      table: "orders",
      isValid: false,
      invalidReason: "tax exceeds subtotal",
      record: {
        id: "ord-invalid-2",
        restaurant_id: "rest-2",
        ordered_at: "2025-01-10T18:00:00Z",
        status: "paid",
        subtotal: 50,
        discount_amount: 0,
        tax: 75,
        total: 125,
      },
    },
    {
      id: "bad-3",
      table: "refunds",
      isValid: false,
      invalidReason: "refund without payment",
      record: {
        id: "ref-invalid-3",
        order_id: "ord-invalid-3",
        amount: 25,
        reason: "duplicate refund",
        created_at: "2025-01-11T10:00:00Z",
      },
    },
    {
      id: "bad-4",
      table: "orders",
      isValid: false,
      invalidReason: "future-dated order",
      record: {
        id: "ord-invalid-4",
        restaurant_id: "rest-3",
        ordered_at: "2099-01-18T18:00:00Z",
        status: "paid",
        subtotal: 45,
        discount_amount: 0,
        tax: 3.5,
        total: 48.5,
      },
    },
  ];

  const validOrderCount = orders.length;
  const invalidOrderCount = invalidRows.length;
  const totalGrossRevenue = roundCurrency(
    orders.filter((o) => o.status !== "cancelled").reduce((sum, order) => sum + order.total, 0),
  );
  const totalRefunds = roundCurrency(refunds.reduce((sum, refund) => sum + refund.amount, 0));

  return {
    metadata: {
      seed,
      purpose: "Deterministic fixture for analytics and data-quality validation.",
      localOnly: true,
      normalRecordCount: orders.length,
      invalidRecordCount: invalidRows.length,
      generatedAt: "2025-01-22T00:00:00Z",
      notes: [
        "All records are local fixtures and are never written to a production database.",
        "Normal and invalid records are intentionally separated by the isValid/invalidReason fields.",
        "Expected totals are specified independently in tests and not derived from production logic.",
      ],
    },
    restaurants,
    menuItems,
    orders,
    orderItems,
    payments,
    refunds,
    invalidRows,
    summary: {
      validOrderCount: validOrderCount,
      invalidOrderCount: invalidOrderCount,
      totalGrossRevenue,
      totalRefunds,
      paidOrderCount: orders.filter((o) => o.status === "paid").length,
      cancelledOrderCount: orders.filter((o) => o.status === "cancelled").length,
    },
  };
}

export const syntheticDataset = createSyntheticDataset();
