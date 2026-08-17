// AI Answer Evaluator — Max-plan feature. A teacher submits either transcribed
// text answers, or a photo/PDF of the actual sheet, for one student against
// one assessment; Gemini marks each item and flags any it isn't confident
// about. Confirmed results feed weak-concept detection.
import { Router } from 'express';
import multer from 'multer';
import { unwrap } from '../lib/supabase.js';
import { nowIso } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';
import { evaluateSheet, evaluateSheetFromFile, extractQuestionsFromFile } from '../lib/ai.js';
import { spend, grant, costOf, requireFeature } from '../lib/credits.js';
import { recomputeWeakConcepts } from '../lib/analytics.js';

const router = Router();

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 }, // 15MB — plenty for a scanned sheet, small enough to not tie up the process
  fileFilter: (req, file, cb) => cb(null, ACCEPTED_MIME.has(file.mimetype))
});

/** Results dashboard for one assessment — the "Student | Score | ->" table. */
router.get('/', wrap(async (req, res) => {
  const { assessmentId } = req.query;
  if (!assessmentId) throw badRequest('assessmentId is required');
  const rows = unwrap(await req.supabase
    .from('results')
    .select('id, score, max_score, ai_confidence, needs_review, reviewed, evaluated_at, students!inner(id, name)')
    .eq('user_id', req.user.id).eq('assessment_id', assessmentId)
    .order('evaluated_at', { ascending: false }));
  res.json({
    results: rows.map((r) => ({
      id: r.id, studentId: r.students.id, studentName: r.students.name,
      score: r.score, maxScore: r.max_score, aiConfidence: r.ai_confidence,
      needsReview: r.needs_review, reviewed: r.reviewed, evaluatedAt: r.evaluated_at
    }))
  });
}));

/**
 * Lets a teacher grade against a paper Staffroom never generated — they
 * upload the actual question paper (photo/PDF), Gemini reads it into a
 * gradable structure, and it's saved as a normal assessment so everything
 * downstream (batch grading, review, analytics) works exactly the same way.
 */
router.post('/from-paper', upload.single('file'), wrap(async (req, res) => {
  requireFeature(req.user, 'evaluator', 'AI Answer Evaluator');
  if (!req.file) throw badRequest('No file uploaded, or the file type isn’t supported (JPEG/PNG/WEBP/HEIC/PDF only)');
  const { classId, title } = req.body || {};

  const cls = classId
    ? (await req.supabase.from('classes').select('*').eq('id', classId).eq('user_id', req.user.id).single()).data
    : null;

  const cost = costOf('extract_paper');
  const { balance } = await spend(req.supabase, cost, 'Read uploaded question paper', title || req.file.originalname);

  const questions = await extractQuestionsFromFile({
    fileBuffer: req.file.buffer, mimeType: req.file.mimetype,
    board: cls?.board || 'CBSE', grade: cls?.grade || '', subject: cls?.subject || ''
  });

  if (!questions) {
    const { balance: refundedBalance } = await grant(req.supabase, cost, 'Refund', 'Could not read the uploaded paper');
    return res.json({ balance: refundedBalance, cost: 0, refunded: true, error: 'Could not read this file — try a clearer photo or scan.' });
  }

  const totalMarks = questions.reduce((s, q) => s + q.marks, 0);
  const now = nowIso();
  const [assessment] = unwrap(await req.supabase.from('assessments').insert({
    user_id: req.user.id, class_id: cls?.id || null,
    title: title?.trim() || req.file.originalname.replace(/\.[^.]+$/, ''),
    subject: cls?.subject || null, total_marks: totalMarks, duration: null, blueprint: `${questions.length} questions, uploaded paper`,
    difficulty: 'Balanced', medium: 'English', chapters: [], instructions: [],
    status: 'Distributed', scheduled_for: null, generated_by: 'uploaded', created_at: now, updated_at: now
  }).select('*'));

  unwrap(await req.supabase.from('assessment_questions').insert(
    questions.map((q, i) => ({
      assessment_id: assessment.id, question_id: null, section: 'A', position: i + 1,
      marks: q.marks, topic: q.topic, difficulty: 'Medium', text: q.text, answer: q.answer
    }))
  ));

  res.status(201).json({ assessment, balance, cost, questionCount: questions.length });
}));

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

/** Finds a student by id, or by name (creating a roster entry if needed). */
async function resolveStudent(req, assessment, studentId, studentName) {
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
  return student;
}

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

  const student = await resolveStudent(req, assessment, studentId, studentName);
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

