// Turns raw results/result_items into the class- and student-level views the
// Analytics and Dashboard pages need, and derives weak concepts from topic
// performance across evaluated assessments — the "one connected loop" the
// landing page promises: Evaluate feeds Diagnose feeds Remediate.
//
// PostgREST's query builder doesn't do arbitrary GROUP BY/SUM, so these fetch
// the joined rows and aggregate in JS instead — simple and plenty fast at
// this app's scale (a single teacher's data, at most a few thousand rows).
import { nowIso } from './ids.js';
import { unwrap } from './supabase.js';

function pct(awarded, max) {
  return max > 0 ? Math.round((awarded / max) * 100) : null;
}

export async function classChart(db, userId, classId, limit = 4) {
  const rows = unwrap(await db
    .from('result_items')
    .select('awarded, max_marks, results!inner(assessment_id, assessments!inner(id, title, created_at, user_id, class_id))')
    .eq('results.assessments.user_id', userId)
    .eq('results.assessments.class_id', classId));

  const byAssessment = new Map();
  for (const r of rows) {
    const a = r.results.assessments;
    if (!byAssessment.has(a.id)) byAssessment.set(a.id, { title: a.title, created_at: a.created_at, got: 0, max: 0 });
    const bucket = byAssessment.get(a.id);
    bucket.got += Number(r.awarded) || 0;
    bucket.max += Number(r.max_marks) || 0;
  }
  const withPct = [...byAssessment.values()]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((r) => ({ title: r.title, date: r.created_at, pct: pct(r.got, r.max) }))
    .filter((r) => r.pct !== null);
  return withPct.slice(-limit);
}

export async function classAssessmentComparison(db, userId, classId) {
  const assessments = unwrap(await db
    .from('assessments').select('id, title, created_at')
    .eq('user_id', userId).eq('class_id', classId).order('created_at', { ascending: false }));
  if (!assessments.length) return [];

  const results = unwrap(await db
    .from('results').select('assessment_id, score, max_score')
    .in('assessment_id', assessments.map((a) => a.id)));

  const byAssessment = new Map();
  for (const r of results) {
    if (!byAssessment.has(r.assessment_id)) byAssessment.set(r.assessment_id, []);
    const p = pct(r.score, r.max_score);
    if (p !== null) byAssessment.get(r.assessment_id).push(p);
  }
  return assessments
    .map((a) => {
      const scores = byAssessment.get(a.id) || [];
      if (!scores.length) return null;
      return {
        title: a.title, date: a.created_at,
        avg: Math.round(scores.reduce((x, y) => x + y, 0) / scores.length),
        high: Math.max(...scores), low: Math.min(...scores)
      };
    })
    .filter(Boolean);
}

export async function topicStrength(db, userId, classId, studentId = null) {
  let q = db
    .from('result_items')
    .select('topic, awarded, max_marks, results!inner(student_id, assessments!inner(user_id, class_id))')
    .eq('results.assessments.user_id', userId)
    .eq('results.assessments.class_id', classId);
  if (studentId) q = q.eq('results.student_id', studentId);
  const rows = unwrap(await q);

  const byTopic = new Map();
  for (const r of rows) {
    if (!r.topic) continue;
    if (!byTopic.has(r.topic)) byTopic.set(r.topic, { got: 0, max: 0 });
    const bucket = byTopic.get(r.topic);
    bucket.got += Number(r.awarded) || 0;
    bucket.max += Number(r.max_marks) || 0;
  }
  return [...byTopic.entries()]
    .map(([name, b]) => ({ name, pct: pct(b.got, b.max) }))
    .filter((t) => t.pct !== null)
    .sort((a, b) => a.pct - b.pct);
}

/**
 * A concept is "weak" when it averages under 60% across at least two graded
 * questions in the same class. Severity and trend come from how it's moving.
 */
export async function recomputeWeakConcepts(db, userId, classId) {
  const rows = unwrap(await db
    .from('result_items')
    .select('topic, awarded, max_marks, results!inner(assessments!inner(user_id, class_id, created_at))')
    .eq('results.assessments.user_id', userId)
    .eq('results.assessments.class_id', classId)
    .order('created_at', { referencedTable: 'results.assessments', ascending: true }));

  const byTopic = new Map();
  for (const r of rows) {
    if (!r.topic) continue;
    if (!byTopic.has(r.topic)) byTopic.set(r.topic, []);
    byTopic.get(r.topic).push(pct(r.awarded, r.max_marks));
  }

  const now = nowIso();
  for (const [topic, scoresRaw] of byTopic) {
    const scores = scoresRaw.filter((s) => s !== null);
    if (scores.length < 2) continue;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg >= 60) {
      await db.from('weak_concepts').update({ resolved: true }).eq('user_id', userId).eq('class_id', classId).eq('concept', topic);
      continue;
    }
    const first = scores[0], lastVal = scores[scores.length - 1];
    const trend = scores.length < 3 ? 'new signal — first test' : lastVal > first + 5 ? 'improving slowly' : lastVal < first - 5 ? 'declining' : 'flat across tests';
    const severity = avg < 45 ? 'High' : 'Medium';

    const { data: existing } = await db.from('weak_concepts').select('id')
      .eq('user_id', userId).eq('class_id', classId).eq('concept', topic).maybeSingle();
    if (existing) {
      await db.from('weak_concepts')
        .update({ severity, trend, score_pct: avg, sample_size: scores.length, resolved: false, detected_at: now })
        .eq('id', existing.id);
    } else {
      await db.from('weak_concepts').insert({
        user_id: userId, class_id: classId, concept: topic, severity, trend,
        score_pct: avg, sample_size: scores.length, detected_at: now
      });
    }
  }
}
