import { randomUUID } from 'node:crypto';

export function id(prefix = '') {
  const raw = randomUUID().replace(/-/g, '').slice(0, 20);
  return prefix ? `${prefix}_${raw}` : raw;
}

export function nowIso() {
  return new Date().toISOString();
}
