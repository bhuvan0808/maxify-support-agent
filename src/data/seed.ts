/**
 * Fictional seed data: products (some on sale), customers, guest shoppers, orders
 * and a little refund history.
 *
 * Order dates are stored as "days ago" and turned into real timestamps when the
 * database is seeded. That keeps the interesting cases (delivered exactly 30 days
 * ago, 31 days ago, still processing...) true on whatever day the agent is tested.
 * `npm run reset` re-seeds relative to now; `npm run data` prints the current state.
 *
 * Each order's comment says what it is there to exercise.
 */

import type { ReturnReason } from "../core/types.ts";

export interface SeedProduct {
  sku: string;
  name: string;
  category: string;
  priceCents: number;
  salePriceCents: number | null;
  hygiene: boolean;
  description: string;
  sizes: string[];
  colours: string[];
  /** Variants that are out of stock, as "size|colour". Everything else has 12 units. */
  outOfStock?: string[];
}

export const PRODUCTS: SeedProduct[] = [
  {
    sku: "TS-LIN-01",
    name: "Breezy Linen Shirt",
    category: "tops",
    priceCents: 6900,
    salePriceCents: null,
    hygiene: false,
    description: "Relaxed-fit pure linen shirt, breathable for humid weather.",
    sizes: ["S", "M", "L", "XL"],
    colours: ["White", "Sage"],
  },
  {
    sku: "TS-TEE-02",
    name: "Everyday Cotton Tee",
    category: "tops",
    priceCents: 2990,
    salePriceCents: null,
    hygiene: false,
    description: "Mid-weight organic cotton crew-neck tee.",
    sizes: ["XS", "S", "M", "L", "XL"],
    colours: ["Black", "White", "Navy"],
  },
  {
    sku: "TS-JKT-03",
    name: "Monsoon Rain Jacket",
    category: "outerwear",
    priceCents: 14900,
    salePriceCents: 10430,
    hygiene: false,
    description: "Packable waterproof shell with taped seams. On sale: 30% off.",
    sizes: ["S", "M", "L", "XL"],
    colours: ["Navy", "Olive"],
    outOfStock: ["XL|Navy"],
  },
  {
    sku: "TS-DRS-04",
    name: "Orchid Wrap Dress",
    category: "dresses",
    priceCents: 11900,
    salePriceCents: null,
    hygiene: false,
    description: "Midi wrap dress in soft viscose with an orchid print.",
    sizes: ["XS", "S", "M", "L"],
    colours: ["Terracotta", "Ink"],
  },
  {
    sku: "TS-CHN-05",
    name: "Tailored Chino Trousers",
    category: "bottoms",
    priceCents: 8900,
    salePriceCents: 6230,
    hygiene: false,
    description: "Slim-tapered stretch cotton chinos. On sale: 30% off.",
    sizes: ["30", "32", "34", "36"],
    colours: ["Khaki", "Navy"],
    outOfStock: ["36|Khaki"],
  },
  {
    sku: "TS-SHO-06",
    name: "Canvas Low Sneakers",
    category: "footwear",
    priceCents: 9900,
    salePriceCents: null,
    hygiene: false,
    description: "Classic low-top canvas sneakers with a cushioned insole. EU sizing.",
    sizes: ["38", "39", "40", "41", "42", "43", "44"],
    colours: ["White", "Black"],
    outOfStock: ["44|White"],
  },
  {
    sku: "TS-BLZ-07",
    name: "Heritage Wool Blazer",
    category: "outerwear",
    priceCents: 32900,
    salePriceCents: null,
    hygiene: false,
    description: "Half-lined tropical-weight wool blazer.",
    sizes: ["36", "38", "40", "42"],
    colours: ["Charcoal", "Navy"],
  },
  {
    sku: "TS-SOC-08",
    name: "Bamboo Crew Socks (3-pack)",
    category: "accessories",
    priceCents: 1990,
    salePriceCents: null,
    hygiene: true,
    description: "Soft bamboo-blend crew socks. Hygiene item.",
    sizes: ["One Size"],
    colours: ["Mixed"],
  },
  {
    sku: "TS-BRF-09",
    name: "Cotton Boxer Briefs (2-pack)",
    category: "intimates",
    priceCents: 3500,
    salePriceCents: 2450,
    hygiene: true,
    description: "Stretch cotton boxer briefs. Hygiene item. On sale: 30% off.",
    sizes: ["S", "M", "L", "XL"],
    colours: ["Black", "Grey"],
  },
  {
    sku: "TS-CAP-10",
    name: "Batik Print Cap",
    category: "accessories",
    priceCents: 3900,
    salePriceCents: 2730,
    hygiene: false,
    description: "Six-panel cap with a batik-inspired print. On sale: 30% off.",
    sizes: ["One Size"],
    colours: ["Indigo", "Rust"],
  },
  {
    sku: "TS-KNT-11",
    name: "Merino Knit Sweater",
    category: "tops",
    priceCents: 13900,
    salePriceCents: null,
    hygiene: false,
    description: "Fine-gauge merino crew-neck for air-conditioned offices.",
    sizes: ["S", "M", "L", "XL"],
    colours: ["Charcoal", "Oat"],
  },
  {
    sku: "TS-SWM-12",
    name: "Reef Swim Shorts",
    category: "swimwear",
    priceCents: 5900,
    salePriceCents: null,
    hygiene: true,
    description: "Quick-dry swim shorts with a mesh lining. Hygiene item.",
    sizes: ["S", "M", "L", "XL"],
    colours: ["Teal", "Coral"],
  },
];

