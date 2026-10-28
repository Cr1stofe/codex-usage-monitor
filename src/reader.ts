import { open, readdir, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { classifyReadIssues, newestSnapshot, parseQuotaLine, parseSessionMetadata, parseSessionUsage,
  type MonitorState, type QuotaSnapshot, type SessionMetadata, type SessionUsage } from './quota';

const MAX_LINE_BYTES = 1024 * 1024;
interface Cursor {
  identity: string;
  offset: number;
  mtime: number;
  anchor: Buffer;
  pending: Buffer;
  skipping: boolean;
  snapshot: QuotaSnapshot | null;
  metadata: SessionMetadata | null;
  usage: SessionUsage | null;
}

export function resolveCodexHome(configured: string, environment = process.env.CODEX_HOME, home = homedir()): string {
  const value = configured.trim() || environment?.trim() || join(home, '.codex');
  const expanded = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error('INVALID_HOME');
  return resolve(expanded);
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EMFILE', 'ENOSPC'].includes(error.code)) return error.code;
  }
  return 'IO_ERROR';
}

export class SessionReader {
  private cursors = new Map<string, Cursor>();
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private disposed = false;
  private watchIssue: string | undefined;
  private state: MonitorState = { status: 'loading', snapshot: null, checkedAt: null, filesTracked: 0, issues: [] };
  private readonly sessions: string;

  constructor(home: string, private readonly onState: (state: MonitorState) => void) {
    this.sessions = join(home, 'sessions');
  }

  getState(): MonitorState { return this.state; }

  start(): void {
    if (this.disposed || this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, 30_000);
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        await this.scan();
      } while (this.again && !this.disposed);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  private publish(state: MonitorState): void {
    if (this.disposed) return;
    this.state = state;
    this.onState(state);
  }

  private ensureWatcher(): void {
    if (this.watcher || this.disposed) return;
    try {
      this.watcher = watch(this.sessions, { recursive: true }, () => {
        if (this.debounce || this.disposed) return;
        this.debounce = setTimeout(() => {
          this.debounce = undefined;
          void this.refresh();
        }, 250);
      });
      this.watchIssue = undefined;
      this.watcher.on('error', () => {
        this.watchIssue = 'WATCH_UNAVAILABLE';
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch { this.watchIssue = 'WATCH_UNAVAILABLE'; }
  }

  private async scan(): Promise<void> {
    const issues = new Set<string>();
    const found = new Set<string>();
    let complete = true;
    try {
      const root = await stat(this.sessions);
      if (!root.isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
      this.ensureWatcher();
      const walk = async (directory: string): Promise<void> => {
        if (this.disposed) return;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error) { complete = false; issues.add(errorCode(error)); return; }
        for (const entry of entries) {
          if (this.disposed) return;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            found.add(path);
            try { await this.readFile(path, issues); }
            catch (error) { issues.add(errorCode(error)); }
          }
        }
      };
      await walk(this.sessions);
      if (complete) for (const path of this.cursors.keys()) if (!found.has(path)) this.cursors.delete(path);
      if (this.watchIssue) issues.add(this.watchIssue);
      this.publish({
        status: classifyReadIssues(issues),
        snapshot: newestSnapshot(Array.from(this.cursors.values(), (cursor) => cursor.snapshot)),
        sessions: Array.from(this.cursors.values(), (cursor) => cursor.usage).filter((usage): usage is SessionUsage => usage !== null),
        checkedAt: Date.now(), filesTracked: this.cursors.size, issues: [...issues].sort(),
      });
    } catch (error) {
      const code = errorCode(error);
      const missing = code === 'ENOENT' || code === 'ENOTDIR';
      if (missing) {
        this.cursors.clear();
        this.watcher?.close();
        this.watcher = undefined;
      }
      this.publish({ status: missing ? 'missing' : 'error', snapshot: missing ? null : this.state.snapshot,
        checkedAt: Date.now(), filesTracked: this.cursors.size, issues: [code], sessions: missing ? [] : this.state.sessions });
    }
  }

  private async readFile(path: string, issues: Set<string>): Promise<void> {
    const file = await open(path, 'r');
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) return;
      const identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
      let cursor = this.cursors.get(path);
      let reset = !cursor || cursor.identity !== identity || metadata.size < cursor.offset
        || (metadata.size === cursor.offset && metadata.mtimeMs !== cursor.mtime);
      if (cursor && !reset && cursor.anchor.length) {
        const anchor = Buffer.alloc(cursor.anchor.length);
        const read = await file.read(anchor, 0, anchor.length, cursor.offset - anchor.length);
        reset = read.bytesRead !== anchor.length || !anchor.equals(cursor.anchor);
      }
      if (!cursor || reset) {
        cursor = { identity, offset: 0, mtime: metadata.mtimeMs, anchor: Buffer.alloc(0), pending: Buffer.alloc(0), skipping: false, snapshot: null, metadata: null, usage: null };
        this.cursors.set(path, cursor);
      }
      const buffer = Buffer.alloc(64 * 1024);
      while (cursor.offset < metadata.size && !this.disposed) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, metadata.size - cursor.offset), cursor.offset);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        while (start < chunk.length) {
          const end = chunk.indexOf(10, start);
          const part = chunk.subarray(start, end === -1 ? chunk.length : end);
          if (!cursor.skipping) {
            if (cursor.pending.length + part.length > MAX_LINE_BYTES) {
              cursor.pending = Buffer.alloc(0);
              cursor.skipping = true;
              issues.add('OVERSIZED_LINE_SKIPPED');
            } else cursor.pending = Buffer.concat([cursor.pending, part]);
          }
          if (end === -1) break;
          if (!cursor.skipping) {
            const line = cursor.pending.toString('utf8');
            const sessionMetadata = line.includes('"session_meta"') ? parseSessionMetadata(line) : null;
            if (sessionMetadata) cursor.metadata = sessionMetadata;
            const isTokenCount = line.includes('"token_count"');
            const usage = isTokenCount && cursor.metadata && parseSessionUsage(line, cursor.metadata);
            if (usage && (!cursor.usage || usage.recordedAt >= cursor.usage.recordedAt)) cursor.usage = usage;
            const snapshot = isTokenCount ? parseQuotaLine(line) : null;
            cursor.snapshot = newestSnapshot([snapshot, cursor.snapshot]);
          }
          cursor.pending = Buffer.alloc(0);
          cursor.skipping = false;
          start = end + 1;
        }
        cursor.offset += bytesRead;
        cursor.anchor = Buffer.from(Buffer.concat([cursor.anchor, chunk]).subarray(-4096));
      }
      cursor.mtime = metadata.mtimeMs;
    } finally { await file.close(); }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
    this.cursors.clear();
  }
}
