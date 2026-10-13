export type NicknameResult = { ok: true; name: string } | { ok: false; error: string };

export const NICK_MIN = 2;
export const NICK_MAX = 16;

const BLOCKLIST = ['nigger', 'nigga', 'faggot', 'retard', 'kike', 'chink', 'hitler', 'nazi', 'rapist'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '$': 's', '@': 'a', '!': 'i' };

// Used by the client for early feedback and by the server, which always revalidates.
export function sanitizeNickname(raw: unknown): NicknameResult {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a nickname.' };
  if (raw.length > 200) return { ok: false, error: `Nickname must be at most ${NICK_MAX} characters.` };
  const name = raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  const len = [...name].length;
  if (len === 0) return { ok: false, error: 'Enter a nickname.' };
  if (len < NICK_MIN) return { ok: false, error: `Nickname must be at least ${NICK_MIN} characters.` };
  if (len > NICK_MAX) return { ok: false, error: `Nickname must be at most ${NICK_MAX} characters.` };
  const flat = name.toLowerCase().replace(/[01345$@!]/g, (c) => LEET[c] ?? c).replace(/[^a-z]/g, '');
  if (BLOCKLIST.some((w) => flat.includes(w))) return { ok: false, error: 'That nickname is not allowed.' };
  return { ok: true, name };
}
