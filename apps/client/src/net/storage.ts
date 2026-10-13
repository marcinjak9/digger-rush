const TOKEN_KEY = 'digger.token';
const ROOM_KEY = 'digger.room';

function randomToken(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += (b + 256).toString(16).slice(1);
  return s; // 48 hex chars
}

let memToken = '';

// Random per browser session token; the server keeps the player for a minute after a disconnect.
export function loadToken(): string {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t !== null && /^[A-Za-z0-9_-]{16,64}$/.test(t)) return t;
    const n = randomToken();
    localStorage.setItem(TOKEN_KEY, n);
    return n;
  } catch {
    if (memToken === '') memToken = randomToken();
    return memToken;
  }
}

export function loadRoomId(): string {
  try { return localStorage.getItem(ROOM_KEY) ?? ''; } catch { return ''; }
}

export function saveRoomId(id: string): void {
  try { localStorage.setItem(ROOM_KEY, id); } catch { /* storage unavailable */ }
}
