/** Owner-approved skill library. Skill text is untrusted content, never executed. */
export interface SkillFile { path:string; contents:string }
export interface SkillRow { id:string; user_id:string; name:string; description:string; source:string; files_json:string; created_at:number; updated_at:number }
export interface SkillRequest { id:string; user_id:string; skill_id:string; client:string; reason:string; created_at:number }
export interface CatalogSkill { id:string; name:string; source:string; installs:number; url:string; description?:string }
const ID=/^[a-zA-Z0-9][\w.-]*(?:\/[a-zA-Z0-9][\w.-]*){1,3}$/;
const FILE=/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[\w .@/-]{1,160}$/;
export function validSkillId(id:unknown):id is string {return typeof id==='string' && id.length<=160 && ID.test(id)}
export function validateSkill(input:unknown,user:string,existingCreatedAt?:number):SkillRow {
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Expected skill object');
 const a=input as Record<string,unknown>;
 if(!validSkillId(a.id))throw Error('Skill ID must look like owner/repo/skill or local/name');
 const name=String(a.name??'').trim(),description=String(a.description??'').trim(),source=String(a.source??'').trim();
 if(!name||name.length>100||description.length>600||source.length>400)throw Error('Invalid skill name, description or source');
 const files=a.files;
 if(!Array.isArray(files)||files.length<1||files.length>32)throw Error('Expected 1-32 skill files');
 let total=0; const seen=new Set<string>();
 const clean:SkillFile[]=files.map((file:unknown)=>{
   if(!file||typeof file!=='object')throw Error('Invalid skill file');
   const f=file as Record<string,unknown>;
   if(typeof f.path!=='string'||!FILE.test(f.path)||typeof f.contents!=='string')throw Error('Invalid skill path or content');
   if(seen.has(f.path))throw Error('Duplicate skill path');
   seen.add(f.path);total+=Buffer.byteLength(f.contents,'utf8');
   if(total>128*1024)throw Error('Skill content exceeds 128 KiB');
   return {path:f.path,contents:f.contents};
 });
 if(!seen.has('SKILL.md'))throw Error('SKILL.md is required');
 const now=Date.now();
 return {id:a.id,user_id:user,name,description,source,files_json:JSON.stringify(clean),created_at:existingCreatedAt??now,updated_at:now};
}
export function skillFile(skill:SkillRow,file='SKILL.md'):string|undefined {
 if(!FILE.test(file))return;
 try {return (JSON.parse(skill.files_json) as SkillFile[]).find(x=>x.path===file)?.contents} catch{return}
}
export function fileNames(skill:SkillRow):string[] {
 try{return (JSON.parse(skill.files_json) as SkillFile[]).map(x=>x.path)}catch{return []}
}
/** skills.sh /api/v1 requires a Vercel OIDC bearer token per their API documentation.
 * No tokens or untrusted request URLs are logged. Direct imports work without a token.
 */
export class SkillsCatalog {
 private cache=new Map<string,{at:number,data:unknown}>();
 constructor(private readonly token=process.env.BRC_SKILLS_API_TOKEN??''){}
 get configured(){return !!this.token}
 private async query(path:string):Promise<unknown>{
   if(!this.token)throw Error('skills.sh API needs a Vercel OIDC bearer token. Set BRC_SKILLS_API_TOKEN or manually import SKILL.md.');
   const hit=this.cache.get(path);if(hit&&Date.now()-hit.at<60_000)return hit.data;
   const response=await fetch('https://skills.sh/api/v1/'+path,{
     headers:{Authorization:'Bearer '+this.token,Accept:'application/json'},signal:AbortSignal.timeout(6500),redirect:'error'
   });
   if(!response.ok)throw Error('skills.sh catalog HTTP '+response.status);
   const length=Number(response.headers.get('content-length')??0);
   if(length>512*1024)throw Error('skills.sh response too large');
   const text=await response.text();if(Buffer.byteLength(text)>512*1024)throw Error('skills.sh response too large');
   const data=JSON.parse(text) as unknown;
   this.cache.set(path,{at:Date.now(),data});while(this.cache.size>24)this.cache.delete(this.cache.keys().next().value!);
   return data;
 }
 async search(q:string):Promise<CatalogSkill[]>{
   if(q.length<2||q.length>100)throw Error('Search needs 2-100 characters');
   const res=await this.query('skills/search?q='+encodeURIComponent(q)+'&limit=20') as {data?:unknown[]};
   if(!Array.isArray(res?.data))throw Error('Unexpected skills.sh response');
   return res.data.flatMap(row=>{
     if(!row||typeof row!=='object')return [];
     const d=row as Record<string,unknown>;
     if(!validSkillId(d.id))return [];
     return [{id:d.id,name:String(d.name??d.id).slice(0,100),source:String(d.source??'').slice(0,200),
       installs:typeof d.installs==='number'?d.installs:0,url:'https://skills.sh/'+d.id}];
   });
 }
 async detail(id:string,userId:string):Promise<SkillRow>{
   if(!validSkillId(id))throw Error('Invalid skills.sh ID');
   const detail=await this.query('skills/'+id.split('/').map(encodeURIComponent).join('/')) as Record<string,unknown>;
   if(!Array.isArray(detail.files))throw Error('Skill contents are unavailable from skills.sh');
   const primary=detail.files.find((x:unknown)=>!!x&&typeof x==='object'&&(x as SkillFile).path==='SKILL.md') as SkillFile|undefined;
   const name=typeof detail.slug==='string'?detail.slug:id.split('/').at(-1)!;
   const desc=primary?.contents.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g,'')??'Imported from skills.sh';
   return validateSkill({id,name,description:desc.slice(0,600),source:'https://skills.sh/'+id,files:detail.files},userId);
 }
}
