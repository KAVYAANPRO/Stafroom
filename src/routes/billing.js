import { Router } from 'express';
import { admin, unwrap } from '../lib/supabase.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';
import { publicUser, viewLedgerEntry } from '../lib/view.js';
import { PLANS, TOP_UP_PACKS, grant, ledger, nextResetDate, COSTS, PAPER_COST_BY_MARKS } from '../lib/credits.js';
import { createOrder, verifySignature, razorpayAvailable, paymentsBlockedReason } from '../lib/razorpay.js';
import { nowIso } from '../lib/ids.js';

const router = Router();

router.get('/pricing', (req, res) => {
  res.json({
    plans: PLANS,
    topUpPacks: Object.values(TOP_UP_PACKS),
    actionCosts: { ...COSTS, paper_by_marks: PAPER_COST_BY_MARKS },
    paymentsEnabled: razorpayAvailable() && !paymentsBlockedReason()
  });
});

router.get('/', wrap(async (req, res) => {
  // req.user already carries the current-month balance — the auth middleware
  // applies the monthly reset before any route runs.
  const user = req.user;
  res.json({
    balance: user.credits,
    allowance: user.allowance,
    plan: user.plan,
    billingPeriod: user.billing_period,
    resetOn: user.credits_reset_on,
    ledger: (await ledger(req.supabase, user.id)).map(viewLedgerEntry)
  });
}));

function planPrice(plan, period) {
  const meta = PLANS[plan];
  if (!meta) return null;
  return period === 'annual' ? meta.annual : meta.monthly;
}

async function applyPlanSwitch(req, plan, billingPeriod) {
  const meta = PLANS[plan];
  const [updated] = unwrap(await req.supabase.from('profiles').update({
    plan, billing_period: billingPeriod, credits: meta.credits, allowance: meta.credits,
    credits_reset_on: nextResetDate()
  }).eq('id', req.user.id).select('*'));
  return updated;
}

/**
 * Starts a purchase. Free things (switching to the Free plan) apply
 * immediately — nothing to pay for. Everything else creates a real Razorpay
 * order that the browser opens in the Checkout widget; the credits/plan
 * change only happens once /verify confirms the payment signature.
 */
router.post('/checkout', wrap(async (req, res) => {
  const { kind } = req.body || {};

  if (kind === 'topup') {
    const pack = TOP_UP_PACKS[req.body.packId];
    if (!pack) throw badRequest('Choose a valid credit pack');
    return res.json(await startCheckout(req, {
      kind: 'topup', amountRupees: pack.price, packId: pack.id,
      description: `${pack.label} — Staffroom credits`
    }));
  }

  if (kind === 'plan') {
    const { plan, period } = req.body || {};
    if (!PLANS[plan]) throw badRequest('Unknown plan');
    const billingPeriod = period === 'annual' ? 'annual' : 'monthly';
    const price = planPrice(plan, billingPeriod);
    if (price === 0) {
      const updated = await applyPlanSwitch(req, plan, billingPeriod);
      return res.json({ applied: true, user: publicUser(updated) });
    }
    return res.json(await startCheckout(req, {
      kind: 'plan', amountRupees: price, plan, billingPeriod,
      description: `Staffroom ${plan} — ${billingPeriod}`
    }));
  }

  throw badRequest('kind must be "topup" or "plan"');
}));

async function startCheckout(req, { kind, amountRupees, packId, plan, billingPeriod, description }) {
  const blocked = paymentsBlockedReason();
  if (blocked) throw badRequest(blocked);
  const receipt = `sr_${kind}_${Date.now()}`;
  const { order, amountPaise } = await createOrder({
    amountRupees, receipt, notes: { userId: req.user.id, kind, packId: packId || '', plan: plan || '' }
  });

  unwrap(await admin.from('payment_orders').insert({
    user_id: req.user.id, razorpay_order_id: order.id, kind,
    pack_id: packId || null, plan: plan || null, billing_period: billingPeriod || null,
    amount_paise: amountPaise, status: 'created', created_at: nowIso()
  }));

  return {
    applied: false,
    orderId: order.id, amount: amountPaise, currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID, name: 'Staffroom', description,
    prefill: { name: req.user.name, email: req.user.email }
  };
}

router.post('/verify', wrap(async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (!orderId || !paymentId || !signature) throw badRequest('Missing payment details');

  const { data: order, error } = await admin.from('payment_orders').select('*')
    .eq('razorpay_order_id', orderId).eq('user_id', req.user.id).single();
  if (error || !order) throw notFound('Payment order not found');
  if (order.status === 'paid') throw conflict('This payment has already been applied');

  if (!verifySignature({ orderId, paymentId, signature })) {
    await admin.from('payment_orders').update({ status: 'failed' }).eq('id', order.id);
    throw badRequest('Payment could not be verified');
  }

  await admin.from('payment_orders').update({ status: 'paid', paid_at: nowIso() }).eq('id', order.id);

  if (order.kind === 'topup') {
    const pack = TOP_UP_PACKS[order.pack_id];
    const { balance } = await grant(req.supabase, pack.credits, 'Top-up purchased', `${pack.label} · ₹${(order.amount_paise / 100).toLocaleString('en-IN')}`);
    return res.json({ kind: 'topup', balance, pack });
  }

  const updated = await applyPlanSwitch(req, order.plan, order.billing_period);
  res.json({ kind: 'plan', user: publicUser(updated) });
}));

export default router;
