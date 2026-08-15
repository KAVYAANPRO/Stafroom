# Staffroom

A teaching workspace for CBSE/ICSE/GSEB teachers — AI paper generation, a
growing question bank, AI answer evaluation, and analytics that turn evaluated
assessments into weak-concept detection and targeted practice.

This repo is the full stack behind the [Staffroom UI/UX design brief](../Staffroom%20UIUX%20Design%20Brief):
an Express + SQLite backend, and the design brief's `.dc.html` mocks rebuilt
as real pages under `public/`, wired to the API.

## Quick start

```bash
npm install
cp .env.example .env      # then edit .env — see below
npm run setup              # resets the DB, seeds demo data, verifies the frontend build
npm start
```

Open http://localhost:3000 and sign in with the seeded demo account:

- **Email:** `priya.sharma@email.com`
- **Password:** `teach1234`

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `JWT_SECRET` | Session signing secret — set a long random value before deploying |
| `DATABASE_FILE` | Path to the SQLite file (default `./data/staffroom.db`) |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) key. Without it, every AI feature falls back to an offline generator built from the question bank — the app runs fully either way, just without genuinely new AI-written questions. |
| `GEMINI_MODEL` | Defaults to `gemini-2.5-flash` |

## What's real vs. offline-fallback

Every AI action (`Generate paper`, `Regenerate question`, `Generate practice`,
notes/worksheet/quiz/lesson-plan generation, the Answer Evaluator) calls
Gemini when `GEMINI_API_KEY` is set. Without a key:

- Paper generation assembles questions from the teacher's own Question Bank instead of writing new ones.
- Regeneration falls back to a stored "bank alternative" per question, or refunds the credit if none exists.
- Material generation (notes/worksheets/etc.) produces a labeled placeholder body instead of AI-written content.
- The Answer Evaluator returns everything unmarked, flagged for manual review — it never fabricates a score.

The UI always tells you which mode produced a result via a toast/badge.

## Project layout

```
src/
  db/            SQLite schema, connection, seed script
  lib/           credits/plans, board blueprints, Gemini client + offline fallbacks, auth, view formatters
  routes/        one file per resource (auth, classes, questions, materials, assessments, evaluations, analytics, dashboard, billing, settings)
  server.js      Express app — mounts /api/*, serves public/
public/           the real frontend — one HTML page per screen + shared.js (API client, auth guard, sidebar) + styles.css
tools/
  build-frontend.js   sanity-checks that public/ is complete (see note below)
```

`public/` is hand-authored rather than generated: the design brief's
`.dc.html` files are a prototyping format (inline `{{ }}` bindings, `sc-if`/
`sc-for`, a `support.js` runtime) with no mechanical mapping to real
fetch-backed pages, so each page was rebuilt directly against the API while
keeping the exact visual design (colors, type, spacing, copy) from the mocks.

## Credits & plans

Every AI action's cost is defined once in `src/lib/credits.js` and surfaced
read-only at `GET /api/billing/pricing` — the same numbers the UI shows in
its confirmation dialogs before spending. Feature gates (e.g. the Answer
Evaluator requiring the Max plan) live in the same file via `requireFeature`.

## Scripts

```bash
npm run db:reset   # drop and recreate the SQLite schema
npm run seed        # seed the demo teacher (no-ops if already seeded)
npm run build       # verify public/ is complete
npm run setup        # db:reset + seed + build
npm start             # run the server
npm run dev            # run the server with --watch
```
