// AI layer — Google Gemini.
//
// Every function here returns the same shape whether it was answered by Gemini
// or by the offline fallback, and reports which one via `generatedBy`. The
// fallback assembles from the teacher's own question bank so the app is usable
// (and testable) without a key; it never invents new content.

import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

let client = null;
export function geminiAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function genai() {
  if (!geminiAvailable()) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const SYSTEM = `You are an experienced Indian school teacher writing assessment material.
Rules you never break:
- Stay strictly inside the given board, class, subject and chapter list.
- Follow the marks blueprint exactly: the number of questions per section and the marks per question are fixed.
- Write in the requested medium (English or हिन्दी). Never mix scripts inside one question.
- Every question needs a marking-scheme style answer, with the mark split shown for multi-mark questions.
- MCQs must have exactly four options labelled (a) (b) (c) (d) inline in the question text.
- Use plain text with unicode symbols (×, ⁸, ∠, ½). No markdown, no LaTeX.
Return only JSON matching the requested shape.`;

async function askJson(prompt, { temperature = 0.7 } = {}) {
  const ai = genai();
  if (!ai) return null;
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM,
      temperature,
      responseMimeType: 'application/json'
    }
  });
  return parseJson(res.text);
}

/**
 * Same as askJson, but the prompt is paired with an image/PDF file (Gemini
 * reads it directly — no separate OCR step). Used by the photo/PDF Answer
 * Evaluator so handwritten sheets can be graded straight from a scan.
 */
async function askJsonWithFile(prompt, { mimeType, data, temperature = 0.2 } = {}) {
  const ai = genai();
  if (!ai) return null;
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: 'user',
      parts: [{ text: prompt }, { inlineData: { mimeType, data } }]
    }],
    config: {
      systemInstruction: SYSTEM,
      temperature,
      responseMimeType: 'application/json'
    }
  });
  return parseJson(res.text);
}

