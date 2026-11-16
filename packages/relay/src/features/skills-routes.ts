/** Authenticated, CSRF-protected skill management. No code execution. */
import type {Express,Request,Response,NextFunction} from 'express';
import type {RelayStore} from '../store/types.js';
import type {Sessions} from '../auth/sessions.js';
import {SkillsCatalog,validateSkill,validSkillId} from './skills.js';
import {skillsPage} from '../pages/skills.js';
const form=(req:Request,key:string)=>{const v=(req.body as Record<string,unknown>|undefined)?.[key];return typeof v==='string'?v:''};
export function registerSkillsRoutes(app:Express,store:RelayStore,sessions:Sessions,catalog:SkillsCatalog,
  requireLogin:(req:Request,res:Response,next:NextFunction)=>void){
 const user=(req:Request)=>sessions.userId(req)!;
 const csrf=(req:Request,res:Response,next:NextFunction)=>{
   if(req.get('sec-fetch-site')==='cross-site'||!sessions.checkCsrf(req,form(req,'csrf')))
     return res.status(403).type('html').send('Forbidden: invalid CSRF token');
   next();
 };
 const render=async(req:Request,res:Response,status=200,error?:string)=>{
   const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,100):'';
   let results:Awaited<ReturnType<SkillsCatalog['search']>>=[];
   if(q.length>=2&&catalog.configured){
     try{results=await catalog.search(q)}catch(e){error=error??(e instanceof Error?e.message:'Search unavailable')}
   }else if(q.length>=2&&!catalog.configured){error=error??'skills.sh catalog search requires an OIDC token; use the link and manual import instead.'}
   const v={skills:await store.listSkills(user(req)),requests:await store.listSkillRequests(user(req)),results,
      configured:catalog.configured,csrf:sessions.csrfToken(req)!,q,error,
      notice:req.query.done==='imported'?'Skill is approved and ready for your MCP clients.':
        req.query.done==='removed'?'Skill removed.':
        req.query.done==='rejected'?'Request dismissed.':undefined};
   res.status(status).type('html').send(skillsPage(v));
 };
 app.get('/admin/skills',requireLogin,(req,res)=>{void render(req,res).catch(()=>res.status(500).send('Skill library unavailable'))});
 app.post('/admin/skills/import',requireLogin,csrf,async(req,res)=>{
   try{
     if(form(req,'trust')!=='yes')throw Error('You must explicitly review and approve skill instructions.');
     const id=form(req,'id').trim();
     if(!validSkillId(id))throw Error('Invalid skill ID');
     const prior=await store.getSkill(user(req),id);
     const action=form(req,'action');
     let row;
     if(action==='catalog'){
       row=await catalog.detail(id,user(req));
     }else if(action==='manual'){
       row=validateSkill({id,name:form(req,'name'),description:form(req,'description'),
         source:form(req,'source'),files:[{path:'SKILL.md',contents:form(req,'markdown')}]},user(req),prior?.created_at);
     }else throw Error('Invalid import action');
     if(prior)row.created_at=prior.created_at;
     await store.saveSkill(row);
     res.redirect(303,'/admin/skills?done=imported');
   }catch(e){await render(req,res,400,e instanceof Error?e.message:'Skill import failed')}
 });
 app.post('/admin/skills/delete',requireLogin,csrf,async(req,res)=>{
   const id=form(req,'id');if(validSkillId(id))await store.deleteSkill(user(req),id);
   res.redirect(303,'/admin/skills?done=removed');
 });
 app.post('/admin/skills/reject',requireLogin,csrf,async(req,res)=>{
   const id=form(req,'id');if(/^sr_[A-Za-z0-9_-]{8,40}$/.test(id))await store.deleteSkillRequest(user(req),id);
   res.redirect(303,'/admin/skills?done=rejected');
 });
}
