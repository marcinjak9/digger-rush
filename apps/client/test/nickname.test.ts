import { describe, expect, it } from 'vitest';
import { sanitizeNickname } from '../src/nickname.js';

describe('nickname', () => {
  it('trims and strips control chars', () => {
    expect(sanitizeNickname('  Bo\u0007b  ')).toEqual({ ok: true, name: 'Bob' });
  });
  it('rejects empty, short, long', () => {
    expect(sanitizeNickname('   ').ok).toBe(false);
    expect(sanitizeNickname('a').ok).toBe(false);
    expect(sanitizeNickname('x'.repeat(17)).ok).toBe(false);
    expect(sanitizeNickname('x'.repeat(16)).ok).toBe(true);
  });
  it('blocks listed words incl. leetspeak', () => {
    expect(sanitizeNickname('H1tler').ok).toBe(false);
  });
});
