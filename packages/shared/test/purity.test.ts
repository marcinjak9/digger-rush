import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

describe('purity', () => {
  it('src contains no nondeterministic or engine-dependent calls', () => {
    const banned = /Math\.random|\bDate\b|performance\.now|\b(sin|cos|tan|pow|exp|log|atan2?)\(|\*\*/;
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const lines = readFileSync(join(SRC, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (banned.test(line)) throw new Error(`${f}:${i + 1} uses a banned construct: ${line.trim()}`);
      });
    }
  });
});
