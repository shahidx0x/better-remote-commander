/**
 * Register the agent to start at login, per platform, without admin rights:
 *   Windows: Task Scheduler (ONLOGON, hidden window via wscript launcher)
 *   Linux:   systemd --user unit (+ loginctl enable-linger hint)
 *   macOS:   launchd LaunchAgent plist
 * The service runs `node <this cli.js>` with saved credentials, so pair first (run once interactively).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isTermuxRuntime } from './runtime/platform-capabilities.js';

const NAME = 'brc-agent';
const cliPath = () => fileURLToPath(new URL('./cli.js', import.meta.url));
const home = () => process.env.BRC_HOME ?? path.join(os.homedir(), '.brc');
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'pipe' }).toString();

export function installService(extraArgs: string[]): string {
  if(isTermuxRuntime()) throw new Error('Termux has no desktop systemd user service. Use Termux:Boot or a foreground Termux shell with node dist/cli.js --no-plugins --no-browser.');
  mkdirSync(home(), { recursive: true });
  const node = process.execPath;
  const args = [cliPath(), '--no-browser', '--non-interactive', ...extraArgs];

  if (process.platform === 'win32') {
    // .cmd holds the real command line (no nested quoting issues); wscript runs it with a hidden window.
    const cmdFile = path.join(home(), 'start-agent.cmd');
    const vbs = path.join(home(), 'start-agent.vbs');
    writeFileSync(cmdFile, `@echo off\r\nset "BRC_HOME=${home()}"\r\ncd /d "${home()}"\r\n"${node}" ${args.map((a) => `"${a}"`).join(' ')} >nul 2>&1\r\n`);
    writeFileSync(vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "cmd /c ""${cmdFile}""", 0, True\r\n`);
    run('schtasks', ['/Create', '/F', '/TN', NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', `wscript.exe "${vbs}"`]);
    run('schtasks', ['/Run', '/TN', NAME]);
    return `Installed Task Scheduler task "${NAME}" (runs at logon, hidden). Logs are not saved.\nManage: schtasks /Query /TN ${NAME} | schtasks /End /TN ${NAME}`;
  }
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    const unit = path.join(dir, `${NAME}.service`);
    writeFileSync(unit, `[Unit]\nDescription=Better Remote Commander (BRC) device agent\nAfter=network-online.target\n\n[Service]\nExecStart=${node} ${args.join(' ')}\nStandardOutput=null\nStandardError=null\nRestart=always\nRestartSec=5\nEnvironment=BRC_HOME=${home()}\n\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', `${NAME}.service`]);
    return `Installed systemd user unit ${unit}.\nTo keep it running when logged out: sudo loginctl enable-linger ${os.userInfo().username}\nOutput is discarded; use START_AGENT.cmd or the foreground CLI for live logs.`;
  }
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, `dev.brc.${NAME}.plist`);
    const xmlArgs = [node, ...args].map((a) => `    <string>${a}</string>`).join('\n');
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>dev.brc.${NAME}</string>\n  <key>ProgramArguments</key><array>\n${xmlArgs}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>/dev/null</string>\n  <key>StandardErrorPath</key><string>/dev/null</string>\n  <key>EnvironmentVariables</key><dict><key>BRC_HOME</key><string>${home()}</string></dict>\n</dict></plist>\n`);
    try { run('launchctl', ['unload', plist]); } catch { /* not loaded */ }
    run('launchctl', ['load', '-w', plist]);
    return `Installed LaunchAgent ${plist}. Logs are not saved.`;
  }
  throw new Error(`unsupported platform ${process.platform}`);
}

export function uninstallService(): string {
  if(isTermuxRuntime()) throw new Error('Termux does not use BRC desktop service registration. Manage your Termux:Boot script or foreground shell instead.');
  if (process.platform === 'win32') {
    try { run('schtasks', ['/End', '/TN', NAME]); } catch { /* not running */ }
    run('schtasks', ['/Delete', '/F', '/TN', NAME]);
    for (const f of ['start-agent.vbs', 'start-agent.cmd']) { const p = path.join(home(), f); if (existsSync(p)) unlinkSync(p); }
    return `Removed Task Scheduler task "${NAME}". If an agent is still running, stop it: find its specific PID with list_processes; do not terminate unrelated Node processes.`;
  }
  if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', `${NAME}.service`);
    try { run('systemctl', ['--user', 'disable', '--now', `${NAME}.service`]); } catch { /* not enabled */ }
    if (existsSync(unit)) unlinkSync(unit);
    run('systemctl', ['--user', 'daemon-reload']);
    return `Removed systemd user unit ${NAME}.service.`;
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `dev.brc.${NAME}.plist`);
    try { run('launchctl', ['unload', plist]); } catch { /* not loaded */ }
    if (existsSync(plist)) unlinkSync(plist);
    return `Removed LaunchAgent ${plist}.`;
  }
  throw new Error(`unsupported platform ${process.platform}`);
}
