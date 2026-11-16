/** On-demand connection menu. Saved foreground sessions auto-connect unless settings are requested. */
import { createInterface } from 'node:readline';
import { waitForSavedConnection, type StartupChoice } from './terminal-shortcuts.js';
import type { Readable, Writable } from 'node:stream';
import { loadCredentials, clearCredentials, pairDevice, type DeviceCredentials, type PairOptions } from './transport/pairing.js';
import { normalizeRelayUrl, isUnencryptedRemoteRelay } from './transport/relay-url.js';

export interface SetupIO {
  ask(prompt: string): Promise<string | null>;
  write(message: string): void;
  readonly signal?: AbortSignal;
}
export interface ConnectionOptions {
  interactive: boolean;
  setup?: boolean;
  autoConnect?: boolean;
  returnToAgent?: boolean;
  nonInteractive?: boolean;
  relay?: string;
  token?: string;
  deviceId?: string;
  name: string;
  noBrowser?: boolean;
  signal?: AbortSignal;
}
export interface ConnectionDependencies {
  load: () => DeviceCredentials | null;
  clear: () => boolean;
  pair: (options: PairOptions) => Promise<DeviceCredentials>;
  autostart?: (saved: DeviceCredentials, signal?: AbortSignal) => Promise<StartupChoice>;
}
const defaults: ConnectionDependencies = { load: loadCredentials, clear: clearCredentials, pair: pairDevice };
const display = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 180);
const quit = (s: string | null) => s === null || /^(?:q|quit|exit|0)$/i.test(s.trim());

export function shouldPromptForConnection(options: ConnectionOptions): boolean {
  if (options.setup && options.nonInteractive) throw new Error('--setup and --non-interactive cannot be combined.');
  return !options.nonInteractive && (!!options.setup || ((options.interactive || !!options.autoConnect) && !options.relay && !options.token));
}

/** A bounded line queue also supports pasted input and deterministic pipe-based CLI tests. */
export function createTerminalPrompts(input: Readable = process.stdin, output: Writable = process.stdout, externalSignal?: AbortSignal): SetupIO & { close(): void } {
  const controller = new AbortController();
  const terminal = !!(input as NodeJS.ReadStream).isTTY && !!(output as NodeJS.WriteStream).isTTY;
  const reader = createInterface({ input, output, terminal, historySize: 0, crlfDelay: Infinity });
  const lines: string[] = [];
  let closed = false, waiting: ((line: string | null) => void) | undefined;
  const cancel = () => {
    if (closed) return;
    closed = true;
    lines.length = 0;
    controller.abort(new DOMException('Setup cancelled.', 'AbortError'));
    const resolve = waiting; waiting = undefined; resolve?.(null);
    reader.close();
  };
  reader.on('line', line => {
    if (closed) return;
    if (line.length > 4096 || lines.length >= 16) { output.write('\nInput is too long; setup cancelled.\n'); cancel(); return; }
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(line); }
    else lines.push(line);
  });
  reader.on('SIGINT', cancel);
  reader.on('close', cancel);
  reader.on('error', cancel);
  externalSignal?.addEventListener('abort', cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  return {
    signal: controller.signal,
    write(message) { if (!closed) output.write(message + '\n'); },
    async ask(prompt) {
      if (closed) return null;
      output.write(prompt);
      if (lines.length) return lines.shift()!;
      if (waiting) throw new Error('Only one connection prompt may be active.');
      return new Promise(resolve => { waiting = resolve; });
    },
    close() { externalSignal?.removeEventListener('abort', cancel); cancel(); input.pause(); },
  };
}

export async function resolveStartupConnection(options: ConnectionOptions, io?: SetupIO, deps: ConnectionDependencies = defaults): Promise<DeviceCredentials | null> {
  const prompt = shouldPromptForConnection(options);
  const saved = deps.load();
  options.signal?.throwIfAborted();
  if (prompt) {
    if (saved && !options.setup) {
      const choice = await (deps.autostart ?? waitForSavedConnection)(saved, options.signal);
      if (choice === 'exit') return null;
      if (choice === 'connect') return saved;
    }
    if (!io) throw new Error('An interactive console is required for setup.');
    return connectionMenu(options, io, deps, saved);
  }
  options.signal?.throwIfAborted();
  const relay = options.relay ? normalizeRelayUrl(options.relay) : undefined;
  if (options.token) {
    if (!relay || !options.deviceId) throw new Error('--token requires --relay and --device-id.');
    return { relayUrl: relay, deviceId: options.deviceId, deviceToken: options.token, name: options.name, pairedAt: 'manual' };
  }
  if (saved && (!relay || saved.relayUrl === relay)) return saved;
  if (!relay) throw new Error('No saved relay. Open START_AGENT.cmd in a terminal for setup, or supply --relay <base-url> for unattended startup.');
  return deps.pair({ relayUrl: relay, name: options.name, deviceId: options.deviceId, openBrowser: !options.noBrowser, log: message => console.log(message), signal: options.signal });
}

