// Board paper blueprints. A blueprint decides how many questions of each mark
// weight a paper needs, which section they sit in, and the general instructions
// printed at the top — everything the generator and the print view depend on.

export const BLUEPRINTS = {
  20: {
    duration: '30 min',
    summary: '4 MCQ · 4 × 2-mark · 2 × 3-mark',
    sections: [
      { key: 'A', marks: 1, count: 4, type: 'MCQ' },
      { key: 'B', marks: 2, count: 4, type: 'Short' },
      { key: 'C', marks: 3, count: 2, type: 'Long' }
    ]
  },
  25: {
    duration: '40 min',
    summary: '5 MCQ · 3 × 2-mark · 3 × 3-mark · 1 × 5-mark',
    sections: [
      { key: 'A', marks: 1, count: 5, type: 'MCQ' },
      { key: 'B', marks: 2, count: 3, type: 'Short' },
      { key: 'C', marks: 3, count: 3, type: 'Long' },
      { key: 'D', marks: 5, count: 1, type: 'Long' }
    ]
  },
  40: {
    duration: '70 min',
    summary: '8 MCQ · 4 × 2-mark · 4 × 3-mark · 2 × 5-mark',
    sections: [
      { key: 'A', marks: 1, count: 8, type: 'MCQ' },
      { key: 'B', marks: 2, count: 4, type: 'Short' },
      { key: 'C', marks: 3, count: 4, type: 'Long' },
      { key: 'D', marks: 5, count: 2, type: 'Long' }
    ]
  },
  80: {
    duration: '3 hr',
    summary: '12 MCQ · 6 × 2-mark · 6 × 3-mark · 4 × 5-mark · 2 case-based (4-mark)',
    sections: [
      { key: 'A', marks: 1, count: 12, type: 'MCQ' },
      { key: 'B', marks: 2, count: 6, type: 'Short' },
      { key: 'C', marks: 3, count: 6, type: 'Long' },
      { key: 'D', marks: 5, count: 4, type: 'Long' },
      { key: 'E', marks: 4, count: 2, type: 'Case' }
    ]
  }
};

export const SUPPORTED_MARKS = Object.keys(BLUEPRINTS).map(Number);

export function blueprintFor(totalMarks) {
  const marks = Number(totalMarks);
  const bp = BLUEPRINTS[marks];
  if (!bp) return null;
  return { totalMarks: marks, ...bp };
}

export function questionCount(bp) {
  return bp.sections.reduce((sum, s) => sum + s.count, 0);
}

const SECTION_WORDS = {
  English: { A: 'SECTION A', B: 'SECTION B', C: 'SECTION C', D: 'SECTION D', E: 'SECTION E' },
  'हिन्दी': { A: 'खण्ड अ', B: 'खण्ड ब', C: 'खण्ड स', D: 'खण्ड द', E: 'खण्ड इ' }
};

/** Human-readable section headings, e.g. "(Questions 1 to 5 carry 1 mark each)". */
export function sectionHeadings(bp, medium = 'English') {
  const hi = medium !== 'English';
  const words = SECTION_WORDS[hi ? 'हिन्दी' : 'English'];
  let no = 1;
  return bp.sections.map((s) => {
    const from = no;
    const to = no + s.count - 1;
    no = to + 1;
    const range = from === to ? `${from}` : `${from} to ${to}`;
    const rangeHi = from === to ? `${from}` : `${from} से ${to}`;
    return {
      key: s.key,
      title: words[s.key],
      note: hi
        ? `(प्रश्न ${rangeHi} — प्रत्येक ${s.marks} अंक)`
        : `(Question${from === to ? '' : 's'} ${range} carr${from === to ? 'ies' : 'y'} ${s.marks} mark${s.marks > 1 ? 's' : ''} each)`,
      marks: s.marks,
      count: s.count,
      from,
      to
    };
  });
}

export function defaultInstructions(bp, medium = 'English') {
  const headings = sectionHeadings(bp, medium);
  if (medium !== 'English') {
    const parts = headings
      .map((h) => `${h.title}: प्रश्न ${h.from === h.to ? h.from : h.from + '–' + h.to}, प्रत्येक ${h.marks} अंक।`)
      .join(' ');
    return [
      'सभी प्रश्न अनिवार्य हैं।',
      parts,
      'जहाँ आवश्यक हो, स्वच्छ एवं नामांकित चित्र बनाइए।',
      'कैलकुलेटर का प्रयोग वर्जित है।'
    ];
  }
  const parts = headings
    .map((h) => h.from === h.to
      ? `${h.title}: question ${h.from} carries ${h.marks} mark${h.marks > 1 ? 's' : ''}.`
      : `${h.title}: questions ${h.from}–${h.to} carry ${h.marks} mark${h.marks > 1 ? 's' : ''} each.`)
    .join(' ');
  return [
    'All questions are compulsory.',
    parts,
    'Draw neat, labelled diagrams wherever necessary.',
    'Use of calculators is not permitted.'
  ];
}

export function paperHeader({ school, title, subject, grade, totalMarks, duration, medium }) {
  const hi = medium !== 'English';
  return hi
    ? {
        school: (school || '').toUpperCase() === school ? school : school,
        title,
        subject: `${subject} · कक्षा ${grade}`,
        time: `समय: ${duration}`,
        maxMarks: `अधिकतम अंक: ${totalMarks}`,
        instTitle: 'सामान्य निर्देश:',
        ansWord: 'उत्तर.',
        end: '— प्रश्न-पत्र समाप्त —'
      }
    : {
        school: (school || '').toUpperCase(),
        title: title.toUpperCase(),
        subject: `${String(subject).toUpperCase()} · CLASS ${grade}`,
        time: `Time allowed: ${duration}`,
        maxMarks: `Maximum marks: ${totalMarks}`,
        instTitle: 'General instructions:',
        ansWord: 'Ans.',
        end: '— End of paper —'
      };
}

/** Roman numeral grade, the way boards print it. */
export function romanGrade(grade) {
  const map = { 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X', 11: 'XI', 12: 'XII' };
  return map[Number(grade)] || String(grade);
}
