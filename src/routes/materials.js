import { Router } from 'express';
import { unwrap } from '../lib/supabase.js';
import { nowIso } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';
import { viewMaterial } from '../lib/view.js';
import { generateMaterial } from '../lib/ai.js';
import { spend, costOf, requireFeature } from '../lib/credits.js';

const router = Router();

router.get('/', wrap(async (req, res) => {
  const { type } = req.query;
  let query = req.supabase.from('materials').select('*').eq('user_id', req.user.id);
  if (type && type !== 'All') query = query.eq('type', type);
  const rows = unwrap(await query.order('created_at', { ascending: false }));
  res.json({ materials: rows.map(viewMaterial) });
}));

router.post('/generate', wrap(async (req, res) => {
  const { type, classId, chapter, concept, title } = req.body || {};
  if (!type) throw badRequest('type is required');
  const kind = String(type).toUpperCase();
  if (!['NOTES', 'WORKSHEET', 'QUIZ', 'LESSON PLAN'].includes(kind)) throw badRequest('Unknown material type');

  if (kind === 'LESSON PLAN') requireFeature(req.user, 'lesson_plan', 'AI Lesson Planner');
  if (kind === 'WORKSHEET') requireFeature(req.user, 'worksheet', 'Worksheet Generator');
  if (kind === 'NOTES') requireFeature(req.user, 'notes', 'AI Notes Maker');

  const cls = classId
    ? (await req.supabase.from('classes').select('*').eq('id', classId).eq('user_id', req.user.id).single()).data
    : null;
  const cost = costOf('material', { type: kind });
  const { balance } = await spend(req.supabase, cost, `Generated ${kind.toLowerCase()}`, chapter || concept || title || '');

  const result = await generateMaterial({
    type: kind, title, chapter, concept,
    board: cls?.board || 'CBSE', grade: cls?.grade || '10', subject: cls?.subject || 'Science',
    medium: cls?.medium || req.user.medium || 'English'
  });

  const row = {
    user_id: req.user.id, class_id: cls?.id || null, type: kind,
    title: result.title, chapter: chapter || '', concept: concept || null, body: result.body,
    generated_by: result.generatedBy, created_at: nowIso()
  };
  const [created] = unwrap(await req.supabase.from('materials').insert(row).select('*'));
  res.status(201).json({ material: viewMaterial(created), balance, cost });
}));

router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title?.trim() || !b.type) throw badRequest('title and type are required');
  const row = {
    user_id: req.user.id, class_id: b.classId || null, type: String(b.type).toUpperCase(),
    title: b.title.trim(), chapter: b.chapter || '', concept: b.concept || null, body: b.body || '',
    generated_by: 'manual', created_at: nowIso()
  };
  const [created] = unwrap(await req.supabase.from('materials').insert(row).select('*'));
  res.status(201).json({ material: viewMaterial(created) });
}));

router.post('/:id/duplicate', wrap(async (req, res) => {
  const { data: m, error } = await req.supabase.from('materials').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (error || !m) throw notFound('Material not found');
  const row = {
    user_id: m.user_id, class_id: m.class_id, type: m.type, title: `${m.title} (copy)`,
    chapter: m.chapter, concept: m.concept, body: m.body, generated_by: m.generated_by, created_at: nowIso()
  };
  const [created] = unwrap(await req.supabase.from('materials').insert(row).select('*'));
  res.status(201).json({ material: viewMaterial(created) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const { data: m } = await req.supabase.from('materials').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (!m) throw notFound('Material not found');
  unwrap(await req.supabase.from('materials').delete().eq('id', m.id));
  res.json({ ok: true });
}));

export default router;
