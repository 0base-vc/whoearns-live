import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared font loader for satori-rendered assets (OG images, SVG badges).
 *
 * `inter-latin-700-normal.woff` is a Latin-only subset (~30KB) — Cyrillic
 * and extended Latin subsets each ship as separate files. Validator
 * monikers rarely use non-Latin characters; the few exceptions (CJK
 * monikers) fall back to pubkey-only rendering, which is acceptable.
 */
function resolveFontPath(): string | null {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dev: src/api/satori-font.ts → repo root → node_modules
    resolve(
      thisDir,
      '..',
      '..',
      'node_modules',
      '@fontsource',
      'inter',
      'files',
      'inter-latin-700-normal.woff',
    ),
    // compiled: dist/api/satori-font.js → repo root → node_modules
    resolve(
      thisDir,
      '..',
      '..',
      'node_modules',
      '@fontsource',
      'inter',
      'files',
      'inter-latin-700-normal.woff',
    ),
    // Docker: CWD = /app, node_modules at /app/node_modules
    resolve(
      process.cwd(),
      'node_modules',
      '@fontsource',
      'inter',
      'files',
      'inter-latin-700-normal.woff',
    ),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

let cachedFontBuffer: ArrayBuffer | null = null;

export function loadInterFontOnce(): ArrayBuffer | null {
  if (cachedFontBuffer !== null) return cachedFontBuffer;
  const path = resolveFontPath();
  if (path === null) return null;
  const data = readFileSync(path);
  const arr = new ArrayBuffer(data.byteLength);
  new Uint8Array(arr).set(data);
  cachedFontBuffer = arr;
  return arr;
}

/** Test-only hook to drop the font cache between cases. */
export function _resetFontCacheForTesting(): void {
  cachedFontBuffer = null;
}
