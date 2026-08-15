// Shapes DB rows the way the frontend expects. Postgres/PostgREST already
// returns jsonb columns as parsed JSON and booleans as real booleans, but
// `json()` stays defensive (passes non-strings through) in case a value ever
// arrives pre-serialized.
function json(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    school: u.school,
    plan: u.plan,
    billingPeriod: u.billing_period,
    credits: u.credits,
    allowance: u.allowance,
    creditsResetOn: u.credits_reset_on,
    boards: json(u.boards, []),
    grades: json(u.grades, []),
    subjects: json(u.subjects, []),
    medium: u.medium,
    difficulty: u.difficulty,
    questionMix: u.question_mix,
    lang: u.lang,
    notifications: json(u.notifications, {}),
    createdAt: u.created_at
  };
}

export function viewClass(c, extra = {}) {
  return {
    id: c.id,
    key: c.key,
    board: c.board,
    grade: c.grade,
    section: c.section,
    subject: c.subject,
    students: c.student_count,
    syllabus: c.syllabus,
    medium: c.medium,
    mix: c.question_mix,
    archived: Boolean(c.archived),
    ...extra
  };
}

export function viewQuestion(q) {
  return {
    id: q.id,
    classId: q.class_id,
    grade: q.grade,
    subject: q.subject,
    chapter: q.chapter,
    topic: q.topic,
    type: q.type,
    marks: q.marks,
    difficulty: q.difficulty,
    medium: q.medium,
    text: q.text,
    answer: q.answer,
    variantText: q.variant_text,
    variantAnswer: q.variant_answer,
    source: q.source,
    favorite: Boolean(q.favorite),
    shortlisted: Boolean(q.shortlisted),
    createdAt: q.created_at
  };
}

export function viewMaterial(m) {
  return {
    id: m.id,
    classId: m.class_id,
    type: m.type,
    title: m.title,
    chapter: m.chapter,
    concept: m.concept,
    body: m.body,
    generatedBy: m.generated_by,
    createdAt: m.created_at
  };
}

export function viewAssessment(a, questions = null) {
  return {
    id: a.id,
    classId: a.class_id,
    title: a.title,
    subject: a.subject,
    totalMarks: a.total_marks,
    duration: a.duration,
    blueprint: a.blueprint,
    difficulty: a.difficulty,
    medium: a.medium,
    chapters: json(a.chapters, []),
    instructions: json(a.instructions, []),
    status: a.status,
    scheduledFor: a.scheduled_for,
    generatedBy: a.generated_by,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    ...(questions ? { questions: questions.map(viewAssessmentQuestion) } : {})
  };
}

export function viewAssessmentQuestion(q) {
  return {
    id: q.id,
    questionId: q.question_id,
    section: q.section,
    position: q.position,
    marks: q.marks,
    topic: q.topic,
    difficulty: q.difficulty,
    text: q.text,
    answer: q.answer,
    variantText: q.variant_text,
    variantAnswer: q.variant_answer,
    usingVariant: Boolean(q.using_variant)
  };
}

export function viewWeakConcept(w) {
  return {
    id: w.id,
    classId: w.class_id,
    concept: w.concept,
    severity: w.severity,
    trend: w.trend,
    scorePct: w.score_pct,
    sampleSize: w.sample_size,
    resolved: Boolean(w.resolved),
    detectedAt: w.detected_at
  };
}

export function viewLedgerEntry(l) {
  return {
    action: l.action,
    detail: l.detail,
    delta: l.delta,
    balanceAfter: l.balance_after,
    createdAt: l.created_at
  };
}