export interface SeedCustomer {
  id: string;
  name: string;
  email: string;
  /** Why this customer exists in the data set. */
  note: string;
}

export const CUSTOMERS: SeedCustomer[] = [
  { id: "C001", name: "Aisha Rahman", email: "aisha.rahman@example.com", note: "Regular customer, clean history." },
  { id: "C002", name: "Wei Jie Tan", email: "weijie.tan@example.com", note: "Bought sale items." },
  { id: "C003", name: "Priya Nair", email: "priya.nair@example.com", note: "High-value order and hygiene items." },
  { id: "C004", name: "Marcus Lim", email: "marcus.lim@example.com", note: "Refunded 4 of 5 past orders: high risk." },
  { id: "C005", name: "Hannah Koh", email: "hannah.koh@example.com", note: "New customer with an unshipped order." },
  { id: "C006", name: "Daniel Ong", email: "daniel.ong@example.com", note: "Two recent defect refunds: elevated risk." },
];

/** Guests have no account: they are identified by the email used at checkout. */
export const GUEST_EMAILS = ["guest.lee@example.com", "farah.guest@example.com"];

export interface SeedLine {
  sku: string;
  size: string;
  colour: string;
  qty: number;
  unitPaidCents: number;
  onSale: boolean;
}

export interface SeedOrder {
  id: string;
  customerId?: string;
  guestEmail?: string;
  status: "processing" | "shipped" | "delivered";
  placedDaysAgo: number;
  shippedDaysAgo?: number;
  deliveredDaysAgo?: number;
  shippingCents: number;
  paymentMethod: string;
  lines: SeedLine[];
  /** A refund that already happened before the agent existed (builds risk history). */
  pastRefund?: { reason: ReturnReason; daysAfterDelivery: number };
  note: string;
}

const line = (sku: string, size: string, colour: string, unitPaidCents: number, onSale = false, qty = 1): SeedLine => ({
  sku,
  size,
  colour,
  qty,
  unitPaidCents,
  onSale,
});

