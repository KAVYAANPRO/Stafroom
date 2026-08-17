// Note Maker — Pro/Max feature. A teacher picks a class and one or more
// chapters, optionally personalises the output with weak-concept analytics
// for the class or one student, and optionally uploads their own reference
// notes for Gemini to read first. Output is saved as a `materials` row of
// type NOTES (same table Materials uses) so it shows up in both places.
import { Router } from 'express';
import multer from 'multer';
import { unwrap } from '../lib/supabase.js';
import { nowIso } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { wrap } from '../lib/middleware.js';
import { generateSmartNotes, extractNotesFromFile } from '../lib/ai.js';
import { spend, grant, costOf, requireFeature } from '../lib/credits.js';
import { viewMaterial } from '../lib/view.js';
import { topicStrength } from '../lib/analytics.js';

const router = Router();

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ACCEPTED_MIME.has(file.mimetype))
});

/** Notes generated through this flow — most recent first. */
router.get('/', wrap(async (req, res) => {
  requireFeature(req.user, 'notes', 'Notes Maker');
  let query = req.supabase.from('materials').select('*').eq('user_id', req.user.id).eq('type', 'NOTES');
  if (req.query.classId) query = query.eq('class_id', req.query.classId);
  const rows = unwrap(await query.order('created_at', { ascending: false }).limit(50));
  res.json({ materials: rows.map(viewMaterial) });
}));

/**
 * Reads a teacher-uploaded reference notes file (photo/PDF) and returns its
 * transcribed text. Doesn't save anything — the client holds the text and
 * sends it along with POST /generate, so a re-generate doesn't re-charge for
 * reading the same file twice.
 */
router.post('/reference', upload.single('file'), wrap(async (req, res) => {
  requireFeature(req.user, 'notes', 'Notes Maker');
  if (!req.file) throw badRequest('No file uploaded, or the file type isn’t supported (JPEG/PNG/WEBP/HEIC/PDF only)');

  const cost = costOf('note_maker_reference');
  const { balance } = await spend(req.supabase, cost, 'Read reference notes', req.file.originalname);

  const text = await extractNotesFromFile({ fileBuffer: req.file.buffer, mimeType: req.file.mimetype });
  if (!text) {
    const { balance: refundedBalance } = await grant(req.supabase, cost, 'Refund', 'Could not read the uploaded notes');
    return res.json({ balance: refundedBalance, cost: 0, refunded: true, error: 'Could not read this file — try a clearer photo or scan.' });
  }

  res.json({ balance, cost, referenceText: text });
}));

router.post('/generate', wrap(async (req, res) => {
  requireFeature(req.user, 'notes', 'Notes Maker');
  const { classId, chapters, studentId, useAnalytics, referenceText, title } = req.body || {};
  const chapterList = Array.isArray(chapters) ? chapters.map((c) => String(c).trim()).filter(Boolean) : [];
  if (!classId) throw badRequest('classId is required');
  if (!chapterList.length) throw badRequest('Pick at least one chapter');

  const { data: cls, error: cErr } = await req.supabase.from('classes').select('*').eq('id', classId).eq('user_id', req.user.id).single();
  if (cErr || !cls) throw notFound('Class not found');

  let student = null;
  if (studentId) {
    const { data } = await req.supabase.from('students').select('*').eq('id', studentId).eq('user_id', req.user.id).single();
    if (!data) throw notFound('Student not found');
    student = data;
  }

  let weakConcepts = [];
  if (useAnalytics) {
    const topics = await topicStrength(req.supabase, req.user.id, cls.id, student?.id || null);
    weakConcepts = topics.filter((t) => t.pct < 60).slice(0, 5).map((t) => t.name);
  }

  const cost = costOf('note_maker', { chapters: chapterList.length });
  const { balance } = await spend(
    req.supabase, cost, 'Generated notes',
    `${cls.key} · ${chapterList.join(', ')}${student ? ' · ' + student.name : ''}`
  );

  const result = await generateSmartNotes({
    board: cls.board, grade: cls.grade, subject: cls.subject, medium: cls.medium,
    chapters: chapterList, weakConcepts, referenceText: referenceText || ''
  });

  const now = nowIso();
  const [created] = unwrap(await req.supabase.from('materials').insert({
    user_id: req.user.id, class_id: cls.id, student_id: student?.id || null,
    type: 'NOTES', title: title?.trim() || result.title, chapter: chapterList[0], concept: null,
    chapters: chapterList, body: result.body,
    reference_text: referenceText ? String(referenceText).slice(0, 8000) : null,
    used_analytics: Boolean(useAnalytics && weakConcepts.length),
    generated_by: result.generatedBy, created_at: now
  }).select('*'));

  res.status(201).json({ material: viewMaterial(created), balance, cost, generatedBy: result.generatedBy, weakConcepts });
}));

export default router;
