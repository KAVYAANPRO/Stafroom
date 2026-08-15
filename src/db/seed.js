// Seeds one demo teacher (Priya Sharma) with the same classes, chapters and
// question bank shown in the design mocks, plus a term's worth of evaluated
// assessments so Analytics/Dashboard show real trends on first login. Also
// creates the three plan-tier test accounts (Free/Pro/Max) used for review.
//
// Runs against Supabase directly with the service_role (admin) client, which
// bypasses RLS — appropriate here since this is a one-off seeding script, not
// a request made on behalf of a signed-in teacher.
import 'dotenv/config';
import { admin } from '../lib/supabase.js';
import { nowIso } from '../lib/ids.js';
import { recomputeWeakConcepts } from '../lib/analytics.js';

const now = nowIso();

async function findUserByEmail(email) {
  // The admin SDK paginates; the demo dataset is tiny so one page is plenty.
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw error;
  return data.users.find((u) => u.email === email) || null;
}

async function ensureUser(email, password, name) {
  const existing = await findUserByEmail(email);
  if (existing) return existing.id;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name }
  });
  if (error) throw error;
  return data.user.id;
}

async function setPlan(userId, plan, credits) {
  await admin.from('profiles').update({ plan, credits, allowance: credits }).eq('id', userId);
}

async function seedSimpleAccount(n, plan, credits) {
  const email = `test${n}@staffroom.dev`;
  const userId = await ensureUser(email, 'test1234', `Test User ${n}`);
  await setPlan(userId, plan, credits);
  console.log(`Seeded ${email} / test1234 — ${plan} plan`);
}

