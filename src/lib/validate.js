// Shared validation rules — mirrored in public/login.html for instant
// feedback, but enforced here too since client-side checks are only UX, not
// security. A request that skips the browser entirely still hits these.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim()) && email.trim().length <= 254;
}

/**
 * At least 8 characters, one uppercase letter, one lowercase letter and one digit.
 * Returns a human-readable reason on failure, or null when the password passes.
 */
export function passwordIssue(password) {
  const pw = String(password || '');
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pw)) return 'Password must include at least one uppercase letter';
  if (!/[a-z]/.test(pw)) return 'Password must include at least one lowercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must include at least one number';
  return null;
}
