import { Router } from 'express';
import { unwrap } from '../lib/supabase.js';
import { wrap } from '../lib/middleware.js';
import { notFound } from '../lib/errors.js';
import { requireFeature } from '../lib/credits.js';
import { viewWeakConcept } from '../lib/view.js';
import { classChart, classAssessmentComparison, topicStrength } from '../lib/analytics.js';

const router = Router();

router.get('/classes/:classId', wrap(async (req, res) => {
  requireFeature(req.user, 'analytics', 'Performance Analyzer');
  const { data: cls, error } = await req.supabase.from('classes').select('*').eq('id', req.params.classId).eq('user_id', req.user.id).single();
  if (error || !cls) throw notFound('Class not found');

  const weak = unwrap(await req.supabase.from('weak_concepts').select('*')
    .eq('user_id', req.user.id).eq('class_id', cls.id).eq('resolved', false)
    .order('severity', { ascending: false }).order('detected_at', { ascending: false }));

  res.json({
    classId: cls.id, name: `${cls.key} · ${cls.subject}`,
    chart: await classChart(req.supabase, req.user.id, cls.id),
    weak: weak.map(viewWeakConcept),
    topics: await topicStrength(req.supabase, req.user.id, cls.id),
    assessments: await classAssessmentComparison(req.supabase, req.user.id, cls.id)
  });
}));

router.get('/students/:studentId', wrap(async (req, res) => {
  requireFeature(req.user, 'analytics', 'Performance Analyzer');
  const { data: student, error } = await req.supabase.from('students').select('*').eq('id', req.params.studentId).eq('user_id', req.user.id).single();
  if (error || !student) throw notFound('Student not found');
  const { data: cls } = await req.supabase.from('classes').select('*').eq('id', student.class_id).maybeSingle();

  const historyRows = unwrap(await req.supabase
    .from('results').select('score, max_score, assessments!inner(title, created_at)')
    .eq('student_id', student.id).order('created_at', { referencedTable: 'assessments', ascending: false }));
  const history = historyRows.map((h) => ({
    title: h.assessments.title, date: h.assessments.created_at,
    score: h.max_score ? `${Math.round((h.score / h.max_score) * 100)}%` : '—'
  }));

  const chartRowsRaw = unwrap(await req.supabase
    .from('results').select('score, max_score, assessments!inner(title, created_at)')
    .eq('student_id', student.id).order('created_at', { referencedTable: 'assessments', ascending: true }));
  const chartRows = chartRowsRaw
    .map((h) => h.max_score ? { label: h.assessments.title, pct: Math.round((h.score / h.max_score) * 100) } : null)
    .filter(Boolean);

  const avg = chartRows.length ? Math.round(chartRows.reduce((s, c) => s + c.pct, 0) / chartRows.length) : null;

  res.json({
    id: student.id, name: student.name, cls: cls ? `${cls.key} · ${cls.subject}` : '',
    avg: avg === null ? '—' : `${avg}%`,
    chart: chartRows.slice(-4),
    topics: await topicStrength(req.supabase, req.user.id, student.class_id, student.id),
    history
  });
}));

router.get('/students', wrap(async (req, res) => {
  const { classId } = req.query;
  let query = req.supabase.from('students').select('id, name, class_id').eq('user_id', req.user.id);
  if (classId) query = query.eq('class_id', classId);
  const rows = unwrap(await query.order('name'));

  const results = rows.length
    ? unwrap(await req.supabase.from('results').select('student_id, score, max_score').in('student_id', rows.map((s) => s.id)))
    : [];
  const byStudent = new Map();
  for (const r of results) {
    if (!r.max_score) continue;
    if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, []);
    byStudent.get(r.student_id).push((r.score / r.max_score) * 100);
  }

  res.json({
    students: rows.map((s) => {
      const scores = byStudent.get(s.id);
      const avg = scores?.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      return { id: s.id, name: s.name, classId: s.class_id, avg: avg === null ? '—' : `${avg}%` };
    })
  });
}));

export default router;
