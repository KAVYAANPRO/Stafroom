// Server-side PDF export for question papers — bypasses the browser's print
// dialog entirely (no Chrome date/title header or URL/page-number footer)
// and never risks the app process the way a headless-Chrome render could on
// a memory-constrained host: pdfkit is pure JS, no browser involved.
//
// Body text uses DejaVu Sans rather than pdfkit's built-in Times-Roman —
// AI-generated science content routinely includes subscripts (H₂O), arrows
// (→) and other symbols outside Times' WinAnsi-only glyph set, which render
// as garbage with the standard PDF fonts. DejaVu Sans covers all of it.
// हिन्दी papers mix Devanagari and Latin on the same line, and pdfkit has no
// automatic per-glyph font fallback, so mixed text is split into
// Devanagari/Latin runs and rendered as continued segments.
import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SANS_REGULAR = path.join(ROOT, 'node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const SANS_BOLD = path.join(ROOT, 'node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');
// Raw TTF, not the @fontsource woff2 build — fontkit's WOFF2 glyph-subsetting
// throws ("Offset is outside the bounds of the DataView") on this font when
// pdfkit embeds it; the uncompressed TTF embeds cleanly.
const DEV_REGULAR = path.join(ROOT, 'node_modules/@expo-google-fonts/noto-sans-devanagari/400Regular/NotoSansDevanagari_400Regular.ttf');
const DEV_BOLD = path.join(ROOT, 'node_modules/@expo-google-fonts/noto-sans-devanagari/700Bold/NotoSansDevanagari_700Bold.ttf');

const DEVANAGARI_RE = /[ऀ-ॿ]/;

function registerFonts(doc) {
  doc.registerFont('serif', SANS_REGULAR);
  doc.registerFont('serif-bold', SANS_BOLD);
  doc.registerFont('dev', DEV_REGULAR);
  doc.registerFont('dev-bold', DEV_BOLD);
}

/** Splits text into contiguous Devanagari / non-Devanagari runs. */
function splitRuns(text) {
  const runs = [];
  let current = '';
  let currentIsDev = null;
  for (const ch of String(text)) {
    const isDev = DEVANAGARI_RE.test(ch);
    if (currentIsDev === null || isDev === currentIsDev) {
      current += ch;
      currentIsDev = isDev;
    } else {
      runs.push({ text: current, dev: currentIsDev });
      current = ch;
      currentIsDev = isDev;
    }
  }
  if (current) runs.push({ text: current, dev: currentIsDev });
  return runs;
}

function fontFor(run, bold) {
  return run.dev ? (bold ? 'dev-bold' : 'dev') : (bold ? 'serif-bold' : 'serif');
}

// DejaVu Sans substitutes "fi"/"fl" pairs via its `ccmp` feature (it has no
// `liga`/`clig` at all) — the resulting ligature glyph has no ToUnicode
// mapping back to its letters, so copy-paste/search/screen-readers see
// "Defne" instead of "Define". Devanagari's `ccmp` is the opposite: it's
// load-bearing for correct conjunct/matra shaping, so it must stay on.
function featuresFor(run) {
  return { features: run.dev ? [] : ['-ccmp'] };
}

function measureRuns(doc, runs, bold) {
  return runs.reduce((sum, run) => sum + doc.font(fontFor(run, bold)).widthOfString(run.text, featuresFor(run)), 0);
}

/**
 * Writes text that may mix Devanagari and Latin script, using the right
 * embedded font per run. `bold` picks the bold variant of whichever font
 * each run needs.
 *
 * Always takes an explicit starting `x` (defaulting to the page's left
 * margin) rather than trusting pdfkit's own cursor — pdfkit only resets
 * `doc.x` back to the margin after text that actually wraps to a new line;
 * a short single-line call (a header row, a section title) leaves `doc.x`
 * sitting wherever that line visually ended, which then silently corrupts
 * the starting position of every *unrelated* line rendered after it.
 *
 * pdfkit's `align` option also centers/right-aligns each individual
 * .text() call within its own box — fine for a single font, but multi-run
 * "continued" text (one font per script) would have each run
 * re-centered/re-aligned on top of the others instead of flowing as one
 * line. For center/right text this measures the combined width itself and
 * positions the cursor before writing each run left-to-right with no
 * per-run align.
 */
function writeText(doc, text, { bold = false, hindi = false, x, ...opts } = {}) {
  const startX = x !== undefined ? x : doc.page.margins.left;

  if (!hindi) {
    doc.font(bold ? 'serif-bold' : 'serif').text(text, startX, doc.y, { ...featuresFor({ dev: false }), ...opts });
    return;
  }
  const runs = splitRuns(text);
  if (!runs.length) { doc.text('', startX, doc.y, opts); return; }

  // `width` stays in `rest` (still needed by pdfkit to wrap long lines) —
  // only `align` is stripped, since re-applying it per-run would re-center/
  // re-align each individual run instead of the manually-positioned whole.
  const { align, ...rest } = opts;
  let runStartX = startX;
  if (align === 'center' || align === 'right') {
    const boxWidth = opts.width || (doc.page.width - doc.page.margins.right - startX);
    const totalWidth = measureRuns(doc, runs, bold);
    runStartX = align === 'center' ? startX + (boxWidth - totalWidth) / 2 : startX + boxWidth - totalWidth;
  }

  doc.font(fontFor(runs[0], bold)).text(runs[0].text, runStartX, doc.y, { ...featuresFor(runs[0]), ...rest, continued: runs.length > 1 });
  for (let i = 1; i < runs.length; i++) {
    doc.font(fontFor(runs[i], bold)).text(runs[i].text, { ...featuresFor(runs[i]), ...rest, continued: i < runs.length - 1 });
  }
}

/**
 * @param {{header: object, sections: {title:string, note:string, questions: object[]}[], instructions: string[], medium: string, showKey: boolean}} paper
 * @returns {Promise<Buffer>}
 */
export function renderAssessmentPdf({ header, sections, instructions, medium, showKey }) {
  const hindi = medium !== 'English';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    registerFonts(doc);
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.fontSize(15);
    writeText(doc, header.school, { bold: true, hindi, align: 'center' });
    doc.moveDown(0.15);
    doc.fontSize(13);
    writeText(doc, header.title, { bold: true, hindi, align: 'center' });
    doc.moveDown(0.1);
    doc.fontSize(12);
    writeText(doc, header.subject, { hindi, align: 'center' });
    doc.moveDown(0.5);

    doc.fontSize(11);
    const midY = doc.y;
    writeText(doc, header.time, { hindi, align: 'left' });
    doc.y = midY;
    writeText(doc, header.maxMarks, { bold: true, hindi, align: 'right' });
    doc.moveDown(0.4);

    doc.save();
    doc.lineWidth(1.5);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
    doc.moveDown(0.5);
    doc.restore();

    doc.fontSize(10.5);
    writeText(doc, header.instTitle, { bold: true, hindi });
    doc.moveDown(0.2);
    instructions.forEach((inst, i) => {
      doc.fontSize(10);
      writeText(doc, `${i + 1}. ${inst}`, { hindi, indent: 14 });
      doc.moveDown(0.1);
    });
    doc.moveDown(0.4);

    sections.forEach((sec) => {
      doc.fontSize(11.5);
      writeText(doc, sec.title, { bold: true, hindi, align: 'center' });
      doc.moveDown(0.05);
      doc.fontSize(9.5);
      writeText(doc, sec.note, { hindi, align: 'center' });
      doc.moveDown(0.35);

      sec.questions.forEach((q) => {
        doc.fontSize(11);
        const startY = doc.y;
        writeText(doc, `${q.position}.`, { bold: true, hindi, x: doc.page.margins.left, width: 26 });
        const marksLabel = `[${q.marks}]`;
        const marksWidth = doc.font('serif-bold').widthOfString(marksLabel, featuresFor({ dev: false }));
        doc.y = startY;
        writeText(doc, q.text, { hindi, x: doc.page.margins.left + 26, width: pageWidth - 26 - marksWidth - 8 });
        const afterY = doc.y;
        doc.y = startY;
        writeText(doc, marksLabel, { bold: true, hindi, x: doc.page.width - doc.page.margins.right - marksWidth, width: marksWidth, align: 'right' });
        doc.y = Math.max(afterY, startY + 14);

        if (showKey && q.answer) {
          doc.moveDown(0.15);
          doc.fontSize(10);
          writeText(doc, `${header.ansWord} ${q.answer}`, { hindi, x: doc.page.margins.left + 26, width: pageWidth - 26 });
        }
        doc.moveDown(0.4);

        if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
      });
      doc.moveDown(0.3);
    });

    doc.fontSize(10);
    writeText(doc, header.end, { hindi, align: 'center' });

    doc.end();
  });
}
