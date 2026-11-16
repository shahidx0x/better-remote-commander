/**
 * Windows PowerShell 5.1 (powershell.exe) cannot parse && or ||.
 * Select cmd.exe only for a narrowly recognized native CLI chain when
 * no shell was explicitly chosen. Never rewrite arbitrary shell input.
 */
import path from 'node:path';

export interface CommandShellDecision {
  shell: string;
  originalShell: string;
  changed: boolean;
  reason?: string;
  error?: string;
  suggestedShell?: string;
  nativeChain: boolean;
}

const SAFE_NATIVE_PROGRAMS = new Set([
  'git','node','pnpm','npm','npx','corepack','python','python3',
  'pip','pip3','rg','cargo','rustc','go','dotnet','bun','deno',
  'tsc','eslint','prettier','vitest','jest','pytest','java','javac',
  'gradle','mvn',
]);

/** Count only unquoted and unescaped chain operators, not string content. */
export function nativeChainParts(command:string): {operators:string[];parts:string[]} {
  const parts:string[]=[];
  const operators:string[]=[];
  let quote:''|'"'|'\''='', start=0, escaped=false;
  for(let i=0;i<command.length;i++){
    const ch=command[i];
    if(escaped){escaped=false;continue;}
    if(ch==='`'){escaped=true;continue;} // PowerShell escape; cmd selection rejects it.
    if(quote) {
      if(ch===quote)quote='';
      continue;
    }
    if(ch==='"'||ch==="'"){quote=ch;continue;}
    if((ch==='&'||ch==='|')&&command[i+1]===ch){
      parts.push(command.slice(start,i).trim());
      operators.push(ch+ch);
      i++;start=i+1;
    }
  }
  if(operators.length)parts.push(command.slice(start).trim());
  return {operators,parts};
}

/** Only known CLI programs without PowerShell/cmd-specific syntax get auto-routed. */
export function cmdCompatibleNativeChain(command:string):boolean {
  const {operators,parts}=nativeChainParts(command);
  if(!operators.length||parts.some(x=>!x))return false;
  if(/[;|&$`{}^%!<>#'\r\n]/.test(parts.join('')))return false;
  return parts.every(s=>{
    const m=s.match(/^\s*(?:"([^"]+)"|([^\s"]+))(?:\s|$)/);
    if(!m)return false;
    const prog=path.win32.basename(m[1]??m[2]).toLowerCase()
      .replace(/\.(?:exe|cmd|bat|com)$/,'');
    return SAFE_NATIVE_PROGRAMS.has(prog);
  });
}

export function selectRunCommandShell(
  command:string, configuredShell:string, shellExplicit:boolean,
  platform:string=process.platform,
):CommandShellDecision {
  const shellName=path.win32.basename(configuredShell).toLowerCase();
  const isPS51=platform==='win32' && (shellName==='powershell.exe'||shellName==='powershell');
  const hasUnsupportedChain=isPS51 && nativeChainParts(command).operators.length>0;
  if(!hasUnsupportedChain)
    return {shell:configuredShell,originalShell:configuredShell,changed:false,nativeChain:false};
  const compatible=cmdCompatibleNativeChain(command);
  if(!shellExplicit && compatible) {
    return {shell:process.env.COMSPEC||'cmd.exe',originalShell:configuredShell,
      changed:true,nativeChain:true,reason:
        'Windows PowerShell 5.1 does not support && or ||. Selected cmd.exe for this safe native-command chain.'};
  }
  return {shell:configuredShell,originalShell:configuredShell,changed:false,
    nativeChain:compatible,suggestedShell:compatible?'cmd.exe':undefined,
    error: 'Windows PowerShell 5.1 cannot parse unquoted && or ||. NO COMMAND WAS EXECUTED. '+
      (compatible
        ? 'Use shell:"cmd.exe" (with the same command and absolute cwd), or omit the shell so the agent can select cmd.exe automatically.'
        : 'This command contains PowerShell-specific or mixed syntax; no automatic rewrite is safe. '+
          'Rewrite using PowerShell-compatible sequencing / if ($?) { ... }, or explicitly choose a compatible shell. ')+
      'Never blindly retry the identical failed request.'};
}
