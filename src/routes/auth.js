// Auth endpoints are thin wrappers around Supabase Auth. The browser could
// call Supabase directly, but routing through here lets the frontend stay on
// one simple `api()` helper and lets us auto-create the `classes` starter
// state on first sign-up.
import { Router } from 'express';
import { admin, clientFor } from '../lib/supabase.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';
import { requireAuth } from '../lib/auth.js';
import { publicUser } from '../lib/view.js';
import { isValidEmail, passwordIssue } from '../lib/validate.js';

const router = Router();

router.post('/register', wrap(async (req, res) => {
  const { name, email, password, school } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password) {
    throw badRequest('Name, email and password are required');
  }
  if (!isValidEmail(email)) throw badRequest('Enter a valid email address');
  const pwIssue = passwordIssue(password);
  if (pwIssue) throw badRequest(pwIssue);

  const supabase = clientFor(process.env.SUPABASE_PUBLISHABLE_KEY);
  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: { data: { name: name.trim() } }
  });
  if (error) {
    if (/already registered|already exists/i.test(error.message)) {
      throw conflict('An account with this email already exists');
    }
    throw badRequest(error.message);
  }
  // The DB trigger creates the profile row; school isn't part of that default,
  // so fill it in from the sign-up form if given. Uses the admin client since
  // there's no user session yet when email confirmation is required below.
  if (school?.trim()) {
    await admin.from('profiles').update({ school: school.trim() }).eq('id', data.user.id);
  }

  if (!data.session) {
    // Email confirmation is turned on for this project — the account exists
    // but can't sign in yet.
    throw badRequest('Check your inbox to confirm your email, then sign in.');
  }

  const asUser = clientFor(data.session.access_token);
  const { data: profile } = await asUser.from('profiles').select('*').eq('id', data.user.id).single();

  res.status(201).json({ user: publicUser(profile), token: data.session.access_token });
}));

router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw badRequest('Email and password are required');

  const supabase = clientFor(process.env.SUPABASE_PUBLISHABLE_KEY);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password
  });
  if (error) throw unauthorized('Incorrect email or password');

  const asUser = clientFor(data.session.access_token);
  const { data: profile } = await asUser.from('profiles').select('*').eq('id', data.user.id).single();

  res.json({ user: publicUser(profile), token: data.session.access_token });
}));

router.post('/logout', wrap(async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  if (token) {
    try { await clientFor(token).auth.signOut(); } catch { /* token already invalid */ }
  }
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

export default router;
