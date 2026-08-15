import { Router } from 'express';
import { admin, unwrap } from '../lib/supabase.js';
import { wrap } from '../lib/middleware.js';
import { publicUser } from '../lib/view.js';
import { badRequest, conflict } from '../lib/errors.js';
import { isValidEmail, passwordIssue } from '../lib/validate.js';

const router = Router();

const PROFILE_FIELDS = { name: 'name', school: 'school', phone: 'phone' };
const PREF_FIELDS = { medium: 'medium', difficulty: 'difficulty', questionMix: 'question_mix', lang: 'lang' };

router.patch('/', wrap(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const [key, col] of Object.entries({ ...PROFILE_FIELDS, ...PREF_FIELDS })) {
    if (b[key] !== undefined) patch[col] = b[key];
  }
  if (b.boards) patch.boards = b.boards;
  if (b.grades) patch.grades = b.grades;
  if (b.subjects) patch.subjects = b.subjects;
  if (b.notifications) patch.notifications = b.notifications;

  // Email lives on auth.users, not just the profiles table, and changing it
  // needs the admin API — req.supabase only carries a bearer token, not a
  // full session, so supabase.auth.updateUser() can't act on it (same
  // reason the password-change endpoint below uses admin too).
  if (b.email !== undefined) {
    const newEmail = String(b.email).trim().toLowerCase();
    if (newEmail !== req.user.email) {
      if (!isValidEmail(newEmail)) throw badRequest('Enter a valid email address');
      const { error } = await admin.auth.admin.updateUserById(req.user.id, { email: newEmail, email_confirm: true });
      if (error) {
        if (/already been registered|already exists/i.test(error.message)) {
          throw conflict('Another account already uses this email');
        }
        throw badRequest(error.message);
      }
      patch.email = newEmail;
    }
  }

  const updated = Object.keys(patch).length
    ? unwrap(await req.supabase.from('profiles').update(patch).eq('id', req.user.id).select('*'))[0]
    : req.user;
  res.json({ user: publicUser(updated) });
}));

router.post('/password', wrap(async (req, res) => {
  const { newPassword } = req.body || {};
  const issue = passwordIssue(newPassword);
  if (issue) throw badRequest(issue);
  // req.supabase only carries the access token as a REST header, not a full
  // session, so supabase.auth.updateUser() has nothing to authenticate
  // against. Go through the admin API instead, scoped to the verified user
  // id from the JWT we already checked in the auth middleware.
  const { error } = await admin.auth.admin.updateUserById(req.user.id, { password: newPassword });
  if (error) throw badRequest(error.message);
  res.json({ ok: true });
}));

router.get('/export', wrap(async (req, res) => {
  const userId = req.user.id;
  const tables = ['classes', 'questions', 'assessments', 'materials', 'results', 'weak_concepts', 'credit_ledger'];
  const dump = { user: publicUser(req.user) };
  for (const t of tables) {
    dump[t] = unwrap(await req.supabase.from(t).select('*').eq('user_id', userId));
  }
  // assessment_questions has no user_id of its own — scope through assessments.
  dump.assessment_questions = unwrap(await req.supabase
    .from('assessment_questions').select('*, assessments!inner(user_id)').eq('assessments.user_id', userId));

  res.setHeader('Content-Disposition', 'attachment; filename="staffroom-export.json"');
  res.json(dump);
}));

export default router;