async function seedDemoTeacher() {
  const email = 'priya.sharma@email.com';
  const existing = await findUserByEmail(email);
  if (existing) {
    console.log('Demo teacher already present — skipping full reseed. Delete the user in Supabase Auth to reseed from scratch.');
    return;
  }

  const userId = await ensureUser(email, 'teach1234', 'Priya Sharma');
  await admin.from('profiles').update({
    phone: '+91 98xxxxxx21', school: 'Ashoka Public School, Pune',
    plan: 'Max', billing_period: 'monthly', credits: 1234, allowance: 2500,
    boards: ['CBSE'], grades: ['9', '10'], subjects: ['Science']
  }).eq('id', userId);

  const classDefs = [
    { key: '9-A', grade: '9', subject: 'Science', students: 38, chapters: [['Force & Laws of Motion', 6], ['Sound', 5], ['Tissues', 5]] },
    { key: '9-B', grade: '9', subject: 'Science', students: 40, chapters: [['Force & Laws of Motion', 6], ['Sound', 5], ['Tissues', 5]] },
    { key: '10-A', grade: '10', subject: 'Science', students: 42, chapters: [
      ['Light — Reflection and Refraction', 6], ['The Human Eye and the Colourful World', 5],
      ['Electricity', 7], ['Magnetic Effects of Electric Current', 5],
      ['Chemical Reactions and Equations', 4], ['Acids, Bases and Salts', 6]
    ] }
  ];

  const classIds = {};
  const studentsByClass = {};
  for (const c of classDefs) {
    const { data: cls, error } = await admin.from('classes').insert({
      user_id: userId, key: c.key, board: 'CBSE', grade: c.grade, section: c.key.split('-')[1],
      subject: c.subject, student_count: c.students, syllabus: '2026-27', medium: 'English',
      question_mix: 'Short-answer heavy', created_at: now
    }).select('id').single();
    if (error) throw error;
    classIds[c.key] = cls.id;

    await admin.from('chapters').insert(
      c.chapters.map(([name, topics], i) => ({ user_id: userId, class_id: cls.id, name, topic_count: topics, position: i }))
    );

    const names = ['Rohan S.', 'Ananya V.', 'Sameer K.', 'Zoya A.', 'Aarav D.', 'Ishita R.', 'Kabir M.', 'Diya P.'];
    const { data: students } = await admin.from('students').insert(
      names.slice(0, Math.min(8, c.students)).map((name, i) => ({ user_id: userId, class_id: cls.id, name, roll_no: i + 1, created_at: now }))
    ).select('id');
    studentsByClass[c.key] = students || [];
  }

  const QDATA = [
    { chapter: 'Light — Reflection and Refraction', topic: 'Plane mirrors', type: 'MCQ', marks: 1, diff: 'Easy',
      text: 'The focal length of a plane mirror is:  (a) 0   (b) infinite   (c) 25 cm   (d) −25 cm',
      answer: '(b) infinite — a plane mirror’s radius of curvature is infinite.',
      variantText: 'An object is placed at the centre of curvature of a concave mirror. Its image is:  (a) virtual and erect   (b) real, inverted and of the same size   (c) real and enlarged   (d) formed at infinity',
      variantAnswer: '(b) real, inverted and of the same size, formed at C.' },
    { chapter: 'Light — Reflection and Refraction', topic: 'Spherical mirrors', type: 'MCQ', marks: 1, diff: 'Easy',
      text: 'Convex mirrors are preferred as rear-view mirrors in vehicles because they:  (a) form real images   (b) form magnified images   (c) give erect images with a wider field of view   (d) absorb less light',
      answer: '(c) erect, diminished images with a much wider field of view.',
      variantText: 'Which mirror is used by dentists to see an enlarged image of a tooth?  (a) plane   (b) convex   (c) concave   (d) any of these',
      variantAnswer: '(c) concave — an object within the focus gives a virtual, magnified image.' },
    { chapter: 'Light — Reflection and Refraction', topic: 'Dispersion', type: 'MCQ', marks: 1, diff: 'Easy',
      text: 'The splitting of white light into its component colours on passing through a glass prism is called:  (a) reflection   (b) scattering   (c) dispersion   (d) total internal reflection',
      answer: '(c) dispersion.',
      variantText: 'In the spectrum formed by a glass prism, the colour that deviates the most is:  (a) red   (b) yellow   (c) green   (d) violet',
      variantAnswer: '(d) violet — it travels slowest in glass.' },
    { chapter: 'The Human Eye and the Colourful World', topic: 'Vision defects', type: 'MCQ', marks: 1, diff: 'Easy',
      text: 'A student cannot read the blackboard clearly from the last bench but reads his book comfortably. He is suffering from:  (a) hypermetropia   (b) myopia   (c) presbyopia   (d) colour blindness',
      answer: '(b) myopia (short-sightedness).',
      variantText: 'Hypermetropia is corrected by using a:  (a) concave lens   (b) convex lens   (c) cylindrical lens   (d) plane glass sheet',
      variantAnswer: '(b) convex lens of suitable power.' },
    { chapter: 'Light — Reflection and Refraction', topic: 'Refractive index', type: 'MCQ', marks: 1, diff: 'Medium',
      text: 'The refractive index of glass is 1.5. The speed of light in glass is:  (a) 3 × 10⁸ m/s   (b) 2 × 10⁸ m/s   (c) 1.5 × 10⁸ m/s   (d) 4.5 × 10⁸ m/s',
      answer: '(b) 2 × 10⁸ m/s — v = c/n = 3 × 10⁸ ÷ 1.5.',
      variantText: 'The SI unit of the power of a lens is:  (a) metre   (b) watt   (c) dioptre   (d) candela',
      variantAnswer: '(c) dioptre (D) = 1/f, with f in metres.' },
    { chapter: 'Light — Reflection and Refraction', topic: 'Laws of refraction', type: 'Short', marks: 2, diff: 'Easy',
      text: 'State the two laws of refraction of light. Which of them defines the refractive index of a medium?',
      answer: '(i) The incident ray, refracted ray and normal lie in the same plane. (ii) sin i / sin r = constant (Snell’s law). The second law defines the refractive index. (1 + 1)',
      variantText: 'State the laws of reflection of light. Are they valid for spherical mirrors as well?',
      variantAnswer: '∠i = ∠r; incident ray, reflected ray and normal are coplanar. Yes — valid at every point of a spherical mirror. (1½ + ½)' },
    { chapter: 'Light — Reflection and Refraction', topic: 'Scattering of light', type: 'Short', marks: 2, diff: 'Medium',
      text: 'Why does the clear sky appear blue? Name the phenomenon responsible.',
      answer: 'Air molecules scatter shorter wavelengths (blue) far more strongly than red; this scattered blue light reaches our eyes from all directions. Phenomenon: scattering of light. (1½ + ½)',
      variantText: 'Why do stars twinkle while planets do not? Explain briefly.',
      variantAnswer: 'Starlight refracts through moving atmospheric layers of changing refractive index, so the point-like star flickers; planets are extended sources and the variations average out. (1½ + ½)' },
    { chapter: 'Light — Reflection and Refraction', topic: 'Lens formula', type: 'Short', marks: 2, diff: 'Medium',
      text: 'An object is placed 10 cm from a convex lens of focal length 15 cm. Find the position of the image and state its nature.',
      answer: '1/v − 1/u = 1/f with u = −10 cm, f = +15 cm → v = −30 cm. Image: 30 cm on the object’s side — virtual, erect and magnified. (1½ + ½)',
      variantText: 'The radius of curvature of a concave mirror is 30 cm. Find its focal length, and state where an object must be placed so that the image forms at infinity.',
      variantAnswer: 'f = R/2 = 15 cm; the object must be at the principal focus, 15 cm from the pole. (1 + 1)' },
    { chapter: 'Light — Reflection and Refraction', topic: 'Ray diagrams', type: 'Long', marks: 3, diff: 'Medium',
      text: 'An object is placed between the pole and the principal focus of a concave mirror. Draw the ray diagram and state the position, size and nature of the image formed.',
      answer: 'Correct ray diagram: 2 marks. Image behind the mirror — enlarged, virtual and erect: 1 mark.',
      variantText: 'An object is placed beyond the centre of curvature of a concave mirror. Draw the ray diagram and state the characteristics of the image formed.',
      variantAnswer: 'Correct ray diagram: 2 marks. Image between F and C — real, inverted and diminished: 1 mark.' },
    { chapter: 'The Human Eye and the Colourful World', topic: 'Myopia', type: 'Long', marks: 3, diff: 'Medium',
      text: 'What is myopia? State its two causes and explain, with a diagram, how this defect is corrected.',
      answer: 'Distant objects appear blurred; the image forms in front of the retina (1). Causes: excessive curvature of the eye lens, or elongation of the eyeball (1). Correction: a concave lens of suitable power diverges rays so they focus on the retina — diagram (1).',
      variantText: 'What is hypermetropia? State its two causes and explain, with a diagram, how this defect is corrected.',
      variantAnswer: 'Nearby objects appear blurred; the image forms behind the retina (1). Causes: focal length of the eye lens too long, or eyeball too short (1). Correction: a convex lens of suitable power converges rays onto the retina — diagram (1).' },
    { chapter: 'Light — Reflection and Refraction', topic: 'Prism', type: 'Long', marks: 3, diff: 'Hard',
      text: 'Trace the path of a ray of light passing through a glass prism. Mark the angle of incidence, the angle of emergence and the angle of deviation.',
      answer: 'Correct path with refraction at both faces (1½); ∠i, ∠e and ∠D correctly marked (1½).',
      variantText: 'What is atmospheric refraction? Explain why the sun is visible to us about two minutes before the actual sunrise.',
      variantAnswer: 'Refraction of light by the earth’s atmosphere (1). Light from the sun just below the horizon bends progressively through denser air layers, making the sun appear raised above the horizon (2).' },
    { chapter: 'Light — Reflection and Refraction', topic: 'Mirror formula', type: 'Long', marks: 5, diff: 'Hard',
      text: 'An object 4 cm high is placed 25 cm in front of a concave mirror of focal length 15 cm. (a) Find the position of the image. (b) Find its size and nature. (c) State one practical use of concave mirrors.',
      answer: '(a) 1/v + 1/u = 1/f with u = −25, f = −15 → v = −37.5 cm, i.e. 37.5 cm in front of the mirror (2). (b) m = −v/u = −1.5 → image 6 cm tall, real, inverted, magnified (2). (c) Shaving mirror / torch reflector / solar furnace — any one (1).',
      variantText: 'A 2 cm tall object is placed 20 cm from a convex lens of focal length 10 cm. (a) Find the position of the image. (b) Find its size and nature. (c) State one practical use of convex lenses.',
      variantAnswer: '(a) 1/v − 1/u = 1/f with u = −20, f = +10 → v = +20 cm (2). (b) m = v/u = −1 → image 2 cm, real, inverted, same size (2). (c) Magnifying glass / camera lens / correcting hypermetropia — any one (1).' },
    { chapter: 'Force & Laws of Motion', topic: 'Second law numericals', type: 'Long', marks: 3, diff: 'Hard',
      text: 'A force of 5 N acts on a 2 kg mass at rest. Calculate the acceleration produced and the distance covered in 4 s.',
      answer: 'a = 2.5 m/s²; s = 20 m.' },
    { chapter: 'Force & Laws of Motion', topic: 'Momentum', type: 'Short', marks: 2, diff: 'Medium',
      text: 'Define momentum and state its SI unit. Why does a fielder pull their hands back while catching a fast ball?',
      answer: 'Momentum = mass × velocity, kg m/s; increases time to reduce force on hands.' },
    { chapter: 'Force & Laws of Motion', topic: 'Third law', type: 'Short', marks: 2, diff: 'Easy',
      text: 'State Newton’s third law of motion with one everyday example.',
      answer: 'Every action has an equal and opposite reaction — e.g. walking pushes ground backward.' },
    { chapter: 'Chemical Reactions and Equations', topic: 'Balancing equations', type: 'Short', marks: 2, diff: 'Medium',
      text: 'Balance the equation: Fe + H₂O → Fe₃O₄ + H₂', answer: '3Fe + 4H₂O → Fe₃O₄ + 4H₂' }
  ];

  await admin.from('questions').insert(QDATA.map((q) => ({
    user_id: userId, class_id: null, grade: q.chapter.startsWith('Force') ? '9' : '10', subject: 'Science',
    chapter: q.chapter, topic: q.topic, type: q.type, marks: q.marks, difficulty: q.diff, medium: 'English',
    text: q.text, answer: q.answer, variant_text: q.variantText || null, variant_answer: q.variantAnswer || null,
    source: 'imported', favorite: ['Laws of refraction', 'Mirror formula'].includes(q.topic), created_at: now
  })));

  // A short assessment history per class so charts have real points, and low
  // scores on Force & Laws of Motion / Refraction show up as weak concepts.
  const history = {
    '9-A': [{ title: 'Unit Test 1', pct: [72, 78, 60], days: -40 }, { title: 'Unit Test 2', pct: [70, 75, 62], days: -12 }],
    '9-B': [{ title: 'Unit Test 1', pct: [66, 40, 68], days: -40 }, { title: 'Unit Test 2', pct: [61, 35, 65], days: -12 }],
    '10-A': [
      { title: 'Class Test 1', pct: [66, 62], days: -100 },
      { title: 'Class Test 2', pct: [70, 65], days: -70 },
      { title: 'Periodic Test I', pct: [74, 70], days: -40 },
      { title: 'Periodic Test II', pct: [78, 55], days: -10 }
    ]
  };
  const topicsByClass = {
    '9-A': ['Force & Motion', 'Momentum'], '9-B': ['Force & Motion', 'Momentum'],
    '10-A': ['Light — Reflection & Refraction', 'Chemical Reactions']
  };

  for (const [classKey, tests] of Object.entries(history)) {
    const classId = classIds[classKey];
    const students = studentsByClass[classKey];
    const topics = topicsByClass[classKey];

    for (const t of tests) {
      const createdAt = new Date(Date.now() + t.days * 86400000).toISOString();
      const { data: assessment } = await admin.from('assessments').insert({
        user_id: userId, class_id: classId, title: t.title, subject: 'Science', total_marks: 25,
        duration: '40 min', blueprint: '5 MCQ · 3×2 · 3×3 · 1×5', difficulty: 'Balanced', medium: 'English',
        chapters: topics, instructions: [], status: 'Evaluated', scheduled_for: null, generated_by: 'offline',
        created_at: createdAt, updated_at: createdAt
      }).select('id').single();

      const { data: aqs } = await admin.from('assessment_questions').insert(
        topics.map((topic, i) => ({
          assessment_id: assessment.id, question_id: null, section: 'B', position: i + 1,
          marks: 5, topic, difficulty: 'Medium', text: `${topic} question`, answer: ''
        }))
      ).select('*');

      for (const [si, s] of students.entries()) {
        // Spread individual scores around the class average so per-student
        // analytics aren't all identical.
        const jitter = (si % 5) - 2;
        const { data: result } = await admin.from('results').insert({
          user_id: userId, assessment_id: assessment.id, student_id: s.id,
          score: 0, max_score: 0, ai_confidence: 0.9, needs_review: false, reviewed: true, evaluated_at: createdAt
        }).select('id').single();

        let totalGot = 0, totalMax = 0;
        const items = aqs.map((aq, i) => {
          const pctForTopic = Math.max(15, Math.min(98, t.pct[i] + jitter * 3));
          const got = Math.round((pctForTopic / 100) * aq.marks * 10) / 10;
          totalGot += got; totalMax += aq.marks;
          return { result_id: result.id, aq_id: aq.id, topic: aq.topic, chapter: '', awarded: got, max_marks: aq.marks, comment: '', confidence: 0.9 };
        });
        await admin.from('result_items').insert(items);
        await admin.from('results').update({ score: totalGot, max_score: totalMax }).eq('id', result.id);
      }
    }
    await recomputeWeakConcepts(admin, userId, classId);
  }

  // A handful of saved materials so the Materials page and dashboard rail aren't empty.
  const materialSeed = [
    { type: 'NOTES', title: 'Light — Quick Notes', chapter: 'Light — Reflection and Refraction', cls: '10-A', days: -3 },
    { type: 'WORKSHEET', title: 'Force & Motion Practice', chapter: 'Force & Laws of Motion', cls: '9-B', days: -5 },
    { type: 'QUIZ', title: 'Acids & Bases Quiz', chapter: 'Acids, Bases and Salts', cls: '9-A', days: -7 },
    { type: 'LESSON PLAN', title: 'Human Eye — 3 Period Plan', chapter: 'The Human Eye and the Colourful World', cls: '10-A', days: -14 },
    { type: 'NOTES', title: 'Newton’s Laws — Summary', chapter: 'Force & Laws of Motion', cls: '9-B', days: -21 },
    { type: 'WORKSHEET', title: 'Refraction Numericals Set', chapter: 'Light — Reflection and Refraction', cls: '10-A', days: -21 }
  ];
  await admin.from('materials').insert(materialSeed.map((m) => ({
    user_id: userId, class_id: classIds[m.cls], type: m.type, title: m.title, chapter: m.chapter, concept: null,
    body: `${m.title}\n\n[Seeded sample content for ${m.chapter}.]`, generated_by: 'offline',
    created_at: new Date(Date.now() + m.days * 86400000).toISOString()
  })));

  // A short credit ledger to match the design mock's "Usage history" panel.
  const ledgerSeed = [
    ['Generated paper', '10-A · Periodic Test II — 12 questions, 25 marks', -6],
    ['Regenerated question', 'Question 7 · Similar', -0.4],
    ['Regenerated question', 'Question 3 · Easier', -0.4],
    ['Practice worksheet generated', 'Force & Laws of Motion — 9-B', -2],
    ['Generated quiz', '9-A · Acids & Bases — 10 MCQs', -3],
    ['Top-up purchased', 'Medium pack · ₹400', 500]
  ];
  let balance = 1234 - ledgerSeed.reduce((s, l) => s + l[2], 0);
  const ledgerRows = [];
  for (const [action, detail, delta] of ledgerSeed.slice().reverse()) {
    balance = Math.round((balance + delta) * 100) / 100;
    ledgerRows.push({ user_id: userId, action, detail, delta, balance_after: balance, created_at: now });
  }
  await admin.from('credit_ledger').insert(ledgerRows);

  console.log('Seeded demo teacher: priya.sharma@email.com / teach1234');
}

await seedDemoTeacher();
await seedSimpleAccount(1, 'Free', 100);
await seedSimpleAccount(2, 'Pro', 600);
await seedSimpleAccount(3, 'Max', 2500);
console.log('Done.');
process.exit(0);
