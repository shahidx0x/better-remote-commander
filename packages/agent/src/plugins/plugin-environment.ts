/** Minimal inherited environment for untrusted local MCP plugin processes.
 * Credentials are supplied only through the plugin's explicit env map.
 * Deliberately omit NODE_OPTIONS, NPM_TOKEN, BRC_* and provider API keys.
 */
const INHERITED = new Set([
 'PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR',
 'USERPROFILE','USERNAME','USERDOMAIN','HOMEDRIVE','HOMEPATH','APPDATA',
 'LOCALAPPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)',
 'COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','PROCESSOR_ARCHITECTURE',
 'HOME','SHELL','LANG','LANGUAGE','LC_ALL','LC_CTYPE','TERM',
 'XDG_RUNTIME_DIR','XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME',
 'DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS',
 'SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS',
]);
const upper=(s:string)=>s.toUpperCase();
/** A plugin's explicitly configured credentials are preserved; unrelated
 * environment secrets are never inherited accidentally. */
export function pluginEnvironment(
  inherit: NodeJS.ProcessEnv = process.env,
  explicit: Record<string,string> = {},
):Record<string,string> {
  const env:Record<string,string>={};
  for(const [key,value] of Object.entries(inherit)){
    if(typeof value==='string' && INHERITED.has(upper(key)))env[key]=value;
  }
  for(const [key,value] of Object.entries(explicit)){
    if(typeof value==='string')env[key]=value;
  }
  return env;
}
