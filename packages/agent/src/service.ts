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

const NAME = 'ses-rdp-agent';
const cliPath = () => fileURLToPath(new URL('./cli.js', import.meta.url));
const home = () => process.env.SES_RDP_HOME ?? path.join(os.homedir(), '.ses-rdp');
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'pipe' }).toString();

export function installService(extraArgs: string[]): string {
  mkdirSync(home(), { recursive: true });
  const node = process.execPath;
  const args = [cliPath(), '--no-browser', ...extraArgs];
  const logFile = path.join(home(), 'agent.log');

  if (process.platform === 'win32') {
    // .cmd holds the real command line (no nested quoting issues); wscript runs it with a hidden window.
    const cmdFile = path.join(home(), 'start-agent.cmd');
    const vbs = path.join(home(), 'start-agent.vbs');
    writeFileSync(cmdFile, `@echo off\r\ncd /d "${home()}"\r\n"${node}" ${args.map((a) => `"${a}"`).join(' ')} >> "${logFile}" 2>&1\r\n`);
    writeFileSync(vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "cmd /c ""${cmdFile}""", 0, False\r\n`);
    run('schtasks', ['/Create', '/F', '/TN', NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', `wscript.exe "${vbs}"`]);
    run('schtasks', ['/Run', '/TN', NAME]);
    return `Installed Task Scheduler task "${NAME}" (runs at logon, hidden). Log: ${logFile}\nManage: schtasks /Query /TN ${NAME} | schtasks /End /TN ${NAME}`;
  }
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    const unit = path.join(dir, `${NAME}.service`);
    writeFileSync(unit, `[Unit]\nDescription=SES-RDP device agent\nAfter=network-online.target\n\n[Service]\nExecStart=${node} ${args.join(' ')}\nRestart=always\nRestartSec=5\nEnvironment=SES_RDP_HOME=${home()}\n\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', `${NAME}.service`]);
    return `Installed systemd user unit ${unit}.\nTo keep it running when logged out: sudo loginctl enable-linger ${os.userInfo().username}\nLogs: journalctl --user -u ${NAME} -f`;
  }
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, `com.ses-systems.${NAME}.plist`);
    const xmlArgs = [node, ...args].map((a) => `    <string>${a}</string>`).join('\n');
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>com.ses-systems.${NAME}</string>\n  <key>ProgramArguments</key><array>\n${xmlArgs}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>${logFile}</string>\n  <key>StandardErrorPath</key><string>${logFile}</string>\n  <key>EnvironmentVariables</key><dict><key>SES_RDP_HOME</key><string>${home()}</string></dict>\n</dict></plist>\n`);
    try { run('launchctl', ['unload', plist]); } catch { /* not loaded */ }
    run('launchctl', ['load', '-w', plist]);
    return `Installed LaunchAgent ${plist}. Log: ${logFile}`;
  }
  throw new Error(`unsupported platform ${process.platform}`);
}

export function uninstallService(): string {
  if (process.platform === 'win32') {
    try { run('schtasks', ['/End', '/TN', NAME]); } catch { /* not running */ }
    run('schtasks', ['/Delete', '/F', '/TN', NAME]);
    for (const f of ['start-agent.vbs', 'start-agent.cmd']) { const p = path.join(home(), f); if (existsSync(p)) unlinkSync(p); }
    return `Removed Task Scheduler task "${NAME}". If an agent is still running, stop it: taskkill /F /IM node.exe (or find the PID with list_processes).`;
  }
  if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', `${NAME}.service`);
    try { run('systemctl', ['--user', 'disable', '--now', `${NAME}.service`]); } catch { /* not enabled */ }
    if (existsSync(unit)) unlinkSync(unit);
    run('systemctl', ['--user', 'daemon-reload']);
    return `Removed systemd user unit ${NAME}.service.`;
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `com.ses-systems.${NAME}.plist`);
    try { run('launchctl', ['unload', plist]); } catch { /* not loaded */ }
    if (existsSync(plist)) unlinkSync(plist);
    return `Removed LaunchAgent ${plist}.`;
  }
  throw new Error(`unsupported platform ${process.platform}`);
}
