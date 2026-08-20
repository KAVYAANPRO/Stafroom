import { Router } from 'express';
import { unwrap } from '../lib/supabase.js';
import { nowIso } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';
import { viewAssessment, viewAssessmentQuestion } from '../lib/view.js';
import { blueprintFor, sectionHeadings, defaultInstructions, paperHeader, romanGrade, SUPPORTED_MARKS } from '../lib/blueprint.js';
import { generatePaper, regenerateQuestion } from '../lib/ai.js';
import { spend, grant, paperCost, costOf } from '../lib/credits.js';
import { renderAssessmentPdf } from '../lib/pdf.js';

const router = Router();

router.get('/', wrap(async (req, res) => {
  const { classId, status } = req.query;
  let query = req.supabase.from('assessments').select('*').eq('user_id', req.user.id);
  if (classId) query = query.eq('class_id', classId);
  if (status) query = query.eq('status', status);
  const rows = unwrap(await query.order('created_at', { ascending: false }));
  res.json({ assessments: rows.map((a) => viewAssessment(a)) });
}));

router.get('/blueprints', (req, res) => {
  res.json({
    marksOptions: SUPPORTED_MARKS.map((m) => {
      const bp = blueprintFor(m);
      return { marks: m, duration: bp.duration, summary: bp.summary, cost: paperCost(m) };
    })
  });
});

async function loadAssessment(req) {
  const { data, error } = await req.supabase.from('assessments').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (error || !data) throw notFound('Assessment not found');
  return data;
}

async function loadAssessmentQuestions(req, assessmentId) {
  return unwrap(await req.supabase.from('assessment_questions').select('*').eq('assessment_id', assessmentId).order('position'));
}

router.get('/:id', wrap(async (req, res) => {
  const a = await loadAssessment(req);
  const questions = await loadAssessmentQuestions(req, a.id);
  res.json({ assessment: viewAssessment(a, questions) });
}));

/** Shapes one assessment into the header/sections/instructions a print or PDF view needs. */
async function buildPrintData(req, a) {
  const cls = a.class_id ? (await req.supabase.from('classes').select('*').eq('id', a.class_id).maybeSingle()).data : null;
  const bp = blueprintFor(a.total_marks) || { totalMarks: a.total_marks, sections: [] };
  const header = paperHeader({
    school: req.user.school || 'Your School',
    title: a.title,
    subject: a.subject,
    grade: cls ? romanGrade(cls.grade) : '',
    totalMarks: a.total_marks,
    duration: a.duration,
    medium: a.medium
  });
  const headings = bp.sections?.length ? sectionHeadings(bp, a.medium) : [];
  const questions = await loadAssessmentQuestions(req, a.id);
  const sections = headings.map((h) => ({
    title: h.title, note: h.note,
    questions: questions.filter((q) => q.section === h.key).map(viewAssessmentQuestion)
  }));
  return { header, sections, instructions: a.instructions || [] };
}

/** Renders the print-ready paper: header text, section groupings, answer key visibility. */
router.get('/:id/print', wrap(async (req, res) => {
  const a = await loadAssessment(req);
  res.json(await buildPrintData(req, a));
}));

/**
 * Real PDF export — pdfkit, no browser involved, so no Chrome print
 * header/footer and no risk to the app from a headless-browser render.
 */
router.get('/:id/pdf', wrap(async (req, res) => {
  const a = await loadAssessment(req);
  const { header, sections, instructions } = await buildPrintData(req, a);
  const showKey = req.query.showKey === '1';
  const buffer = await renderAssessmentPdf({ header, sections, instructions, medium: a.medium, showKey });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${a.title.replace(/[^\w\- ]+/g, '').trim() || 'question-paper'}.pdf"`);
  res.send(buffer);
}));

