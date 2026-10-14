export interface NativeSnapshot { documentId: string; path: string | null; text: string; revision: number; savedDigest: string | null; encoding: string; lineEnding: string }
export interface NativeReply { id: number; ok: boolean; result?: unknown; error?: { code: string; message: string } }
export class NativeError extends Error { code: string; constructor(code: string, message: string) { super(message); this.name = 'NativeError'; this.code = code; } }
export function normalizeSnapshot(value: unknown): NativeSnapshot {
  const data = value as Partial<NativeSnapshot> | null;
  if (!data || typeof data.documentId !== 'string' || !data.documentId || typeof data.text !== 'string' || !Number.isInteger(data.revision) || data.revision! < 0 || (data.path != null && typeof data.path !== 'string') || (data.savedDigest != null && typeof data.savedDigest !== 'string')) throw new Error('Invalid document snapshot');
  return { documentId: data.documentId, text: data.text, revision: data.revision!, path: data.path ?? null, savedDigest: data.savedDigest ?? null, encoding: data.encoding ?? 'utf8', lineEnding: data.lineEnding ?? (data.text.includes('\r\n') ? 'CRLF' : 'LF') };
}
interface Pending { resolve: (value: any) => void; reject: (reason: Error) => void; timeout?: ReturnType<typeof setTimeout> }
const interactiveMethods = new Set(['chooseDocument', 'chooseWorkspace', 'saveAs', 'saveDocument', 'export', 'import', 'importDocument', 'importImages', 'themeFiles', 'dictionary', 'print']);
export class NativeClient {
  target: Window; private nextId = 1; private pending = new Map<number, Pending>(); private previous: unknown; private receiver: (value: unknown) => void; private disposed = false;
  constructor(target: Window = window) {
    this.target = target; this.previous = (target as any).__nativeReply;
    this.receiver = value => this.reply(value); (target as any).__nativeReply = this.receiver;
  }
  call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const handler = (this.target as any).webkit?.messageHandlers?.native;
    if (this.disposed) return Promise.reject(new NativeError('disposed', 'Native client closed'));
    if (!handler?.postMessage) return Promise.reject(new NativeError('unavailable', 'Native host unavailable. Open Inkleaf as a desktop app.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const processSeconds = typeof args.timeout === 'number' && Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 60;
      const budget = method === 'runTool' ? (processSeconds + 15) * 1000 : 30_000;
      const timeout = interactiveMethods.has(method) ? undefined : setTimeout(() => { this.pending.delete(id); reject(new NativeError('timeout', `${method} did not respond. Try again.`)); }, budget);
      this.pending.set(id, { resolve, reject, timeout });
      try { handler.postMessage({ id, method, args }); } catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }
  private reply(value: unknown): void {
    let reply: any = value;
    if (typeof value === 'string') { try { reply = JSON.parse(value); } catch { this.rejectAll(new NativeError('protocol', 'Invalid native reply: malformed JSON')); return; } }
    if (!reply || !Number.isInteger(reply.id)) { this.rejectAll(new NativeError('protocol', 'Invalid native reply: missing id')); return; }
    if (reply.id === -1) { this.rejectAll(new NativeError('protocol', typeof reply.error?.message === 'string' ? reply.error.message : 'Uncorrelated native protocol failure')); return; }
    const pending = this.pending.get(reply.id); if (!pending) return;
    this.pending.delete(reply.id); clearTimeout(pending.timeout);
    if (typeof reply.ok !== 'boolean' || (reply.ok && !Object.hasOwn(reply, 'result')) || (!reply.ok && (!reply.error || typeof reply.error.code !== 'string' || typeof reply.error.message !== 'string'))) { pending.reject(new NativeError('protocol', 'Invalid native reply')); return; }
    if (reply.ok) pending.resolve(reply.result); else pending.reject(new NativeError(reply.error.code, reply.error.message));
  }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); } this.pending.clear(); }
  dispose(): void { this.disposed = true; this.rejectAll(new NativeError('disposed', 'Native client closed')); if ((this.target as any).__nativeReply === this.receiver) (this.target as any).__nativeReply = typeof this.previous === 'function' ? this.previous : () => {}; }
}