function parseJson(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Models occasionally wrap the array in prose — grab the outermost braces.
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ papers */

/**
 * @param {object} opts
 * @param {{key:string,marks:number,count:number,type:string}[]} opts.blueprint.sections
 * @param {Array} opts.bank  questions already in the teacher's bank (fallback source + repeat avoidance)
 */
export async function generatePaper(opts) {
  const {
    board, grade, subject, chapters, blueprint, difficulty, medium,
    customInstructions = [], bank = [], weakConcepts = []
  } = opts;

  const sectionSpec = blueprint.sections
    .map((s) => `Section ${s.key}: ${s.count} question(s) worth ${s.marks} mark(s) each, style: ${s.type}`)
    .join('\n');

  const avoid = bank.slice(0, 40).map((q) => `- ${q.text.slice(0, 120)}`).join('\n');

  const prompt = `Write a complete question paper.

Board: ${board}
Class: ${grade}
Subject: ${subject}
Chapters in the portion: ${chapters.join('; ')}
Total marks: ${blueprint.totalMarks}
Difficulty stance: ${difficulty} (Gentle = mostly recall, Balanced = mixed, Challenge = application heavy)
Medium: ${medium}

Blueprint (follow exactly):
${sectionSpec}
${customInstructions.length ? `\nTeacher's extra instructions:\n${customInstructions.map((c) => `- ${c}`).join('\n')}` : ''}
${weakConcepts.length ? `\nThis class is weak on: ${weakConcepts.join('; ')}. Include at least one question on each, but do not make the whole paper about them.` : ''}
${avoid ? `\nDo NOT repeat these questions already in the teacher's bank:\n${avoid}` : ''}

Return JSON: {"questions":[{"section":"A","marks":1,"topic":"...","difficulty":"Easy|Medium|Hard","type":"MCQ|Short|Long|Case","text":"...","answer":"...","variantText":"...","variantAnswer":"..."}]}
"variantText"/"variantAnswer" are an alternative question of the same topic, marks and difficulty — the teacher uses it to swap one out.
The questions array must be in section order and contain exactly ${blueprint.sections.reduce((n, s) => n + s.count, 0)} items.`;

  const data = await askJson(prompt, { temperature: difficulty === 'Challenge' ? 0.85 : 0.7 });
  const questions = normalizePaper(data, blueprint);
  if (questions) return { questions, generatedBy: 'gemini' };

  return { questions: assembleFromBank(blueprint, bank, medium), generatedBy: 'offline' };
}

function normalizePaper(data, blueprint) {
  const list = Array.isArray(data) ? data : data?.questions;
  if (!Array.isArray(list) || !list.length) return null;

  const out = [];
  let cursor = 0;
  for (const spec of blueprint.sections) {
    for (let i = 0; i < spec.count; i++) {
      const raw = list[cursor] || list.find((q) => q && q.section === spec.key && !out.includes(q));
      cursor++;
      if (!raw || !raw.text) return null;
      out.push({
        section: spec.key,
        marks: spec.marks,
        type: spec.type,
        topic: String(raw.topic || '').slice(0, 120) || spec.type,
        difficulty: ['Easy', 'Medium', 'Hard'].includes(raw.difficulty) ? raw.difficulty : 'Medium',
        text: String(raw.text).trim(),
        answer: String(raw.answer || '').trim(),
        variantText: raw.variantText ? String(raw.variantText).trim() : null,
        variantAnswer: raw.variantAnswer ? String(raw.variantAnswer).trim() : null
      });
    }
  }
  return out;
}

/** Offline fallback: pick the best-fitting bank questions for each slot. */
function assembleFromBank(blueprint, bank, medium) {
  const pool = bank.filter((q) => !q.medium || q.medium === medium);
  const used = new Set();
  const out = [];

  for (const spec of blueprint.sections) {
    for (let i = 0; i < spec.count; i++) {
      const pick =
        pool.find((q) => !used.has(q.id) && q.marks === spec.marks && q.type === spec.type) ||
        pool.find((q) => !used.has(q.id) && q.marks === spec.marks) ||
        pool.find((q) => !used.has(q.id));
      if (pick) used.add(pick.id);
      out.push({
        section: spec.key,
        marks: spec.marks,
        type: spec.type,
        topic: pick?.topic || 'General',
        difficulty: pick?.difficulty || 'Medium',
        text: pick?.text || `[Add a ${spec.marks}-mark ${spec.type} question here — no bank question was available for this slot.]`,
        answer: pick?.answer || '',
        variantText: pick?.variant_text || null,
        variantAnswer: pick?.variant_answer || null,
        questionId: pick?.id || null
      });
    }
  }
  return out;
}

/* --------------------------------------------------------- one question */

export async function regenerateQuestion({ question, kind, board, grade, subject, chapters, medium }) {
  const stance = {
    similar: 'same topic, same marks, same difficulty — just a different question',
    easier: 'same topic and marks but noticeably easier — more recall, less application',
    harder: 'same topic and marks but harder — multi-step or application heavy'
  }[kind] || 'same topic, same marks, same difficulty';

  const prompt = `Rewrite one question in a ${board} class ${grade} ${subject} paper.

Chapters in the portion: ${chapters.join('; ')}
Medium: ${medium}
Marks: ${question.marks}
Topic: ${question.topic}
Requirement: ${stance}

Current question:
${question.text}

Return JSON: {"text":"...","answer":"...","difficulty":"Easy|Medium|Hard","topic":"..."}`;

  const data = await askJson(prompt, { temperature: 0.9 });
  if (data?.text) {
    return {
      text: String(data.text).trim(),
      answer: String(data.answer || '').trim(),
      difficulty: ['Easy', 'Medium', 'Hard'].includes(data.difficulty)
        ? data.difficulty
        : kind === 'easier' ? 'Easy' : kind === 'harder' ? 'Hard' : question.difficulty,
      topic: data.topic || question.topic,
      generatedBy: 'gemini'
    };
  }

  // Offline: fall back to the stored variant, which is what "swap from bank" uses.
  if (question.variantText) {
    return {
      text: question.variantText,
      answer: question.variantAnswer || '',
      difficulty: kind === 'easier' ? 'Easy' : kind === 'harder' ? 'Hard' : question.difficulty,
      topic: question.topic,
      generatedBy: 'offline'
    };
  }
  return null;
}

/* -------------------------------------------------------------- syllabus */

/**
 * Looks up the real chapter list for a board/grade/subject so a newly added
 * class doesn't start with an empty "Chapters to cover" picker. Offline
 * fallback is a small set of boards' most common CBSE Science/Maths chapters
 * for grades 9-10 — good enough to keep the app usable without a key, but
 * genuinely research the syllabus once Gemini is available.
 */
export async function generateSyllabus({ board, grade, subject }) {
  const prompt = `List the complete chapter-wise syllabus for this exact course.

Board: ${board}
Class: ${grade}
Subject: ${subject}
Academic year: current

Return every chapter for the full-year syllabus, in the board's official teaching order.

Return JSON: {"chapters":[{"name":"...","topics":number}]}
"name" is the official chapter title as printed in the board's textbook (no numbering prefix).
"topics" is a rough count of distinct sub-topics/sections within that chapter (an integer, typically 3-8).`;

  const data = await askJson(prompt, { temperature: 0.3 });
  const list = Array.isArray(data?.chapters) ? data.chapters : null;
  if (list && list.length) {
    const chapters = list
      .filter((c) => c && c.name)
      .map((c) => ({ name: String(c.name).trim(), topics: Math.max(1, Math.round(Number(c.topics)) || 4) }));
    if (chapters.length) return { chapters, generatedBy: 'gemini' };
  }

  const fallback = OFFLINE_SYLLABUS[`${grade}|${subject}`.toLowerCase()] || OFFLINE_SYLLABUS.default;
  return { chapters: fallback.map((name) => ({ name, topics: 4 })), generatedBy: 'offline' };
}

const OFFLINE_SYLLABUS = {
  '9|science': [
    'Matter in Our Surroundings', 'Is Matter Around Us Pure', 'Atoms and Molecules',
    'Structure of the Atom', 'The Fundamental Unit of Life', 'Tissues',
    'Motion', 'Force & Laws of Motion', 'Gravitation', 'Work and Energy', 'Sound'
  ],
  '10|science': [
    'Chemical Reactions and Equations', 'Acids, Bases and Salts', 'Metals and Non-metals',
    'Carbon and its Compounds', 'Life Processes', 'Control and Coordination',
    'Light — Reflection and Refraction', 'The Human Eye and the Colourful World',
    'Electricity', 'Magnetic Effects of Electric Current'
  ],
  '9|mathematics': [
    'Number Systems', 'Polynomials', 'Coordinate Geometry', 'Linear Equations in Two Variables',
    'Lines and Angles', 'Triangles', 'Quadrilaterals', 'Circles', 'Heron’s Formula',
    'Surface Areas and Volumes', 'Statistics', 'Probability'
  ],
  '10|mathematics': [
    'Real Numbers', 'Polynomials', 'Pair of Linear Equations in Two Variables',
    'Quadratic Equations', 'Arithmetic Progressions', 'Triangles', 'Coordinate Geometry',
    'Trigonometry', 'Circles', 'Areas Related to Circles', 'Surface Areas and Volumes',
    'Statistics', 'Probability'
  ],
  default: ['Unit 1', 'Unit 2', 'Unit 3', 'Unit 4']
};

/* ------------------------------------------------------------- materials */

const MATERIAL_BRIEF = {
  NOTES: 'concise revision notes: definitions, key formulae, 3-5 worked points, and a "commonly confused" callout',
  WORKSHEET: 'a practice worksheet of 5 questions of mixed difficulty with a full answer key',
  QUIZ: 'a 10-question MCQ quiz with four options each and an answer key',
  'LESSON PLAN': 'a period-by-period lesson plan with objectives, teaching flow, board work, and a check-for-understanding'
};

export async function generateMaterial({ type, title, chapter, concept, board, grade, subject, medium }) {
  const kind = String(type).toUpperCase();
  const brief = MATERIAL_BRIEF[kind] || MATERIAL_BRIEF.NOTES;

  const prompt = `Write ${brief}.

Board: ${board}
Class: ${grade}
Subject: ${subject}
Chapter: ${chapter || concept}
${concept ? `This is remediation for a weak concept: "${concept}". Target exactly that gap.` : ''}
Medium: ${medium}

Return JSON: {"title":"...","body":"..."}
"body" is plain text with line breaks, ready to print. No markdown headers.`;

  const data = await askJson(prompt, { temperature: 0.7 });
  if (data?.body) {
    return {
      title: String(data.title || title || chapter || concept).trim(),
      body: String(data.body).trim(),
      generatedBy: 'gemini'
    };
  }
  return {
    title: title || `${concept || chapter} — ${kind.toLowerCase()}`,
    body:
      `[Generated offline — set GEMINI_API_KEY for AI-written material.]\n\n` +
      `${kind} for ${board} Class ${grade} ${subject}\nChapter: ${chapter || concept}\n\n` +
      `Add your content here.`,
    generatedBy: 'offline'
  };
}

/* ------------------------------------------------------------ evaluation */

/**
 * Marks one student's answer sheet.
 * @param {{question:string, answer:string, marks:number, studentAnswer:string, topic:string}[]} items
 */
export async function evaluateSheet({ items, board, grade, subject, medium }) {
  const prompt = `Mark this answer sheet the way a ${board} class ${grade} ${subject} teacher would.

For each question you get the question, the marking scheme, the maximum marks, and the student's answer.
Award marks per the scheme, give partial credit, and be honest about uncertainty:
"confidence" is 0..1 — use below 0.7 when the handwriting-transcribed answer is ambiguous,
partially relevant, or when the marking scheme does not cleanly cover what the student wrote.
Medium: ${medium}

${items.map((it, i) => `Q${i + 1} (${it.marks} marks) — topic: ${it.topic}
Question: ${it.question}
Marking scheme: ${it.answer}
Student answer: ${it.studentAnswer || '(blank)'}`).join('\n\n')}

Return JSON: {"items":[{"awarded":number,"confidence":number,"comment":"one short line for the teacher"}]}
The items array must have exactly ${items.length} entries, in order.`;

  const data = await askJson(prompt, { temperature: 0.2 });
  const marked = Array.isArray(data?.items) ? data.items : null;

  if (marked && marked.length === items.length) {
    return {
      items: items.map((it, i) => {
        const m = marked[i] || {};
        const awarded = clamp(Number(m.awarded) || 0, 0, it.marks);
        return {
          awarded,
          confidence: clamp(Number(m.confidence ?? 0.8), 0, 1),
          comment: String(m.comment || '').slice(0, 300)
        };
      }),
      generatedBy: 'gemini'
    };
  }

  // Offline: no marking is invented. Everything is returned unmarked and flagged
  // so the teacher sees exactly what still needs a human.
  return {
    items: items.map(() => ({
      awarded: 0,
      confidence: 0,
      comment: 'Not evaluated — AI evaluation needs GEMINI_API_KEY. Mark manually.'
    })),
    generatedBy: 'offline'
  };
}

/**
 * Reads a scanned/photographed answer sheet directly (image or PDF) and
 * grades it against the assessment's actual questions in one pass — no
 * separate transcription step. Gemini both transcribes and marks each
 * numbered answer it can find on the page(s).
 * @param {{fileBuffer:Buffer, mimeType:string, questions:{aqId:string,position:number,marks:number,topic:string,text:string,answer:string}[], board:string, grade:string, subject:string, medium:string}} opts
 */
export async function evaluateSheetFromFile({ fileBuffer, mimeType, questions, board, grade, subject, medium }) {
  const prompt = `This file is a photographed or scanned answer sheet from a ${board} class ${grade} ${subject} exam, written by hand or typed by a student.

Read the student's answers directly from the file. Match them to the question numbers below by the numbering the student wrote (e.g. "Q3", "3.", "Answer 3") — students may answer out of order or skip questions.
Medium: ${medium}

Questions on this paper, with the marking scheme and maximum marks for each:
${questions.map((q) => `Q${q.position} (${q.marks} marks) — topic: ${q.topic}
Question: ${q.text}
Marking scheme: ${q.answer}`).join('\n\n')}

For each question above, find the student's answer in the file (if any), award marks per the scheme with partial credit where earned, and note what you actually read.
"confidence" is 0..1 — use below 0.7 when handwriting is hard to read, the answer is ambiguous, or you could not find that question on the sheet at all (treat a genuinely missing answer as 0 marks, low confidence, and say so in the comment).

Return JSON: {"items":[{"position":number,"transcribed":"what the student actually wrote, briefly","awarded":number,"confidence":number,"comment":"one short line for the teacher"}]}
The items array must have exactly ${questions.length} entries, one per question above, in the same order.`;

  const data = await askJsonWithFile(prompt, { mimeType, data: fileBuffer.toString('base64'), temperature: 0.15 });
  const marked = Array.isArray(data?.items) ? data.items : null;

  if (marked && marked.length === questions.length) {
    return {
      items: questions.map((q, i) => {
        const m = marked[i] || {};
        const awarded = clamp(Number(m.awarded) || 0, 0, q.marks);
        return {
          aqId: q.aqId, topic: q.topic, max: q.marks,
          awarded,
          confidence: clamp(Number(m.confidence ?? 0.5), 0, 1),
          comment: String(m.comment || '').slice(0, 300),
          transcribed: String(m.transcribed || '').slice(0, 500)
        };
      }),
      generatedBy: 'gemini'
    };
  }

  return null; // caller decides how to handle "couldn't read this file at all"
}

/**
 * Reads just the student-identity header off a sheet (name / roll number) —
 * used to match an uploaded file to a roster entry before grading it, for
 * the batch upload modes (ZIP of sheets, or one combined multi-student PDF).
 */
export async function extractSheetIdentity({ fileBuffer, mimeType }) {
  const prompt = `This file is one student's answer sheet from a school exam. Read only the header/cover area
(the part with the student's name and/or roll number — usually top of the first page).

Return JSON: {"name":"...","rollNo":"..."}
Use "" for either field if it genuinely isn't visible anywhere on the page. Do not guess.`;
  const data = await askJsonWithFile(prompt, { mimeType, data: fileBuffer.toString('base64'), temperature: 0 });
  return { name: String(data?.name || '').trim(), rollNo: String(data?.rollNo || '').trim() };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
