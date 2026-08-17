import { HttpError } from './errors.js';

/** Wraps an async route handler so rejected promises reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found', path: req.path });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    const { status, message, ...extra } = err;
    delete extra.stack;
    return res.status(status).json({ error: message, ...extra });
  }
  if (err?.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (15MB max).' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
