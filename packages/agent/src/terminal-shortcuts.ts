/** Tiny event-driven console controls. No prompt history, polling, redraw loop or disk state. */
import type { Readable, Writable } from 'node:stream';
import type { DeviceCredentials } from './transport/pairing.js';

export type StartupChoice = 'connect' | 'settings' | 'exit';
export type Shortcut = StartupChoice | 'closed' | 'status' | 'activity' | 'verbose' | 'help';
type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
export const AUTO_CONNECT_DELAY_MS = 4000;

/** Single-key controls in a real console; bounded line commands for explicitly enabled pipe mode. */
export function listenForTerminalShortcuts(
  input: TerminalInput,
  onChoice: (choice: Shortcut) => void,
  options: { signal?: AbortSignal; enterConnects?: boolean; liveCommands?: boolean } = {},
): { close(): void } {
  let closed = false, pending = '', discardLine = false, raw = false;
  const wasRaw = !!input.isRaw;
  const wasPaused = input.isPaused();
  const close = () => {
    if (closed) return;
    closed = true;
    pending = '';
    input.off('data', data);
    input.off('end', ended);
    input.off('close', ended);
    input.off('error', ended);
    options.signal?.removeEventListener('abort', aborted);
    if (raw) { try { input.setRawMode?.(wasRaw); } catch { /* Console may already be closed. */ } }
    if (wasPaused || raw) input.pause();
  };
  const choose = (value: string) => {
    if (closed) return;
    if (value === '\x03') { onChoice('exit'); return; }
    if (/^(?:m|menu|settings)$/i.test(value)) onChoice('settings');
    else if (options.enterConnects && (value === '' || value === '1')) onChoice('connect');
    else if (options.liveCommands) {
      if (/^(?:s|status)$/i.test(value)) onChoice('status');
      else if (/^(?:l|logs|activity)$/i.test(value)) onChoice('activity');
      else if (/^(?:v|verbose)$/i.test(value)) onChoice('verbose');
      else if (/^(?:h|help|\?)$/i.test(value)) onChoice('help');
    }
  };
  const data = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (closed) return;
    if (raw) {
      // Ignore pasted multi-character content and escape sequences, not just arbitrary first bytes.
      if (text.length === 1) choose(text === '\r' || text === '\n' ? '' : text);
      return;
    }
    if (text.length > 4096) { pending = ''; discardLine = true; return; }
    for (const char of text) {
      if (closed) break;
      if (char === '\x03') { choose(char); continue; }
      if (char === '\r') continue;
      if (char === '\n') {
        const line = pending.trim(); pending = '';
        if (!discardLine) choose(line);
        discardLine = false;
      } else if (!discardLine) {
        pending += char;
        if (pending.length > 32) { pending = ''; discardLine = true; }
      }
    }
  };
  const ended = () => { if (!closed) { close(); onChoice('closed'); } };
  const aborted = () => { if (!closed) { close(); onChoice('exit'); } };
  if (options.signal?.aborted) { closed = true; onChoice('exit'); return { close }; }
  if (input.destroyed || input.readableEnded) { closed = true; onChoice('closed'); return { close }; }
  if (input.isTTY && input.setRawMode) {
    try { input.setRawMode(true); raw = true; } catch { /* Fall back to M + Enter. */ }
  }
  input.on('data', data);
  input.once('end', ended);
  input.once('close', ended);
  input.once('error', ended);
  options.signal?.addEventListener('abort', aborted, { once: true });
  input.resume();
  return { close };
}

/** One startup timer only. Opening settings cancels it rather than leaving a hidden auto-connect. */
export async function waitForSavedConnection(
  saved: DeviceCredentials,
  signal?: AbortSignal,
  input: TerminalInput = process.stdin,
  output: Writable = process.stdout,
  delayMs = AUTO_CONNECT_DELAY_MS,
): Promise<StartupChoice> {
  if (signal?.aborted) return 'exit';
  const display = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 160);
  output.write(`Saved relay: ${display(saved.relayUrl)}\n`);
  const key = input.isTTY && input.setRawMode ? 'M' : 'M + Enter';
  output.write(`Auto-connect in ${Math.ceil(delayMs / 1000)}s. Enter = connect now | ${key} = settings | Ctrl+C = exit\n`);
  return new Promise(resolve => {
    let done = false, controls: { close(): void } | undefined;
    const finish = (choice: Shortcut) => {
      if (done || !['connect','settings','exit','closed'].includes(choice)) return;
      done = true;
      clearTimeout(timer);
      controls?.close();
      resolve(choice === 'closed' ? 'connect' : choice as StartupChoice);
    };
    const timer = setTimeout(() => finish('connect'), delayMs);
    controls = listenForTerminalShortcuts(input, finish, { signal, enterConnects: true });
    if (done) controls.close();
  });
}
