// Aggregates everything the Dashboard page's single fetch needs, so the
// frontend doesn't have to stitch together five separate calls on load.
import { Router } from 'express';
import { unwrap } from '../lib/supabase.js';
import { wrap } from '../lib/middleware.js';
import { viewClass, viewWeakConcept } from '../lib/view.js';
import { classChart } from '../lib/analytics.js';

const router = Router();

router.get('/', wrap(async (req, res) => {
  // req.user already carries the current-month balance — the auth middleware
  // applies the monthly reset before any route runs.
  const user = req.user;
  const db = req.supabase;

  const classes = unwrap(await db.from('classes').select('*').eq('user_id', user.id).eq('archived', false).order('grade').order('key'));
  const studentTotal = classes.reduce((s, c) => s + c.student_count, 0);

  const assessments = unwrap(await db
    .from('assessments').select('*, classes(key)')
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(6));

  const weak = unwrap(await db
    .from('weak_concepts').select('*, classes!inner(key)')
    .eq('user_id', user.id).eq('resolved', false)
    .order('severity', { ascending: false }).order('detected_at', { ascending: false }).limit(5));

  const { count: needsReview } = await db.from('results').select('*', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('needs_review', true).eq('reviewed', false);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const { count: upcoming } = await db.from('assessments').select('*', { count: 'exact', head: true })
    .eq('user_id', user.id).in('status', ['Draft', 'Finalized']).gte('created_at', thirtyDaysAgo);

  const materials = unwrap(await db.from('materials').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(3));

  const { count: questionBankTotal } = await db.from('questions').select('*', { count: 'exact', head: true }).eq('user_id', user.id);
  const { count: questionBankMonth } = await db.from('questions').select('*', { count: 'exact', head: true })
    .eq('user_id', user.id).gte('created_at', thirtyDaysAgo);

  // Headline class performance — the class with the most evaluated data.
  const withCharts = await Promise.all(classes.map(async (c) => ({ c, chart: await classChart(db, user.id, c.id) })));
  const bestTrackedClass = withCharts.sort((a, b) => b.chart.length - a.chart.length)[0];

  const recActions = [];
  if (needsReview > 0) {
    recActions.push({ kind: 'review', title: `${needsReview} evaluation${needsReview > 1 ? 's' : ''} need your review`, desc: 'Flagged for low AI confidence', cta: 'Review now' });
  }
  for (const w of weak.slice(0, 1)) {
    recActions.push({ kind: 'weak_concept', title: `Weak concept detected in ${w.classes.key}`, desc: w.concept, cta: 'Generate practice', classId: w.class_id, concept: w.concept });
  }
  const draft = assessments.find((a) => a.status === 'Draft');
  if (draft) recActions.push({ kind: 'paper', title: `${draft.title} is still a draft`, desc: `Chapters: ${(draft.chapters || []).join(', ')}`, cta: 'Continue paper', assessmentId: draft.id });
  if (questionBankMonth > 0) recActions.push({ kind: 'bank', title: `${questionBankMonth} new questions ready in Question Bank`, desc: 'Generated from recent papers', cta: 'Open bank' });

  res.json({
    greetingName: user.name.split(' ')[0],
    classCount: classes.length,
    studentTotal,
    subjectSummary: [...new Set(classes.map((c) => c.subject))].join(', ') || '—',
    credits: { balance: user.credits, allowance: user.allowance },
    recActions,
    assessments: assessments.map((a) => ({ id: a.id, title: a.title, cls: a.classes?.key || null, status: a.status, date: a.scheduled_for || a.created_at })),
    classPerformance: bestTrackedClass ? { classKey: bestTrackedClass.c.key, chart: bestTrackedClass.chart } : null,
    weakConcepts: weak.map((w) => ({ ...viewWeakConcept(w), classKey: w.classes.key })),
    classesMini: classes.map((c) => viewClass(c)),
    materials: materials.map((m) => ({ id: m.id, type: m.type, title: m.title, date: m.created_at })),
    questionBank: { total: questionBankTotal ?? 0, addedThisMonth: questionBankMonth ?? 0 },
    upcomingCount: upcoming ?? 0,
    needsReviewCount: needsReview ?? 0
  });
}));

export default router;
