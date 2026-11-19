/** Agent defaults for tested bounded features.
 *
 * Features work after a normal local-agent restart without editing .env.
 * An explicit 0 disables a feature, explicit 1 enables it; unset uses
 * the tested default. Never override explicitly configured user choices.
 */
export const enabledByDefault=(name:string):boolean=>{
  const value=process.env[name];
  if(value==='0')return false;
  if(value==='1')return true;
  return true;
};
/** Explicit opt-in remains required when stored output may contain private
 * data despite best-effort redaction. */
export const explicitOptIn=(name:string):boolean=>process.env[name]==='1';