/** Same as POST / above, but the sheet is a photo or PDF instead of typed-out text. */
router.post('/upload', upload.single('file'), wrap(async (req, res) => {
  requireFeature(req.user, 'evaluator', 'AI Answer Evaluator');
  const { assessmentId, studentId, studentName } = req.body || {};
  if (!assessmentId) throw badRequest('assessmentId is required');
  if (!req.file) throw badRequest('No file uploaded, or the file type isn’t supported (JPEG/PNG/WEBP/HEIC/PDF only)');

  const { data: assessment, error: aErr } = await req.supabase.from('assessments').select('*').eq('id', assessmentId).eq('user_id', req.user.id).single();
  if (aErr || !assessment) throw notFound('Assessment not found');

  const student = await resolveStudent(req, assessment, studentId, studentName);
  if (!student) throw badRequest('studentId or studentName is required');

  const questions = unwrap(await req.supabase.from('assessment_questions').select('*').eq('assessment_id', assessment.id).order('position'));
  if (!questions.length) throw badRequest('This assessment has no questions to grade against');
  const chapters = assessment.chapters || [];

  const cost = costOf('evaluate');
  const { balance } = await spend(req.supabase, cost, 'Evaluated answer sheet (upload)', `${assessment.title} · ${student.name}`);

  const outcome = await evaluateSheetFromFile({
    fileBuffer: req.file.buffer, mimeType: req.file.mimetype,
    questions: questions.map((q) => ({ aqId: q.id, position: q.position, marks: q.marks, topic: q.topic, text: q.text, answer: q.answer })),
    board: 'CBSE', grade: '10', subject: assessment.subject, medium: assessment.medium
  });

  if (!outcome) {
    // Nothing usable came back (blank/unreadable file, or no key) — refund, nothing saved.
    const { balance: refundedBalance } = await grant(req.supabase, cost, 'Refund', 'Could not read the uploaded sheet');
    return res.json({ balance: refundedBalance, cost: 0, refunded: true, error: 'Could not read this file — try a clearer photo or scan.' });
  }

  const marked = { items: outcome.items.map((it) => ({ ...it, chapter: chapters[0] || '' })) };
  const resultId = await saveResult(req, assessment, student, marked, outcome.generatedBy);
  await recomputeWeakConcepts(req.supabase, req.user.id, assessment.class_id);

  res.status(201).json({
    resultId, balance, cost, generatedBy: outcome.generatedBy,
    score: marked.items.reduce((s, it) => s + it.awarded, 0),
    maxScore: marked.items.reduce((s, it) => s + it.max, 0),
    items: marked.items
  });
}));

/** Full per-question breakdown for one student's checked sheet — the click-through from the results dashboard. */
router.get('/:resultId/detail', wrap(async (req, res) => {
  const { data: r, error } = await req.supabase
    .from('results')
    .select('*, students!inner(id, name), assessments!inner(id, title, total_marks)')
    .eq('id', req.params.resultId).eq('user_id', req.user.id).single();
  if (error || !r) throw notFound('Result not found');

  const items = unwrap(await req.supabase
    .from('result_items')
    .select('*, assessment_questions(position, text, marks, topic)')
    .eq('result_id', r.id));

  res.json({
    result: {
      id: r.id, score: r.score, maxScore: r.max_score, aiConfidence: r.ai_confidence,
      reviewed: r.reviewed, needsReview: r.needs_review, evaluatedAt: r.evaluated_at
    },
    student: { id: r.students.id, name: r.students.name },
    assessment: { id: r.assessments.id, title: r.assessments.title, totalMarks: r.assessments.total_marks },
    items: items
      .sort((a, b) => (a.assessment_questions?.position || 0) - (b.assessment_questions?.position || 0))
      .map((it) => ({
        aqId: it.aq_id, position: it.assessment_questions?.position, question: it.assessment_questions?.text,
        topic: it.topic, awarded: it.awarded, max: it.max_marks, comment: it.comment, confidence: it.confidence
      }))
  });
}));

router.post('/:resultId/review', wrap(async (req, res) => {
  const { data: r, error } = await req.supabase.from('results').select('*').eq('id', req.params.resultId).eq('user_id', req.user.id).single();
  if (error || !r) throw notFound('Result not found');
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (items) {
    for (const it of items) {
      // Matched by aq_id, not the result_item row's own id — the evaluation
      // response never included that internal id, only the question it's for.
      if (it.aqId) await req.supabase.from('result_items').update({ awarded: it.awarded }).eq('aq_id', it.aqId).eq('result_id', r.id);
    }
    const rows = unwrap(await req.supabase.from('result_items').select('awarded').eq('result_id', r.id));
    const total = rows.reduce((s, x) => s + Number(x.awarded), 0);
    await req.supabase.from('results').update({ score: total }).eq('id', r.id);
  }
  await req.supabase.from('results').update({ reviewed: true, needs_review: false }).eq('id', r.id);
  res.json({ ok: true });
}));

export default router;
