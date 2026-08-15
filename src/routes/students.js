import { Router } from 'express';
import { unwrap } from '../lib/supabase.js';
import { nowIso } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';

const router = Router({ mergeParams: true });

async function loadClass(req) {
  const { data, error } = await req.supabase.from('classes').select('*').eq('id', req.params.classId).eq('user_id', req.user.id).single();
  if (error || !data) throw notFound('Class not found');
  return data;
}

router.get('/', wrap(async (req, res) => {
  const cls = await loadClass(req);
  const rows = unwrap(await req.supabase.from('students').select('*').eq('class_id', cls.id).order('roll_no').order('name'));
  res.json({ students: rows.map((s) => ({ id: s.id, name: s.name, rollNo: s.roll_no })) });
}));

router.post('/', wrap(async (req, res) => {
  const cls = await loadClass(req);
  const { name, rollNo } = req.body || {};
  if (!name?.trim()) throw badRequest('name is required');
  const row = { user_id: req.user.id, class_id: cls.id, name: name.trim(), roll_no: rollNo ?? null, created_at: nowIso() };
  const [created] = unwrap(await req.supabase.from('students').insert(row).select('*'));
  res.status(201).json({ student: { id: created.id, name: created.name, rollNo: created.roll_no } });
}));

router.delete('/:studentId', wrap(async (req, res) => {
  const cls = await loadClass(req);
  const { data: s } = await req.supabase.from('students').select('id').eq('id', req.params.studentId).eq('class_id', cls.id).single();
  if (!s) throw notFound('Student not found');
  unwrap(await req.supabase.from('students').delete().eq('id', s.id));
  res.json({ ok: true });
}));

export default router;
