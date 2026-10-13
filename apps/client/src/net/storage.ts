const TOKEN_KEY = 'digger.token';
const ROOM_KEY = 'digger.room';
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function randomToken(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += (b + 256).toString(16).slice(1);
  return s; // 48 hex chars
}

let memToken = '';

// The session token and room id live in sessionStorage: it survives a reload of the same tab (the server keeps
// the player for a minute) but a new tab starts empty, so two tabs are two players. localStorage is only a
// fallback when sessionStorage is unavailable (then two tabs share one identity, as before).
function store(): Storage | null {
  try { return sessionStorage; } catch { /* blocked */ }
  try { return localStorage; } catch { return null; }
}

export function loadToken(): string {
  const st = store();
  try {
    const t = st?.getItem(TOKEN_KEY) ?? null;
    if (t !== null && TOKEN_RE.test(t)) return t;
    const n = randomToken();
    st?.setItem(TOKEN_KEY, n);
    if (st === null) { memToken = memToken === '' ? n : memToken; return memToken; }
    return n;
  } catch {
    if (memToken === '') memToken = randomToken();
    return memToken;
  }
}

export function loadRoomId(): string {
  try { return store()?.getItem(ROOM_KEY) ?? ''; } catch { return ''; }
}

export function saveRoomId(id: string): void {
  try { store()?.setItem(ROOM_KEY, id); } catch { /* storage unavailable */ }
}
