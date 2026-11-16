/**
 * BRC agent CLI: plugin management flags. Each command prints a result and returns an exit code.
 *
 *   --list-plugins
 *   --add-plugin <id>                                      re-add a default plugin by id
 *   --add-plugin <id> --npm <pkg>[@<ver>] | --pypi <pkg>[==<ver>] | --command "<cmd> <args...>" | --url <https url>
 *                     [--env KEY=VALUE ...] [--name "<display name>"]
 *   --remove-plugin <id>
 *   --enable-plugin <id> / --disable-plugin <id>
 *   --update-plugins                                       latest versions for the default plugins, reinstall
 */
import { currentDefaultsContext, defaultPluginDef, DEFAULT_PLUGIN_IDS, resolveLatestVersions } from './defaults.js';
import { registerInstaller } from './installer.js';
import { definePlugin, installPlugin, listPlugins, pluginSummary, removePlugin, setPluginEnabled } from './manager.js';
import { getPlugin } from './store.js';
import type { InstallLog, PluginRecord, PluginSource } from './types.js';

export const PLUGIN_COMMAND_FLAGS = ['list-plugins', 'add-plugin', 'remove-plugin', 'enable-plugin', 'disable-plugin', 'update-plugins'];

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}
function argValues(argv: string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
}

/** Split a command line into words (double/single quotes group, backslashes are literal for Windows paths). */
export function splitCommandLine(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = ''; has = false;
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error('unterminated quote in --command');
  if (has || cur) out.push(cur);
  return out;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'brc-agent' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

/** Parse --npm / --pypi / --command / --url into a source (resolving "latest" when no version is given). */
async function sourceFromArgs(argv: string[]): Promise<PluginSource | undefined> {
  const npm = argValue(argv, 'npm');
  if (npm) {
    const at = npm.lastIndexOf('@');
    const pkg = at > 0 ? npm.slice(0, at) : npm;
    const version = at > 0 ? npm.slice(at + 1) : String((await fetchJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`)).version);
    return { type: 'npm', package: pkg, version };
  }
  const pypi = argValue(argv, 'pypi');
  if (pypi) {
    if (pypi.startsWith('git+')) return { type: 'pypi', package: pypi, version: '' };
    const [pkg, version] = pypi.split('==');
    return { type: 'pypi', package: pkg, version: version || String((await fetchJson(`https://pypi.org/pypi/${pkg}/json`)).info.version) };
  }
  const cmd = argValue(argv, 'command');
  if (cmd) {
    const [command, ...args] = splitCommandLine(cmd);
    if (!command) throw new Error('--command is empty');
    return { type: 'command', command, args };
  }
  const url = argValue(argv, 'url');
  if (url) {
    if (new URL(url).protocol !== 'https:') throw new Error('--url must be an https URL');
    return { type: 'remote', url };
  }
  return undefined;
}

function parseEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq <= 0) throw new Error(`--env expects KEY=VALUE, got "${p}"`);
    env[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return env;
}

function describe(rec: PluginRecord): string {
  const s = pluginSummary(rec);
  const lines = [`${s.id.padEnd(14)} ${String(s.status).padEnd(11)} ${(s.enabled ? 'enabled' : 'disabled').padEnd(9)} ${s.type.padEnd(7)} ${s.package ?? ''}${s.toolCount ? `  (${s.toolCount} tools)` : ''}`];
  if (s.userAction) lines.push(`${''.padEnd(15)}to do: ${s.userAction}`);
  else if (s.error) lines.push(`${''.padEnd(15)}error: ${s.error.split('\n')[0].slice(0, 300)}`);
  return lines.join('\n');
}

function consoleLog(debug: boolean): InstallLog {
  return (level, msg) => {
    if (level === 'debug' && !debug) return;
    (level === 'error' ? console.error : console.log)(`  [${level}] ${msg}`);
  };
}

async function installAndReport(id: string, log: InstallLog): Promise<number> {
  const t0 = Date.now();
  const rec = await installPlugin(id, log);
  console.log(describe(rec));
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return rec.status === 'failed' ? 1 : 0;
}

/** Handle a plugin CLI flag. Returns the exit code, or null when argv has no plugin command. */
export async function runPluginCommand(argv: string[], debug = false): Promise<number | null> {
  const cmd = PLUGIN_COMMAND_FLAGS.find((f) => argv.includes(`--${f}`));
  if (!cmd) return null;
  registerInstaller();
  const log = consoleLog(debug);
  try {
    switch (cmd) {
      case 'list-plugins': {
        const all = listPlugins();
        if (!all.length) { console.log('No plugins set up yet (they are added on the first agent start).'); return 0; }
        console.log(`${'id'.padEnd(14)} ${'status'.padEnd(11)} ${'state'.padEnd(9)} ${'type'.padEnd(7)} package`);
        for (const r of all) console.log(describe(r));
        return 0;
      }
      case 'add-plugin': {
        const id = argValue(argv, 'add-plugin');
        if (!id || !ID.test(id)) { console.error('Usage: --add-plugin <id> [--npm <pkg>@<ver> | --pypi <pkg>==<ver> | --command "<cmd> <args>" | --url <https url>] [--env KEY=VALUE ...]'); return 2; }
        const env = parseEnv(argValues(argv, 'env'));
        const source = await sourceFromArgs(argv);
        if (!source) {
          const def = defaultPluginDef(id, currentDefaultsContext());
          if (!def) { console.error(`"${id}" is not a default plugin (${DEFAULT_PLUGIN_IDS.join(', ')}); give a source with --npm, --pypi, --command or --url.`); return 2; }
          await definePlugin({ ...def, env: { ...def.env, ...env }, status: def.status ?? 'pending' });
        } else {
          const prev = getPlugin(id);
          await definePlugin({
            id, name: argValue(argv, 'name') ?? prev?.name ?? id, description: prev?.description, source,
            enabled: true, origin: 'user', env: Object.keys(env).length ? env : prev?.env, status: 'pending',
          });
        }
        const rec = getPlugin(id)!;
        if (rec.status === 'unsupported') { console.log(describe(rec)); return 0; }
        console.log(`Installing ${id}...`);
        return await installAndReport(id, log);
      }
      case 'remove-plugin': {
        const id = argValue(argv, 'remove-plugin');
        if (!id) { console.error('Usage: --remove-plugin <id>'); return 2; }
        const ok = await removePlugin(id, log);
        console.log(ok ? `Removed plugin "${id}".` : `No plugin "${id}".`);
        return ok ? 0 : 1;
      }
      case 'enable-plugin':
      case 'disable-plugin': {
        const id = argValue(argv, cmd);
        if (!id) { console.error(`Usage: --${cmd} <id>`); return 2; }
        if (!getPlugin(id)) { console.error(`No plugin "${id}".`); return 1; }
        const rec = await setPluginEnabled(id, cmd === 'enable-plugin');
        console.log(describe(rec));
        return 0;
      }
      case 'update-plugins': {
        console.log('Looking up the latest versions of the default plugins...');
        const latest = await resolveLatestVersions();
        const ctx = currentDefaultsContext();
        let failed = 0;
        for (const id of DEFAULT_PLUGIN_IDS) {
          const cur = getPlugin(id);
          if (!cur || cur.origin !== 'default') continue; // removed or replaced by the user
          const def = defaultPluginDef(id, ctx, latest)!;
          const oldV = 'version' in cur.source ? cur.source.version : undefined;
          const newV = 'version' in def.source ? def.source.version : undefined;
          const changed = oldV !== newV;
          if (!changed && cur.status === 'installed') { console.log(`${id}: ${oldV} (up to date)`); continue; }
          if (def.status === 'unsupported') { console.log(`${id}: unsupported here`); continue; }
          console.log(`${id}: ${oldV} -> ${newV}`);
          await definePlugin({ ...def, enabled: cur.enabled, env: { ...def.env, ...cur.env }, status: 'pending' });
          if ((await installAndReport(id, log)) !== 0) failed++;
        }
        return failed ? 1 : 0;
      }
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return null;
}
