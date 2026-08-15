import { Router } from 'express';
import { unwrap } from '../lib/supabase.js';
import { nowIso } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';
import { viewClass } from '../lib/view.js';
import { generateSyllabus } from '../lib/ai.js';

const router = Router();

async function classSummary(db, userId, classRow) {
  const assessments = unwrap(await db
    .from('assessments').select('title, status, total_marks, scheduled_for, created_at')
    .eq('user_id', userId).eq('class_id', classRow.id)
    .order('created_at', { ascending: false }).limit(5));

  const scored = unwrap(await db
    .from('results').select('score, max_score, assessments!inner(created_at, class_id)')
    .eq('user_id', userId).eq('assessments.class_id', classRow.id)
    .order('created_at', { referencedTable: 'assessments', ascending: true }));

  let avg = null, trend = null;
  if (scored.length) {
    const pct = scored.map((s) => (s.max_score ? (s.score / s.max_score) * 100 : 0));
    avg = Math.round(pct.reduce((a, b) => a + b, 0) / pct.length);
    if (pct.length >= 2) trend = Math.round(pct[pct.length - 1] - pct[0]);
  }

  const weak = unwrap(await db
    .from('weak_concepts').select('concept, severity')
    .eq('user_id', userId).eq('class_id', classRow.id).eq('resolved', false));

  return {
    avg: avg === null ? null : `${avg}%`,
    trend: trend === null ? null : `${trend >= 0 ? '+' : ''}${trend}%`,
    hasWeak: weak.length > 0,
    weakTop: weak[0]?.concept || null,
    recent: assessments.map((a) => ({ title: a.title, status: a.status, date: a.created_at })),
    next: assessments.find((a) => a.status === 'Draft' || a.status === 'Finalized')?.title || null
  };
}

router.get('/', wrap(async (req, res) => {
  const rows = unwrap(await req.supabase
    .from('classes').select('*')
    .eq('user_id', req.user.id).eq('archived', false)
    .order('grade').order('key'));
  const classes = await Promise.all(rows.map(async (c) => viewClass(c, await classSummary(req.supabase, req.user.id, c))));
  res.json({ classes });
}));

router.post('/', wrap(async (req, res) => {
  const { board = 'CBSE', section, subject, students = 0, medium = 'English' } = req.body || {};
  if (!section?.trim() || !subject?.trim()) throw badRequest('Grade/section and subject are required');
  const key = section.trim();

  const existing = unwrap(await req.supabase.from('classes').select('id').eq('user_id', req.user.id).eq('key', key));
  if (existing.length) throw badRequest(`Class ${key} already exists`);

  const grade = (key.split('-')[0] || key).trim();
  const row = {
    user_id: req.user.id, key, board, grade, section: key.split('-')[1] || null,
    subject: subject.trim(), student_count: Number(students) || 0, syllabus: '2026-27',
    medium, question_mix: 'Short-answer heavy', created_at: nowIso()
  };
  const [created] = unwrap(await req.supabase.from('classes').insert(row).select('*'));
  res.status(201).json({ class: viewClass(created, await classSummary(req.supabase, req.user.id, created)) });
}));

async function loadClass(req) {
  const { data, error } = await req.supabase.from('classes').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (error || !data) throw notFound('Class not found');
  return data;
}

router.get('/:id', wrap(async (req, res) => {
  const c = await loadClass(req);
  res.json({ class: viewClass(c, await classSummary(req.supabase, req.user.id, c)) });
}));

router.get('/:id/chapters', wrap(async (req, res) => {
  const c = await loadClass(req);
  let chapters = unwrap(await req.supabase
    .from('chapters').select('name, topic_count').eq('class_id', c.id).order('position'));
  let generatedBy = null;

  if (!chapters.length) {
    // No chapter list has been set up for this class yet — fall back to
    // whatever chapters already exist in the bank for its subject/grade...
    const bankRows = unwrap(await req.supabase
      .from('questions').select('chapter, topic')
      .eq('user_id', req.user.id)
      .or(`class_id.eq.${c.id},and(grade.eq.${c.grade},subject.eq.${c.subject})`));
    const byChapter = new Map();
    for (const r of bankRows) {
      if (!byChapter.has(r.chapter)) byChapter.set(r.chapter, new Set());
      if (r.topic) byChapter.get(r.chapter).add(r.topic);
    }
    chapters = [...byChapter.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, topics]) => ({ name, topic_count: topics.size }));
  }

  if (!chapters.length) {
    // ...and if the bank has nothing either, look up the real board syllabus
    // and save it, so this only happens once per class.
    const result = await generateSyllabus({ board: c.board, grade: c.grade, subject: c.subject });
    generatedBy = result.generatedBy;
    unwrap(await req.supabase.from('chapters').insert(
      result.chapters.map((ch, i) => ({
        user_id: req.user.id, class_id: c.id, name: ch.name, topic_count: ch.topics, position: i
      }))
    ));
    chapters = result.chapters.map((ch) => ({ name: ch.name, topic_count: ch.topics }));
  }

  res.json({ chapters: chapters.map((ch) => ({ name: ch.name, topics: ch.topic_count })), generatedBy });
}));

router.patch('/:id', wrap(async (req, res) => {
  const c = await loadClass(req);
  const fields = { medium: req.body.medium, question_mix: req.body.mix, student_count: req.body.students };
  const patch = {};
  for (const [col, val] of Object.entries(fields)) if (val !== undefined) patch[col] = val;

  const updated = Object.keys(patch).length
    ? unwrap(await req.supabase.from('classes').update(patch).eq('id', c.id).select('*'))[0]
    : c;
  res.json({ class: viewClass(updated, await classSummary(req.supabase, req.user.id, updated)) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const c = await loadClass(req);
  unwrap(await req.supabase.from('classes').update({ archived: true }).eq('id', c.id));
  res.json({ ok: true });
}));

export default router;
