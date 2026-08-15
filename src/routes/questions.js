import { Router } from 'express';
import { unwrap } from '../lib/supabase.js';
import { nowIso } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';
import { viewQuestion } from '../lib/view.js';

const router = Router();

router.get('/', wrap(async (req, res) => {
  const { q, chapter, type, difficulty, favoritesOnly, shortlistedOnly, grade } = req.query;
  let query = req.supabase.from('questions').select('*', { count: 'exact' }).eq('user_id', req.user.id);
  if (chapter && chapter !== 'All') query = query.eq('chapter', chapter);
  if (type && type !== 'All') query = query.eq('type', type);
  if (difficulty && difficulty !== 'All') query = query.eq('difficulty', difficulty);
  if (grade) query = query.eq('grade', String(grade));
  if (favoritesOnly === 'true') query = query.eq('favorite', true);
  if (shortlistedOnly === 'true') query = query.eq('shortlisted', true);
  if (q?.trim()) {
    const needle = `%${q.trim()}%`;
    query = query.or(`text.ilike.${needle},topic.ilike.${needle}`);
  }
  const { data: rows, count, error } = await query.order('created_at', { ascending: false });
  if (error) throw badRequest(error.message);

  const chapterRows = unwrap(await req.supabase.from('questions').select('chapter').eq('user_id', req.user.id));
  const chapters = [...new Set(chapterRows.map((r) => r.chapter))].sort();

  res.json({ questions: rows.map(viewQuestion), total: count ?? rows.length, chapters });
}));

router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.text?.trim() || !b.chapter?.trim()) throw badRequest('text and chapter are required');
  const row = {
    user_id: req.user.id, class_id: b.classId || null, grade: b.grade || null,
    subject: b.subject || null, chapter: b.chapter.trim(), topic: b.topic || b.chapter.trim(),
    type: b.type || 'Short', marks: Number(b.marks) || 1, difficulty: b.difficulty || 'Medium',
    medium: b.medium || 'English', text: b.text.trim(), answer: b.answer || '',
    variant_text: b.variantText || null, variant_answer: b.variantAnswer || null,
    source: 'manual', created_at: nowIso()
  };
  const [created] = unwrap(await req.supabase.from('questions').insert(row).select('*'));
  res.status(201).json({ question: viewQuestion(created) });
}));

async function loadQuestion(req) {
  const { data, error } = await req.supabase.from('questions').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (error || !data) throw notFound('Question not found');
  return data;
}

router.patch('/:id', wrap(async (req, res) => {
  const row = await loadQuestion(req);
  const b = req.body || {};
  const map = { text: 'text', answer: 'answer', topic: 'topic', difficulty: 'difficulty' };
  const patch = {};
  for (const [key, col] of Object.entries(map)) if (b[key] !== undefined) patch[col] = b[key];
  if (b.favorite !== undefined) patch.favorite = Boolean(b.favorite);
  if (b.shortlisted !== undefined) patch.shortlisted = Boolean(b.shortlisted);

  const updated = Object.keys(patch).length
    ? unwrap(await req.supabase.from('questions').update(patch).eq('id', row.id).select('*'))[0]
    : row;
  res.json({ question: viewQuestion(updated) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const row = await loadQuestion(req);
  unwrap(await req.supabase.from('questions').delete().eq('id', row.id));
  res.json({ ok: true });
}));

export default router;