async function connectionMenu(options: ConnectionOptions, io: SetupIO, deps: ConnectionDependencies, initial: DeviceCredentials | null): Promise<DeviceCredentials | null> {
  let saved = initial;
  // Forget clears only the endpoint/token, not the user's preferred device label.
  const previousName = initial?.name ?? options.name;
  io.write('\nBRC Agent | Connection setup');
  io.write('Live activity only. No diagnostic log files are saved.');
  if (options.setup && (options.relay || options.token)) io.write('Setup ignores connection environment/arguments for this run; they are not changed.');
  for (;;) {
    if (io.signal?.aborted) return null;
    if (saved) {
      io.write(`\nSaved relay: ${display(saved.relayUrl)}`);
      io.write(`Device: ${display(saved.name)}`);
      io.write('  1) Connect to saved relay (Enter)\n  2) Change relay URL\n  3) Forget saved URL and pairing\n  0) ' + (options.returnToAgent ? 'Back to live logs' : 'Exit'));
      const raw = await io.ask('Choose [1]: ');
      if (quit(raw)) return null;
      const choice = raw!.trim().toLowerCase();
      if (choice === '' || choice === '1' || choice === 'connect') return saved;
      if (choice === '3' || choice === 'forget') {
        const yes = await io.ask('Forget the saved URL and local device token? [y/N]: ');
        if (yes === null) return null;
        if (!/^(?:y|yes)$/i.test(yes.trim())) { io.write('Nothing forgotten.'); continue; }
        deps.clear();
        saved = null;
        io.write('Saved relay and local pairing forgotten. Projects and settings were not changed.');
        io.write('This does not revoke the device on the old relay. Remove it there separately when needed.');
        io.write('Enter a new URL below, or q to exit without a saved connection.');
      } else if (choice === '2' || choice === 'change') {
        io.write('Your current pairing stays saved until the new pairing succeeds.');
      } else { io.write('Choose 1, 2, 3 or 0.'); continue; }
    }
    const next = await newConnection(options, io, deps, saved?.name ?? previousName);
    if (next === 'back') continue;
    return next;
  }
}

async function newConnection(options: ConnectionOptions, io: SetupIO, deps: ConnectionDependencies, defaultName: string): Promise<DeviceCredentials | null | 'back'> {
  let relay: string | undefined, name = defaultName;
  for (;;) {
    if (!relay) {
      io.write('\nPaste your BRC relay base URL (example: https://brc.example.com).');
      io.write('A pasted /mcp endpoint is converted to its base URL. q = quit, b = back.');
      const raw = await io.ask('Relay URL: ');
      if (quit(raw)) return null;
      if (/^(?:b|back)$/i.test(raw!.trim())) return 'back';
      try { relay = normalizeRelayUrl(raw!, true); }
      catch (error) { io.write(display((error as Error).message)); continue; }
      io.write(`Relay: ${display(relay)}`);
      if (isUnencryptedRemoteRelay(relay)) {
        io.write('Warning: this remote URL uses unencrypted HTTP. HTTPS is recommended.');
        const answer = await io.ask('Continue with HTTP? [y/N]: ');
        if (answer === null) return null;
        if (!/^(?:y|yes)$/i.test(answer.trim())) { relay = undefined; continue; }
      }
      for (;;) {
        const answer = await io.ask(`Device name [${display(defaultName)}]: `);
        if (answer === null) return null;
        name = answer.trim() || defaultName;
        if (name.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(name)) { io.write('Use a device name of 1-80 printable characters.'); continue; }
        break;
      }
    }
    try {
      io.signal?.throwIfAborted();
      io.write('Starting pairing. Approve the displayed code on your relay. Ctrl+C cancels.');
      return await deps.pair({ relayUrl: relay, name, deviceId: options.setup ? undefined : options.deviceId, openBrowser: !options.noBrowser, log: message => io.write(message), signal: io.signal ?? options.signal });
    } catch (error) {
      if (io.signal?.aborted || options.signal?.aborted) return null;
      // Never dump a stack, a saved token or an entered credential-bearing URL.
      const message = error instanceof Error ? error.message : 'Connection failed.';
      io.write('Pairing did not finish: ' + display(message));
      for (;;) {
        const answer = await io.ask('Enter = retry, u = another URL, b = menu, q = exit: ');
        if (quit(answer)) return null;
        const choice = answer!.trim().toLowerCase();
        if (choice === '') break;
        if (choice === 'u' || choice === 'url') { relay = undefined; break; }
        if (choice === 'b' || choice === 'back') return 'back';
        io.write('Choose Enter, u, b or q.');
      }
    }
  }
}
