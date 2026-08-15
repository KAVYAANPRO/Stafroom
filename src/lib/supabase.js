// Supabase clients.
//
// `admin` uses the secret key — full DB access, bypasses Row-Level Security.
// Reserved for privileged operations only: creating users during sign-up/seed,
// and the credit-spend transaction (which needs an atomic read-modify-write
// across the RLS boundary). Every other request uses `clientFor(accessToken)`,
// a client authenticated as the signed-in teacher, so Postgres RLS enforces
// per-user isolation even if a route forgets a filter.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY in .env');
}

export const admin = createClient(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

export function clientFor(accessToken) {
  return createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
}

/** Throws the underlying Postgres/PostgREST error with its message intact. */
export function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Database error');
    err.cause = error;
    err.status = error.code === 'PGRST116' ? 404 : 400;
    throw err;
  }
  return data;
}
