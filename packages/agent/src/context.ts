/**
 * SES-RDP: replaces the module-level client state that upstream kept in server.ts.
 * The agent transport sets these per tool call so telemetry/config code keeps working.
 */
export let currentClient: { name: string; version: string } = { name: 'ses-rdp-agent', version: '0.0.0' };
export let currentCallIsRemote = true;
export let currentRemoteClient: { name?: string; version?: string } | null = null;

export function setCurrentClient(info: { name?: string; version?: string }): void {
  currentClient = { name: info.name ?? 'unknown', version: info.version ?? 'unknown' };
}

export function setCurrentCallIsRemote(isRemote: boolean): void {
  currentCallIsRemote = isRemote;
}

export function setCurrentRemoteClient(info: { name?: string; version?: string } | null): void {
  currentRemoteClient = info;
}
