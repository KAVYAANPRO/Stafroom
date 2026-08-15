// Verifies Supabase Auth session tokens sent by the frontend and attaches
// req.user (the teacher's profile row) + req.supabase (an RLS-scoped client
// authenticated as that teacher, so every query in a route handler is
// automatically confined to their own data by Postgres itself).

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { clientFor } from './supabase.js';
import { applyMonthlyReset } from './credits.js';
import { unauthorized } from './errors.js';

const JWKS = createRemoteJWKSet(new URL(process.env.SUPABASE_JWKS_URL));

function tokenFromRequest(req) {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Populates req.user/req.supabase when a valid token is present; never throws. */
export async function attachUser(req, _res, next) {
  const token = tokenFromRequest(req);
  if (!token) return next();
  try {
    const { payload } = await jwtVerify(token, JWKS);
    const supabase = clientFor(token);
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', payload.sub).single();
    if (profile) {
      req.user = await applyMonthlyReset(supabase, profile);
      req.supabase = supabase;
      req.accessToken = token;
    }
  } catch {
    // invalid/expired token — treated as signed out
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}
