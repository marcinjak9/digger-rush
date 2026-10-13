export type NicknameResult = { ok: true; name: string } | { ok: false; error: string };

const BLOCKLIST = ['nigger', 'nigga', 'faggot', 'retard', 'kike', 'chink', 'hitler', 'nazi', 'rapist'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

export function sanitizeNickname(raw: string): NicknameResult {
  const name = raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  const len = [...name].length;
  if (len === 0) return { ok: false, error: 'Enter a nickname.' };
  if (len < 2) return { ok: false, error: 'Nickname must be at least 2 characters.' };
  if (len > 16) return { ok: false, error: 'Nickname must be at most 16 characters.' };
  const flat = name.toLowerCase().replace(/[01345$@!]/g, (c) => ({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '$': 's', '@': 'a', '!': 'i' })[c] ?? c).replace(/[^a-z]/g, '');
  if (BLOCKLIST.some((w) => flat.includes(w))) return { ok: false, error: 'That nickname is not allowed.' };
  return { ok: true, name };
}

const KEY = 'digger.nickname';

export function loadNickname(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function saveNickname(n: string): void {
  try { localStorage.setItem(KEY, n); } catch { /* storage unavailable */ }
}