export const ORDERS: SeedOrder[] = [
  // --- C001 Aisha: the policy edges ---------------------------------------------------
  {
    id: "ORD-1001",
    customerId: "C001",
    status: "delivered",
    placedDaysAgo: 8,
    shippedDaysAgo: 7,
    deliveredDaysAgo: 5,
    shippingCents: 0,
    paymentMethod: "Visa ending 4242",
    lines: [line("TS-LIN-01", "M", "White", 6900), line("TS-TEE-02", "M", "Black", 2990)],
    note: "Full-price, inside the window: straightforward refund. Two items, so 'refund my order' is ambiguous.",
  },
  {
    id: "ORD-1002",
    customerId: "C001",
    status: "delivered",
    placedDaysAgo: 33,
    shippedDaysAgo: 32,
    deliveredDaysAgo: 30,
    shippingCents: 0,
    paymentMethod: "Visa ending 4242",
    lines: [line("TS-SHO-06", "42", "White", 9900)],
    note: "Delivered exactly 30 days ago: last day of the return window (allowed).",
  },
  {
    id: "ORD-1003",
    customerId: "C001",
    status: "delivered",
    placedDaysAgo: 34,
    shippedDaysAgo: 33,
    deliveredDaysAgo: 31,
    shippingCents: 0,
    paymentMethod: "Visa ending 4242",
    lines: [line("TS-DRS-04", "M", "Terracotta", 11900)],
    note: "Delivered 31 days ago: one day outside the window (denied unless faulty).",
  },
  {
    id: "ORD-1004",
    customerId: "C001",
    status: "processing",
    placedDaysAgo: 1,
    shippingCents: 0,
    paymentMethod: "Visa ending 4242",
    lines: [line("TS-KNT-11", "L", "Charcoal", 13900)],
    note: "Not shipped yet: can be cancelled.",
  },

  // --- C002 Wei Jie: sale items -------------------------------------------------------
  {
    id: "ORD-1005",
    customerId: "C002",
    status: "delivered",
    placedDaysAgo: 11,
    shippedDaysAgo: 10,
    deliveredDaysAgo: 8,
    shippingCents: 0,
    paymentMethod: "Mastercard ending 5599",
    lines: [line("TS-JKT-03", "L", "Navy", 10430, true), line("TS-CAP-10", "One Size", "Indigo", 2730, true)],
    note: "Two sale items: exchange only. Faulty cap is under the fast-track limit; faulty jacket needs human verification.",
  },
  {
    id: "ORD-1006",
    customerId: "C002",
    status: "shipped",
    placedDaysAgo: 3,
    shippedDaysAgo: 2,
    shippingCents: 500,
    paymentMethod: "Mastercard ending 5599",
    lines: [line("TS-CHN-05", "32", "Khaki", 6230, true)],
    note: "Already shipped, not delivered: cannot be cancelled or returned yet.",
  },
  {
    id: "ORD-1007",
    customerId: "C002",
    status: "delivered",
    placedDaysAgo: 15,
    shippedDaysAgo: 14,
    deliveredDaysAgo: 12,
    shippingCents: 500,
    paymentMethod: "Mastercard ending 5599",
    lines: [line("TS-TEE-02", "L", "White", 2990, false, 2)],
    note: "One line with quantity 2: partial returns and 'did you mean the second one too?'.",
  },

  // --- C003 Priya: limits, statutory window, hygiene ----------------------------------
  {
    id: "ORD-1008",
    customerId: "C003",
    status: "delivered",
    placedDaysAgo: 13,
    shippedDaysAgo: 12,
    deliveredDaysAgo: 10,
    shippingCents: 0,
    paymentMethod: "Amex ending 1005",
    lines: [line("TS-BLZ-07", "40", "Charcoal", 32900)],
    note: "Eligible, but above the auto-refund limit: needs human approval.",
  },
  {
    id: "ORD-1009",
    customerId: "C003",
    status: "delivered",
    placedDaysAgo: 63,
    shippedDaysAgo: 62,
    deliveredDaysAgo: 60,
    shippingCents: 0,
    paymentMethod: "Amex ending 1005",
    lines: [line("TS-KNT-11", "M", "Oat", 13900)],
    note: "Outside 30 days but inside 6 months: a fault claim goes to a human (Lemon Law), change of mind is denied.",
  },
  {
    id: "ORD-1010",
    customerId: "C003",
    status: "delivered",
    placedDaysAgo: 6,
    shippedDaysAgo: 5,
    deliveredDaysAgo: 3,
    shippingCents: 500,
    paymentMethod: "Amex ending 1005",
    lines: [line("TS-SOC-08", "One Size", "Mixed", 1990), line("TS-SWM-12", "M", "Teal", 5900)],
    note: "Hygiene items: not returnable unless faulty.",
  },

  // --- C004 Marcus: serial refunder ---------------------------------------------------
  {
    id: "ORD-1011",
    customerId: "C004",
    status: "delivered",
    placedDaysAgo: 153,
    shippedDaysAgo: 152,
    deliveredDaysAgo: 150,
    shippingCents: 500,
    paymentMethod: "Visa ending 7781",
    lines: [line("TS-TEE-02", "L", "Black", 2990)],
    pastRefund: { reason: "changed_mind", daysAfterDelivery: 4 },
    note: "History: refunded.",
  },
  {
    id: "ORD-1012",
    customerId: "C004",
    status: "delivered",
    placedDaysAgo: 123,
    shippedDaysAgo: 122,
    deliveredDaysAgo: 120,
    shippingCents: 500,
    paymentMethod: "Visa ending 7781",
    lines: [line("TS-LIN-01", "L", "White", 6900)],
    pastRefund: { reason: "wrong_size_or_fit", daysAfterDelivery: 6 },
    note: "History: refunded.",
  },
  {
    id: "ORD-1013",
    customerId: "C004",
    status: "delivered",
    placedDaysAgo: 83,
    shippedDaysAgo: 82,
    deliveredDaysAgo: 80,
    shippingCents: 0,
    paymentMethod: "Visa ending 7781",
    lines: [line("TS-SHO-06", "43", "White", 9900)],
    pastRefund: { reason: "changed_mind", daysAfterDelivery: 3 },
    note: "History: refunded.",
  },
  {
    id: "ORD-1014",
    customerId: "C004",
    status: "delivered",
    placedDaysAgo: 48,
    shippedDaysAgo: 47,
    deliveredDaysAgo: 45,
    shippingCents: 0,
    paymentMethod: "Visa ending 7781",
    lines: [line("TS-DRS-04", "L", "Terracotta", 11900)],
    pastRefund: { reason: "changed_mind", daysAfterDelivery: 5 },
    note: "History: refunded.",
  },
  {
    id: "ORD-1015",
    customerId: "C004",
    status: "delivered",
    placedDaysAgo: 9,
    shippedDaysAgo: 8,
    deliveredDaysAgo: 6,
    shippingCents: 500,
    paymentMethod: "Visa ending 7781",
    lines: [line("TS-LIN-01", "L", "Sage", 6900)],
    note: "Eligible on paper, but the customer's refund pattern sends it to a human risk review.",
  },

  // --- C005 Hannah: cancellation, very old order --------------------------------------
  {
    id: "ORD-1016",
    customerId: "C005",
    status: "processing",
    placedDaysAgo: 0,
    shippingCents: 0,
    paymentMethod: "PayNow",
    lines: [line("TS-DRS-04", "S", "Terracotta", 11900), line("TS-CAP-10", "One Size", "Indigo", 2730, true)],
    note: "Placed today, not shipped: cancel for a full refund.",
  },
  {
    id: "ORD-1017",
    customerId: "C005",
    status: "delivered",
    placedDaysAgo: 203,
    shippedDaysAgo: 202,
    deliveredDaysAgo: 200,
    shippingCents: 500,
    paymentMethod: "PayNow",
    lines: [line("TS-TEE-02", "M", "Navy", 2990)],
    note: "Delivered 200 days ago: outside both the return window and the 6-month statutory window.",
  },

  // --- C006 Daniel: repeated defect claims --------------------------------------------
  {
    id: "ORD-1018",
    customerId: "C006",
    status: "delivered",
    placedDaysAgo: 103,
    shippedDaysAgo: 102,
    deliveredDaysAgo: 100,
    shippingCents: 500,
    paymentMethod: "Visa ending 3310",
    lines: [line("TS-TEE-02", "S", "White", 2990)],
    pastRefund: { reason: "defective_or_damaged", daysAfterDelivery: 2 },
    note: "History: refunded as defective.",
  },
  {
    id: "ORD-1019",
    customerId: "C006",
    status: "delivered",
    placedDaysAgo: 73,
    shippedDaysAgo: 72,
    deliveredDaysAgo: 70,
    shippingCents: 0,
    paymentMethod: "Visa ending 3310",
    lines: [line("TS-CHN-05", "32", "Navy", 8900)],
    pastRefund: { reason: "defective_or_damaged", daysAfterDelivery: 3 },
    note: "History: refunded as defective.",
  },
  {
    id: "ORD-1020",
    customerId: "C006",
    status: "delivered",
    placedDaysAgo: 12,
    shippedDaysAgo: 11,
    deliveredDaysAgo: 9,
    shippingCents: 500,
    paymentMethod: "Visa ending 3310",
    lines: [line("TS-CAP-10", "One Size", "Indigo", 2730, true)],
    note: "Cheap faulty sale item, but two prior defect claims: no fast track, human verification.",
  },
  {
    id: "ORD-1021",
    customerId: "C006",
    status: "delivered",
    placedDaysAgo: 7,
    shippedDaysAgo: 6,
    deliveredDaysAgo: 4,
    shippingCents: 500,
    paymentMethod: "Visa ending 3310",
    lines: [line("TS-TEE-02", "S", "Navy", 2990)],
    note: "Full-price, low value: still refundable automatically for an elevated-risk customer.",
  },

  // --- Guests -------------------------------------------------------------------------
  {
    id: "ORD-1022",
    guestEmail: "guest.lee@example.com",
    status: "delivered",
    placedDaysAgo: 10,
    shippedDaysAgo: 9,
    deliveredDaysAgo: 7,
    shippingCents: 500,
    paymentMethod: "Visa ending 9012",
    lines: [line("TS-CHN-05", "34", "Khaki", 6230, true)],
    note: "Guest sale item: exchange to size 32 works, size 36 Khaki is out of stock.",
  },
  {
    id: "ORD-1023",
    guestEmail: "farah.guest@example.com",
    status: "processing",
    placedDaysAgo: 1,
    shippingCents: 0,
    paymentMethod: "GrabPay",
    lines: [line("TS-SHO-06", "39", "White", 9900)],
    note: "Guest order not yet shipped: can be cancelled.",
  },
];
