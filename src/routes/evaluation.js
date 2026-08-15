// AI Answer Evaluator — Max-plan feature. A teacher submits transcribed answers
// for one student against one assessment; Gemini marks each item and flags any
// it isn't confident about. Confirmed results feed weak-concept detection.
import { Router } from 'express';
import { unwrap } from '../lib/supabase.js';
import { nowIso } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';
import { evaluateSheet } from '../lib/ai.js';
import { spend, costOf, requireFeature } from '../lib/credits.js';
import { recomputeWeakConcepts } from '../lib/analytics.js';

const router = Router();

router.get('/queue', wrap(async (req, res) => {
  const rows = unwrap(await req.supabase
    .from('results')
    .select('id, score, max_score, ai_confidence, reviewed, assessments!inner(id, title), students!inner(name)')
    .eq('user_id', req.user.id).eq('needs_review', true).eq('reviewed', false)
    .order('evaluated_at', { ascending: false }));
  res.json({
    queue: rows.map((r) => ({
      id: r.id, score: r.score, max_score: r.max_score, ai_confidence: r.ai_confidence, reviewed: r.reviewed,
      title: r.assessments.title, assessment_id: r.assessments.id, student_name: r.students.name
    }))
  });
}));

async function saveResult(req, assessment, student, marked, generatedBy) {
  const now = nowIso();
  const score = marked.items.reduce((s, it) => s + it.awarded, 0);
  const maxScore = marked.items.reduce((s, it) => s + it.max, 0);
  const avgConfidence = marked.items.reduce((s, it) => s + it.confidence, 0) / (marked.items.length || 1);
  const needsReview = generatedBy === 'offline' || avgConfidence < 0.7;

  const { data: existing } = await req.supabase.from('results').select('id')
    .eq('assessment_id', assessment.id).eq('student_id', student.id).maybeSingle();

  let resultId = existing?.id;
  if (existing) {
    await req.supabase.from('result_items').delete().eq('result_id', existing.id);
    await req.supabase.from('results').update({
      score, max_score: maxScore, ai_confidence: avgConfidence, needs_review: needsReview, reviewed: false, evaluated_at: now
    }).eq('id', existing.id);
  } else {
    const [created] = unwrap(await req.supabase.from('results').insert({
      user_id: req.user.id, assessment_id: assessment.id, student_id: student.id,
      score, max_score: maxScore, ai_confidence: avgConfidence, needs_review: needsReview, reviewed: false, evaluated_at: now
    }).select('id'));
    resultId = created.id;
  }

  const itemRows = marked.items.map((it) => ({
    result_id: resultId, aq_id: it.aqId, topic: it.topic, chapter: it.chapter,
    awarded: it.awarded, max_marks: it.max, comment: it.comment, confidence: it.confidence
  }));
  if (itemRows.length) unwrap(await req.supabase.from('result_items').insert(itemRows));

  if (assessment.status !== 'Evaluated') {
    await req.supabase.from('assessments').update({ status: 'Evaluated' }).eq('id', assessment.id);
  }
  return resultId;
}

router.post('/', wrap(async (req, res) => {
  requireFeature(req.user, 'evaluator', 'AI Answer Evaluator');
  const { assessmentId, studentId, studentName, answers } = req.body || {};
  if (!assessmentId || !Array.isArray(answers) || !answers.length) {
    throw badRequest('assessmentId and answers[] are required');
  }
  const { data: assessment, error: aErr } = await req.supabase.from('assessments').select('*').eq('id', assessmentId).eq('user_id', req.user.id).single();
  if (aErr || !assessment) throw notFound('Assessment not found');

  let student = studentId
    ? (await req.supabase.from('students').select('*').eq('id', studentId).eq('user_id', req.user.id).single()).data
    : null;
  if (!student && studentName?.trim() && assessment.class_id) {
    const { data: found } = await req.supabase.from('students').select('*')
      .eq('class_id', assessment.class_id).eq('name', studentName.trim()).maybeSingle();
    student = found;
    if (!student) {
      const [created] = unwrap(await req.supabase.from('students').insert({
        user_id: req.user.id, class_id: assessment.class_id, name: studentName.trim(), roll_no: null, created_at: nowIso()
      }).select('*'));
      student = created;
    }
  }
  if (!student) throw badRequest('studentId or studentName is required');

  const questions = unwrap(await req.supabase.from('assessment_questions').select('*').eq('assessment_id', assessment.id).order('position'));
  const byId = new Map(questions.map((q) => [q.id, q]));
  const chapters = assessment.chapters || [];
  const items = answers
    .map((a) => {
      const q = byId.get(a.aqId);
      if (!q) return null;
      return { aqId: q.id, topic: q.topic, chapter: chapters[0] || '', question: q.text, answer: q.answer, marks: q.marks, studentAnswer: a.text || '' };
    })
    .filter(Boolean);
  if (!items.length) throw badRequest('None of the given answers matched a question on this assessment');

  const cost = costOf('evaluate');
  const { balance } = await spend(req.supabase, cost, 'Evaluated answer sheet', `${assessment.title} · ${student.name}`);

  const outcome = await evaluateSheet({
    items, board: 'CBSE', grade: '10', subject: assessment.subject, medium: assessment.medium
  });
  const marked = {
    items: outcome.items.map((it, i) => ({ ...it, max: items[i].marks, aqId: items[i].aqId, topic: items[i].topic, chapter: items[i].chapter }))
  };
  const resultId = await saveResult(req, assessment, student, marked, outcome.generatedBy);
  await recomputeWeakConcepts(req.supabase, req.user.id, assessment.class_id);

  res.status(201).json({
    resultId, balance, cost, generatedBy: outcome.generatedBy,
    score: marked.items.reduce((s, it) => s + it.awarded, 0),
    maxScore: marked.items.reduce((s, it) => s + it.max, 0),
    items: marked.items
  });
}));

router.post('/:resultId/review', wrap(async (req, res) => {
  const { data: r, error } = await req.supabase.from('results').select('*').eq('id', req.params.resultId).eq('user_id', req.user.id).single();
  if (error || !r) throw notFound('Result not found');
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (items) {
    for (const it of items) {
      if (it.id) await req.supabase.from('result_items').update({ awarded: it.awarded }).eq('id', it.id).eq('result_id', r.id);
    }
    const rows = unwrap(await req.supabase.from('result_items').select('awarded').eq('result_id', r.id));
    const total = rows.reduce((s, x) => s + Number(x.awarded), 0);
    await req.supabase.from('results').update({ score: total }).eq('id', r.id);
  }
  await req.supabase.from('results').update({ reviewed: true, needs_review: false }).eq('id', r.id);
  res.json({ ok: true });
}));

export default router;
