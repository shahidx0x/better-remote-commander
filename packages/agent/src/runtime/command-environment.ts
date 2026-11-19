/** Environment policy for agent-owned shell and toolchain children.
 * The isolated profile is the default; compat remains available explicitly
 * for older processes that rely on inheriting every ambient variable.
 * Isolated mode deliberately excludes ambient
 * BRC credentials and provider tokens unless the operator grants a named
 * variable via BRC_COMMAND_ENV_ALLOW (never automatically).
 * Not an OS security boundary: an authorized local shell can read disk.
 */
import {pluginEnvironment} from '../plugins/plugin-environment.js';

export type CommandEnvironmentPolicy='compat'|'isolated';
const TEST_ONLY=new Set(['NODE_TEST_CONTEXT','NODE_TEST_REPORTER']);
const ISOLATED_DENY=new Set([...TEST_ONLY,'NODE_OPTIONS']);
const VALID_NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
export function commandEnvironmentPolicy(value=process.env.BRC_COMMAND_ENV_POLICY):CommandEnvironmentPolicy{
  return value==='compat'||value==='0'?'compat':'isolated';
}
export function commandEnvironment(
  inherited:NodeJS.ProcessEnv=process.env,
  explicit:NodeJS.ProcessEnv={},
  policy:CommandEnvironmentPolicy=commandEnvironmentPolicy(),
  allowedList=process.env.BRC_COMMAND_ENV_ALLOW??'MONGODB_URI',
):NodeJS.ProcessEnv{
  const env:NodeJS.ProcessEnv=policy==='isolated'?pluginEnvironment(inherited):{...inherited};
  if(policy==='isolated'){
    for(const name of allowedList.split(',').map(n=>n.trim()).filter(Boolean)){
      if(!VALID_NAME.test(name)||ISOLATED_DENY.has(name.toUpperCase()))continue;
      const value=inherited[name]??Object.entries(inherited).find(([k])=>k.toUpperCase()===name.toUpperCase())?.[1];
      if(typeof value==='string')env[name]=value;
    }
  }
  for(const [name,value] of Object.entries(explicit)){
    if(!VALID_NAME.test(name)||(policy==='isolated'?ISOLATED_DENY:TEST_ONLY).has(name.toUpperCase()))continue;
    if(value===undefined)delete env[name];
    else env[name]=value;
  }
  for(const name of Object.keys(env)){
    if((policy==='isolated'?ISOLATED_DENY:TEST_ONLY).has(name.toUpperCase()))delete env[name];
  }
  return env;
}
export const commandEnvironmentStatus=()=>({
  policy:commandEnvironmentPolicy(),
  isolatedByDefault:commandEnvironmentPolicy()==='isolated',
  allowedNameCount:(process.env.BRC_COMMAND_ENV_ALLOW??'MONGODB_URI').split(',').filter(Boolean).length,
  note:'Isolated by default. Retains OS essentials and the MONGODB_URI variable when present (per user request); override BRC_COMMAND_ENV_ALLOW for other project names or use BRC_COMMAND_ENV_POLICY=compat. Commands can still access secrets on disk; this is not a sandbox.'
});