async function createDraft(req, cls, blueprint, opts, generated) {
  const now = nowIso();
  const [a] = unwrap(await req.supabase.from('assessments').insert({
    user_id: req.user.id, class_id: cls?.id || null,
    title: opts.title || `${blueprint.totalMarks}-mark Assessment`,
    subject: cls?.subject || opts.subject || 'Science',
    total_marks: blueprint.totalMarks, duration: blueprint.duration, blueprint: blueprint.summary,
    difficulty: opts.difficulty, medium: opts.medium,
    chapters: opts.chapters, instructions: opts.instructions,
    status: 'Draft', scheduled_for: null, generated_by: generated.generatedBy,
    created_at: now, updated_at: now
  }).select('*'));

  const aqRows = generated.questions.map((q, i) => ({
    assessment_id: a.id, question_id: q.questionId || null, section: q.section,
    position: i + 1, marks: q.marks, topic: q.topic, difficulty: q.difficulty,
    text: q.text, answer: q.answer, variant_text: q.variantText || null, variant_answer: q.variantAnswer || null
  }));
  if (aqRows.length) unwrap(await req.supabase.from('assessment_questions').insert(aqRows));

  // Every freshly generated question (not one pulled from the bank) also
  // lands in the reusable Question Bank.
  const bankRows = generated.questions
    .filter((q) => !q.questionId)
    .map((q) => ({
      user_id: req.user.id, class_id: cls?.id || null, grade: cls?.grade || null, subject: a.subject,
      chapter: opts.chapters[0] || 'General', topic: q.topic,
      type: q.marks === 1 ? 'MCQ' : (q.marks >= 5 ? 'Long' : q.marks === 2 ? 'Short' : 'Long'),
      marks: q.marks, difficulty: q.difficulty, medium: a.medium, text: q.text, answer: q.answer,
      variant_text: q.variantText || null, variant_answer: q.variantAnswer || null, source: 'ai', created_at: now
    }));
  if (bankRows.length) unwrap(await req.supabase.from('questions').insert(bankRows));

  return a;
}

router.post('/generate', wrap(async (req, res) => {
  const b = req.body || {};
  const marks = Number(b.totalMarks);
  const blueprint = blueprintFor(marks);
  if (!blueprint) throw badRequest(`Unsupported paper size. Choose one of: ${SUPPORTED_MARKS.join(', ')}`);
  const chapters = Array.isArray(b.chapters) ? b.chapters.filter(Boolean) : [];
  if (!chapters.length) throw badRequest('Select at least one chapter');

  const cls = b.classId
    ? (await req.supabase.from('classes').select('*').eq('id', b.classId).eq('user_id', req.user.id).single()).data
    : null;
  const medium = b.medium || cls?.medium || req.user.medium || 'English';
  const difficulty = b.difficulty || req.user.difficulty || 'Balanced';
  const instructions = defaultInstructions(blueprint, medium).concat(
    Array.isArray(b.customInstructions) ? b.customInstructions : []
  );

  const cost = paperCost(marks);
  const { balance } = await spend(req.supabase, cost, 'Generated paper',
    `${cls?.key || ''} · ${b.title || 'Assessment'} — ${blueprint.sections.reduce((n, s) => n + s.count, 0)} questions, ${marks} marks`);

  const bank = unwrap(await req.supabase
    .from('questions').select('*').eq('user_id', req.user.id).in('chapter', chapters)
    .order('created_at', { ascending: false }).limit(60));
  const weak = cls
    ? unwrap(await req.supabase.from('weak_concepts').select('concept').eq('user_id', req.user.id).eq('class_id', cls.id).eq('resolved', false))
      .map((w) => w.concept)
    : [];

  const generated = await generatePaper({
    board: cls?.board || 'CBSE', grade: cls?.grade || '10', subject: cls?.subject || 'Science',
    chapters, blueprint, difficulty, medium, customInstructions: b.customInstructions || [], bank, weakConcepts: weak
  });

  const assessment = await createDraft(req, cls, blueprint, {
    title: b.title || `${cls?.subject || 'Assessment'} — ${cls?.key || ''}`.trim(),
    subject: cls?.subject, chapters, instructions, difficulty, medium
  }, generated);

  const questions = await loadAssessmentQuestions(req, assessment.id);
  res.status(201).json({ assessment: viewAssessment(assessment, questions), balance, cost, generatedBy: generated.generatedBy });
}));

