// Credit pricing, plan entitlements and the ledger.
//
// The UI promises that "every AI action shows its cost before you confirm", so
// every price here is also exposed read-only at GET /api/billing/pricing and the
// same numbers drive the confirmation dialogs.
//
// Actual balance changes go through Postgres RPC functions (spend_credits /
// grant_credits, see schema.postgres.sql) — a plain read-then-write from here
// would race under concurrent requests; the DB does the read-modify-write
// atomically under a row lock instead.

import { paymentRequired, forbidden, badRequest } from './errors.js';

export const PLANS = {
  Free: {
    name: 'Free',
    credits: 100,
    monthly: 0,
    annual: 0,
    description: 'AI Paper Maker + Quiz Maker, with a limited monthly credit allowance.',
    features: ['paper', 'quiz', 'question_bank']
  },
  Pro: {
    name: 'Pro',
    credits: 600,
    monthly: 299,
    annual: 2990,
    description: 'Everything in Free, plus Notes Maker, Worksheet Generator and Performance Analyzer.',
    features: ['paper', 'quiz', 'question_bank', 'notes', 'worksheet', 'analytics']
  },
  Max: {
    name: 'Max',
    credits: 2500,
    monthly: 699,
    annual: 6990,
    description: 'Everything in Pro, plus AI Answer Evaluator, Weak Concept Detection and the full remediation loop.',
    features: [
      'paper', 'quiz', 'question_bank', 'notes', 'worksheet', 'analytics',
      'evaluator', 'weak_concepts', 'lesson_plan', 'class_intelligence'
    ]
  }
};

export const TOP_UP_PACKS = {
  small: { id: 'small', label: 'Small — 200 credits', credits: 200, price: 200, note: '₹1.00 per credit' },
  medium: { id: 'medium', label: 'Medium — 500 credits', credits: 500, price: 400, note: '₹0.80 per credit' },
  large: { id: 'large', label: 'Large — 1,200 credits', credits: 1200, price: 720, note: '₹0.60 per credit — best for exam-season spikes' }
};

// Paper cost scales with the blueprint size.
export const PAPER_COST_BY_MARKS = { 20: 5, 25: 6, 40: 9, 80: 16 };

export const COSTS = {
  question_regenerate: 0.4,
  question_swap: 0,              // pulled from the teacher's own bank — free
  material_notes: 2,
  material_worksheet: 2,
  material_quiz: 3,
  'material_lesson plan': 3,
  practice_worksheet: 2,
  evaluate_sheet: 1.5
};

export function paperCost(totalMarks) {
  const marks = Number(totalMarks) || 25;
  if (PAPER_COST_BY_MARKS[marks]) return PAPER_COST_BY_MARKS[marks];
  // Anything off the standard blueprints is priced proportionally.
  return Math.max(3, Math.round((marks / 25) * 6 * 10) / 10);
}

export function costOf(action, opts = {}) {
  if (action === 'paper') return paperCost(opts.totalMarks);
  if (action === 'material') return COSTS[`material_${String(opts.type || '').toLowerCase()}`] ?? 2;
  if (action === 'evaluate') return COSTS.evaluate_sheet * (opts.sheets || 1);
  return COSTS[action] ?? 0;
}

export function planFeatures(plan) {
  return (PLANS[plan] || PLANS.Free).features;
}

export function hasFeature(user, feature) {
  return planFeatures(user.plan).includes(feature);
}

export function requireFeature(user, feature, label) {
  if (hasFeature(user, feature)) return;
  const needed = Object.values(PLANS).find((p) => p.features.includes(feature));
  throw forbidden(`${label} is not included in your ${user.plan} plan.`, {
    code: 'PLAN_UPGRADE_REQUIRED',
    feature,
    requiredPlan: needed ? needed.name : 'Max'
  });
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** Deducts credits atomically. Throws 402 when the balance can't cover it. */
export async function spend(supabase, amount, action, detail = '') {
  const value = round(Number(amount));
  if (!(value >= 0)) throw badRequest('Invalid credit amount');

  const { data, error } = await supabase.rpc('spend_credits', { p_amount: value, p_action: action, p_detail: detail }).single();
  if (error) {
    const msg = error.message || '';
    if (msg.includes('INSUFFICIENT_CREDITS')) {
      const [, required, balance] = msg.match(/INSUFFICIENT_CREDITS:([\d.]+):([\d.]+)/) || [];
      throw paymentRequired(
        `This needs ${required ?? value} credits but you have ${round(Number(balance) || 0)}. Top up from Credits & Billing.`,
        { code: 'INSUFFICIENT_CREDITS', required: Number(required) || value, balance: round(Number(balance) || 0) }
      );
    }
    if (msg.includes('UNKNOWN_USER')) throw badRequest('Unknown user');
    throw badRequest(msg || 'Could not spend credits');
  }
  return { balance: data.balance, spent: data.spent };
}

/** Adds credits (top-up purchase, plan switch, refund). */
export async function grant(supabase, amount, action, detail = '') {
  const value = round(Number(amount));
  const { data, error } = await supabase.rpc('grant_credits', { p_amount: value, p_action: action, p_detail: detail }).single();
  if (error) throw badRequest(error.message || 'Could not grant credits');
  return { balance: data.balance };
}

export async function ledger(supabase, userId, limit = 50) {
  const { data, error } = await supabase
    .from('credit_ledger').select('action, detail, delta, balance_after, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw badRequest(error.message);
  return data;
}

/** Refills the monthly allowance in-place when the reset date has passed. */
export async function applyMonthlyReset(supabase, user) {
  if (!user.credits_reset_on || new Date(user.credits_reset_on) > new Date()) return user;
  const { data, error } = await supabase.rpc('apply_monthly_reset').single();
  if (error) return user; // non-fatal — try again next request
  return { ...user, ...data };
}

export function nextResetDate(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  return d.toISOString();
}
