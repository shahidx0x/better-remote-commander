/** Lightweight console labels and status screens; activity retains at most 500 KiB of log payload. */
import { MAX_ACTIVITY_CONSOLE_BYTES, formatActivityEvent, type ActivityEvent } from './runtime/activity.js';

export interface AgentTerminal {
  name: string;
  relay: string;
  deviceId: string;
  version: string;
  coreVersion: string;
  tools: number;
}
const plain = (s: string, max = 100) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, max);
const c = (value: string, code: string, color: boolean) => color ? '\x1b[' + code + 'm' + value + '\x1b[0m' : value;
export const terminalColors = (tty = !!process.stdout.isTTY, env = process.env) =>
  tty && !('NO_COLOR' in env) && env.TERM !== 'dumb' && env.BRC_COLOR !== '0';

export function consoleBanner(a: AgentTerminal, width = process.stdout.columns || 90, color = terminalColors()): string {
  const size = Math.min(100, Math.max(42, width - 2));
  const rule = '-'.repeat(size - 2);
  const row = (left: string) => '| ' + left.slice(0, size - 4).padEnd(size - 4, ' ') + ' |';
  const name = plain(a.name, Math.max(15, size - 21));
  const endpoint = plain(a.relay, size - 17);
  const lines = [
    '+' + rule + '+',
    row(' BRC  /  Better Remote Commander                    AGENT CONSOLE'),
    row('------------------------------------------------'),
    row(' Device    ' + name),
    row(' Relay     ' + endpoint),
    row(' Runtime   v' + a.version + '  |  Core ' + a.coreVersion + '  |  ' + a.tools + ' tools'),
    row(' Session   ' + plain(a.deviceId, 9) + '...  |  local diagnostic history'),
    '+' + rule + '+',
  ];
  if (color) {
    lines[0] = c(lines[0], '2;34', true);
    lines[1] = c(lines[1], '1;96', true);
    lines[lines.length - 1] = c(lines[lines.length - 1], '2;34', true);
  }
  return '\n' + lines.join('\n');
}

export function controlHint(tty = !!process.stdin.isTTY, color = terminalColors()): string {
  const key = (s: string) => c('[' + s + ']', '1;96', color);
  const enter = tty ? '' : ' (press Enter for commands)';
  return '  ' + key('M') + ' Settings   ' + key('S') + ' Status   '
    + key('L') + ' Last 50   ' + key('V') + ' Details   '
    + key('?') + ' Help   ' + key('Ctrl+C') + ' Stop' + enter + '\n';
}

export function connectionPanel(
  status: { online: boolean; connecting: boolean; inFlight: number; health?: {
    reconnects:number;lastDisconnectCode:string|null;heartbeatAgeMs:number|null;
    missedHeartbeats:number;socketErrors:number;droppedToolResults:number;
  } },
  a: AgentTerminal,
  color = terminalColors(),
): string {
  const state = status.online ? c('ONLINE', '1;92', color)
    : status.connecting ? c('CONNECTING', '1;93', color) : c('RECONNECTING / OFFLINE', '1;93', color);
  const h=status.health;
  const seconds=(ms:number|null)=>ms===null?'not yet observed':Math.max(0,Math.round(ms/1000))+'s ago';
  return '\n  STATUS  ' + state
    + '\n  Device   ' + plain(a.name, 64)
    + '\n  Relay    ' + plain(a.relay, 120)
    + '\n  Running  ' + status.inFlight + ' tool call(s)'
    + (h ? '\n  Link     '+h.reconnects+' reconnect(s), '+h.socketErrors+' socket error(s), '+h.missedHeartbeats+' missed heartbeat(s)'
      + '\n  Ping     '+seconds(h.heartbeatAgeMs)
      + '\n  Last close '+(h.lastDisconnectCode??'none')
      + '\n  Results  '+h.droppedToolResults+' dropped/replaced result(s)' : '')
    + '\n  Storage  500 KiB live activity + bounded, sanitized local tool-history JSONL\n';
}

export function recentActivity(events: ActivityEvent[], max = 50,
    byteBudget = MAX_ACTIVITY_CONSOLE_BYTES, mode:'compact'|'mymcp'='compact'): string {
  // The L shortcut prints the last 50 meaningful events into scrollback.
  // It does not clear the live console or render a multi-page payload.
  const recent: string[] = [];
  let bytes = 0;
  const limit = Math.max(1, Math.min(events.length, Math.floor(max)));
  for (let i = events.length - 1; i >= 0 && recent.length < limit; i--) {
    const e = events[i];
    if (e.phase === 'START' && mode !== 'mymcp') continue;
    if (e.phase === 'OK' && ['wait_jobs','get_job','list_jobs'].includes(e.tool ?? '')) continue;
    const line = formatActivityEvent(e,mode,120).split('\n')
      .map(part=>'  '+part).join('\n');
    const size = Buffer.byteLength(line + '\n', 'utf8');
    if (bytes + size > byteBudget) break;
    recent.push(line);
    bytes += size;
  }
  if (!recent.length) return '\n  RECENT ACTIVITY\n  No completed tool calls or connection changes yet.\n';
  return '\n  LAST ' + recent.length + ' ACTIVITY EVENTS  |  scroll up for older calls  |  ' +
    Math.floor(byteBudget/1024) + ' KiB console history budget\n'
    + recent.reverse().join('\n') + '\n';
}
