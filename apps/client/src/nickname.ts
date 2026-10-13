export { sanitizeNickname, type NicknameResult } from '@digger/shared';

const KEY = 'digger.nickname';

export function loadNickname(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function saveNickname(n: string): void {
  try { localStorage.setItem(KEY, n); } catch { /* storage unavailable */ }
}
