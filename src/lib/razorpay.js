// Razorpay checkout + signature verification.
//
// Flow: POST /billing/checkout creates a Razorpay order and a matching
// payment_orders row recording what it's FOR (a credit pack or a plan
// switch) — Razorpay itself has no concept of "500 credits" or "Pro plan".
// The browser opens Razorpay's own Checkout widget with that order id.
// On success, POST /billing/verify checks the HMAC signature Razorpay signs
// the payment with, and only then applies the credit grant / plan switch.
// The signature check is what stops someone from just POSTing a fake
// "payment succeeded" request straight to our API.
import crypto from 'node:crypto';
import Razorpay from 'razorpay';

let client = null;
export function razorpayAvailable() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function isLiveMode() {
  return Boolean(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live_'));
}

/**
 * Razorpay's test-mode card/UPI numbers are public documentation — anyone
 * who finds a live deployment could "pay" for free and get real credits,
 * since the signature we verify is a genuinely valid one, just for a fake
 * transaction. So: test keys are only trusted in local development. The
 * moment RAZORPAY_KEY_ID starts with rzp_live_, this stops blocking anything
 * — no other code changes needed to go live.
 */
export function paymentsBlockedReason() {
  if (!razorpayAvailable()) return 'Payments aren’t configured yet.';
  if (process.env.NODE_ENV === 'production' && !isLiveMode()) {
    return 'Payments are launching soon — check back shortly.';
  }
  return null;
}

function rz() {
  if (!razorpayAvailable()) return null;
  if (!client) {
    client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  }
  return client;
}

/** amountRupees is a plain rupee amount (e.g. 400 for ₹400) — Razorpay wants paise. */
export async function createOrder({ amountRupees, receipt, notes }) {
  const instance = rz();
  if (!instance) throw new Error('Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  const amountPaise = Math.round(amountRupees * 100);
  const order = await instance.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes
  });
  return { order, amountPaise };
}

/** Verifies the signature Razorpay returns to the browser after a successful payment. */
export function verifySignature({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  // timingSafeEqual needs equal-length buffers, and a forged signature might
  // not even be valid hex — guard both before comparing.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signature || ''), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
