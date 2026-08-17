import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import { attachUser, requireAuth } from './lib/auth.js';
import { wrap, notFoundHandler, errorHandler } from './lib/middleware.js';
import { geminiAvailable } from './lib/ai.js';

import authRoutes from './routes/auth.js';
import classRoutes from './routes/classes.js';
import studentRoutes from './routes/students.js';
import questionRoutes from './routes/questions.js';
import materialRoutes from './routes/materials.js';
import noteMakerRoutes from './routes/note-maker.js';
import assessmentRoutes from './routes/assessments.js';
import evaluationRoutes from './routes/evaluation.js';
import analyticsRoutes from './routes/analytics.js';
import dashboardRoutes from './routes/dashboard.js';
import billingRoutes from './routes/billing.js';
import settingsRoutes from './routes/settings.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(wrap(attachUser));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ai: geminiAvailable() ? 'gemini' : 'offline' });
});

app.use('/api/auth', authRoutes);

// Everything under /api past this point requires a signed-in teacher.
const api = express.Router();
api.use(requireAuth);
api.use('/classes', classRoutes);
api.use('/classes/:classId/students', studentRoutes);
api.use('/questions', questionRoutes);
api.use('/materials', materialRoutes);
api.use('/note-maker', noteMakerRoutes);
api.use('/assessments', assessmentRoutes);
api.use('/evaluations', evaluationRoutes);
api.use('/analytics', analyticsRoutes);
api.use('/dashboard', dashboardRoutes);
api.use('/billing', billingRoutes);
api.use('/settings', settingsRoutes);
app.use('/api', api);

app.use('/api', wrap(async (req, res) => notFoundHandler(req, res)));

// Static site — built by `npm run build` from the design brief's .dc.html files.
const publicDir = path.join(ROOT, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  // SPA-style fallback so deep links (e.g. a bookmarked dashboard URL) still resolve,
  // but only for GET requests that aren't asking for a file extension or the API.
  app.get(/^(?!\/api).*/, (req, res, next) => {
    if (path.extname(req.path)) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.status(200).send('Staffroom API is running. Run `npm run build` to generate the frontend into /public.');
  });
}

app.use(errorHandler);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Staffroom listening on http://localhost:${port}`);
  console.log(`AI engine: ${geminiAvailable() ? 'Gemini (' + (process.env.GEMINI_MODEL || 'gemini-2.5-flash') + ')' : 'offline fallback — set GEMINI_API_KEY to enable AI generation'}`);
});

export default app;