router.patch('/:id', wrap(async (req, res) => {
  const a = await loadAssessment(req);
  const b = req.body || {};
  const patch = { updated_at: nowIso() };
  if (b.title !== undefined) patch.title = b.title;
  if (b.status !== undefined) patch.status = b.status;
  if (b.scheduledFor !== undefined) patch.scheduled_for = b.scheduledFor;
  if (b.instructions !== undefined) patch.instructions = b.instructions;
  const [updated] = unwrap(await req.supabase.from('assessments').update(patch).eq('id', a.id).select('*'));
  res.json({ assessment: viewAssessment(updated) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const a = await loadAssessment(req);
  unwrap(await req.supabase.from('assessments').delete().eq('id', a.id));
  res.json({ ok: true });
}));

router.post('/:id/questions/:qid/regenerate', wrap(async (req, res) => {
  const a = await loadAssessment(req);
  const { data: aq, error } = await req.supabase.from('assessment_questions').select('*').eq('id', req.params.qid).eq('assessment_id', a.id).single();
  if (error || !aq) throw notFound('Question not found on this paper');
  const kind = ['similar', 'easier', 'harder'].includes(req.body?.kind) ? req.body.kind : 'similar';
  const cls = a.class_id ? (await req.supabase.from('classes').select('*').eq('id', a.class_id).maybeSingle()).data : null;
  const chapters = a.chapters || [];

  const cost = costOf('question_regenerate');
  const { balance } = await spend(req.supabase, cost, 'Regenerated question', `Question ${aq.position} · ${kind}`);

  const result = await regenerateQuestion({
    question: { text: aq.text, marks: aq.marks, topic: aq.topic, difficulty: aq.difficulty, variantText: aq.variant_text, variantAnswer: aq.variant_answer },
    kind, board: cls?.board || 'CBSE', grade: cls?.grade || '10', subject: a.subject, chapters, medium: a.medium
  });

  if (!result) {
    // Nothing to swap to and no API key — refund, nothing changed.
    const { balance: refundedBalance } = await grant(req.supabase, cost, 'Refund', 'Regeneration unavailable — no AI key and no bank alternative');
    return res.json({ question: viewAssessmentQuestion(aq), balance: refundedBalance, cost: 0, refunded: true });
  }

  const [updated] = unwrap(await req.supabase.from('assessment_questions')
    .update({ text: result.text, answer: result.answer, difficulty: result.difficulty, topic: result.topic })
    .eq('id', aq.id).select('*'));
  res.json({ question: viewAssessmentQuestion(updated), balance, cost, generatedBy: result.generatedBy });
}));

router.post('/:id/questions/:qid/swap', wrap(async (req, res) => {
  const a = await loadAssessment(req);
  const { data: aq, error } = await req.supabase.from('assessment_questions').select('*').eq('id', req.params.qid).eq('assessment_id', a.id).single();
  if (error || !aq) throw notFound('Question not found on this paper');
  if (!aq.variant_text) throw badRequest('No question-bank alternative is available for this question');

  const [updated] = unwrap(await req.supabase.from('assessment_questions').update({
    text: aq.variant_text, answer: aq.variant_answer || '', variant_text: aq.text, variant_answer: aq.answer, using_variant: true
  }).eq('id', aq.id).select('*'));
  res.json({ question: viewAssessmentQuestion(updated), cost: 0 });
}));

router.patch('/:id/questions/:qid', wrap(async (req, res) => {
  const a = await loadAssessment(req);
  const { data: aq, error } = await req.supabase.from('assessment_questions').select('id').eq('id', req.params.qid).eq('assessment_id', a.id).single();
  if (error || !aq) throw notFound('Question not found on this paper');
  const { text } = req.body || {};
  if (!text?.trim()) throw badRequest('text is required');
  const [updated] = unwrap(await req.supabase.from('assessment_questions').update({ text: text.trim() }).eq('id', aq.id).select('*'));
  res.json({ question: viewAssessmentQuestion(updated) });
}));

export default router;
