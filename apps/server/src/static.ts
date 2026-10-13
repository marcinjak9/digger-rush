import { existsSync, promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.txt']);
const MAX_CACHED = 8 * 1024 * 1024; // larger files are not served

interface Cached {
  mtimeMs: number;
  size: number;
  raw: Buffer;
  gz: Buffer | null;
}

// Serves a built single page app (Vite output) from memory-cached files. Deliberately tiny: GET/HEAD only,
// gzip for text types, immutable caching for hashed /assets, no-cache for index.html, SPA fallback.
export class StaticSite {
  private readonly root: string;
  private readonly cache = new Map<string, Cached>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  static available(dir: string): boolean {
    return existsSync(join(dir, 'index.html'));
  }

  // Returns true when it answered the request.
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]);
    } catch {
      res.writeHead(400).end();
      return true;
    }
    if (path.includes('\0')) { res.writeHead(400).end(); return true; }
    let rel = normalize(path).replace(/^([/\\])+/, '');
    if (rel === '' || rel.endsWith(sep)) rel += 'index.html';
    let file = resolve(this.root, rel);
    if (file !== this.root && !file.startsWith(this.root + sep)) { res.writeHead(403).end(); return true; }
    let entry = await this.load(file);
    if (entry === null) {
      // Paths with an extension are real asset requests: a missing one is a 404. Anything else is a client route.
      if (extname(rel) !== '' && extname(rel) !== '.html') { res.writeHead(404).end(); return true; }
      file = join(this.root, 'index.html');
      entry = await this.load(file);
      if (entry === null) return false;
    }
    const ext = extname(file).toLowerCase();
    const headers: Record<string, string | number> = {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : rel.replace(/\\/g, '/').startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      vary: 'accept-encoding',
    };
    let body = entry.raw;
    if (entry.gz !== null && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      body = entry.gz;
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  private async load(file: string): Promise<Cached | null> {
    try {
      const st = await fs.stat(file);
      if (!st.isFile() || st.size > MAX_CACHED) return null;
      const hit = this.cache.get(file);
      if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
      const raw = await fs.readFile(file);
      const gz = COMPRESSIBLE.has(extname(file).toLowerCase()) && raw.length > 512 ? await gzipAsync(raw, { level: 9 }) : null;
      const entry: Cached = { mtimeMs: st.mtimeMs, size: st.size, raw, gz };
      this.cache.set(file, entry);
      return entry;
    } catch {
      return null;
    }
  }
}
