import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function now(): string { return new Date().toISOString(); }

export function ensureDir(path: string): void { mkdirSync(path, { recursive: true }); }

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextAtomic(path: string, value: string): void {
  ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeSync(descriptor, value); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
}

export function appendJsonl(path: string, value: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function isSafeId(value: string): boolean { return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value); }

export function assertSafeId(value: string, label = 'id'): void {
  if (!isSafeId(value)) throw new Error(`${label} must be kebab-case (1-63 lowercase letters, digits, hyphens).`);
}

export function listFiles(root: string, predicate: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) result.push(...listFiles(path, predicate));
    else if (predicate(path)) result.push(path);
  }
  return result;
}

export function hasSecrets(value: unknown): boolean {
  const sensitive = /(?:password|token|secret|cookie|authorization|private.?key|credit.?card)/i;
  if (typeof value === 'string') return /(?:password|token|secret|cookie|authorization|private.?key|credit.?card)\s*[:=]\s*(?!env:)[^\s,;]+/i.test(value);
  if (Array.isArray(value)) return value.some(hasSecrets);
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => sensitive.test(key) && typeof item === 'string' && item.length > 0 && !item.startsWith('env:') || hasSecrets(item));
  return false;
}

export function withFileLock<T>(path: string, operation: () => T): T {
  ensureDir(dirname(path));
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`Concurrent QA operation detected: lock is held at ${path}. Wait for the active operation or remove only a confirmed stale lock.`);
    throw error;
  }
  try { writeSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`); fsyncSync(descriptor); return operation(); }
  finally { closeSync(descriptor); try { unlinkSync(path); } catch { /* Do not hide operation result because cleanup was best effort. */ } }
}
