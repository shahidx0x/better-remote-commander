import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 layout,loginPage,consentPage,deviceVerifyPage,deviceApprovePage,
 messagePage,homePage,clientsPage,oauthClientRecoveryPage
} from '../dist/pages/html.js';
import {apiKeysPage,connectionLinksPage} from '../dist/pages/admin.js';
import {skillsPage} from '../dist/pages/skills.js';
import {marketplacePage,installPage,installResultPage} from '../dist/pages/plugins.js';

const contains=(html,parts)=>{for(const part of parts)assert.ok(html.includes(part),'Missing '+part)};
const noInjection=html=>{assert.ok(!html.includes('<img src=x onerror=alert(1)>'))};
test('public sign-in and errors share polished auth shell and secure form fields',()=>{
 const html=loginPage('/admin?period=month','Invalid <img src=x onerror=alert(1)>');
 contains(html,['class="auth-root"','class="auth-story"','class="auth-main"',
   '--brand:#087e79','name="username"','name="password"','type="password"',
   'autocomplete="current-password"','name="returnTo" value="/admin?period=month"',
   'action="/auth/login"','Show password','role="alert"']);
 noInjection(html);
 assert.match(html,/Invalid &lt;img/);
 const failed=messagePage('Forbidden','Invalid permission',false);
 contains(failed,['class="auth-root"','Forbidden','Go to dashboard','role="status"']);
 const success=messagePage('Approved','Device connected');
 contains(success,['class="auth-root"','Device connected']);
});
test('signed-in root uses complete admin workspace, public root uses auth landing',()=>{
 const devices=[{device_id:'id-123',name:'Development <img src=x onerror=alert(1)>',platform:'Windows',
    online:true,paused:0},{device_id:'id-456',name:'Server',platform:'Linux',online:false,paused:0}];
 const logged=homePage('https://relay.example.test',true,devices);
 contains(logged,['<aside class="sidebar">','<main class="content">','Welcome to your workspace.',
   'Paired devices','href="/admin#devices"','href="/admin/marketplace"','href="/auth/links"']);
 assert.match(logged,/Available devices/);
 assert.match(logged,/Development &lt;img/);
 noInjection(logged);
 const guest=homePage('https://relay.example.test',false,[]);
 contains(guest,['class="auth-root"','Sign in to dashboard','/auth/login?returnTo=%2Fadmin']);
 assert.doesNotMatch(guest,/<aside class="sidebar">/);
});
test('OAuth and device pairing keep trust gates, required names and decisions',()=>{
 const approval=consentPage('pending-abc','Bad <img src=x onerror=alert(1)>','https://app.example/callback',['mcp:tools']);
 contains(approval,['class="auth-root"','name="pending" value="pending-abc"',
   'name="decision" value="deny"','name="decision" value="allow"','mcp:tools']);
 noInjection(approval);
 const verify=deviceVerifyPage('ABCD-1234','Expired code');
 contains(verify,['class="sidebar"','action="/device/verify"','name="user_code" value="ABCD-1234"',
  'maxlength="9"','Expired code']);
 const approved=deviceApprovePage('ABCD-1234','Desktop');
 contains(approved,['action="/device/approve"','name="decision" value="deny"',
   'name="decision" value="allow"','ABCD-1234']);
 const recovery=oauthClientRecoveryPage('cl-test','https://callback.example','/auth/clients?retry=1',true);
 contains(recovery,['class="auth-root"','href="/auth/clients?retry=1"','callback']);
});
test('OAuth client management preserves both registration flows and revocation',()=>{
 const html=clientsPage([{client_id:'cl001',name:'My client',redirect_uris:['https://example/callback'],
   hasSecret:false,created_at:Date.now()}],'csrf-123',{
   authorizeUrl:'https://relay.example/authorize?x=1&y=2',clientId:'cl001',redirectUri:'https://example/callback'
 });
 contains(html,['class="sidebar"','class="admin-register-grid"','name="authorization_url"',
   'name="client_id"','name="redirect_uri"','name="client_name"',
   'name="csrf" value="csrf-123"','name="trust" value="yes"',
   'action="/auth/clients/delete"','Public client','cl001','https://example/callback']);
 assert.match(html,/authorize\?x=1&amp;y=2/);
});
test('credential pages keep one-time secret output and revocation paths',()=>{
 const key='brc_ak_'+'x'.repeat(43);
 const keys=apiKeysPage([{prefix:'brc_ak_test',name:'Backend',created_at:Date.now(),
   last_used:Date.now()}],{name:'Backend',raw:key});
 contains(keys,['class="sidebar"','class="credential-secret"','id="new-api-key"',
   key,'name="prefix"','action="/auth/apikeys"','action="/auth/apikeys/revoke"']);
 const links=connectionLinksPage([{id:'connection1',name:'AI service',mode:'full',
   created_at:Date.now(),expires_at:Date.now()+86400000}],'my-csrf',
   {name:'AI',url:'https://relay.example/c/secret/mcp',expiresAt:Date.now()+86400000});
 contains(links,['class="sidebar"','id="new-connection-url"','name="csrf" value="my-csrf"',
   'name="mode"','name="days"','value="365"','value="730"',
   'action="/auth/links/revoke"','name="link_id" value="connection1"']);
});
test('skills, marketplace and plugin install/results all use full admin shell',()=>{
 const skills=skillsPage({skills:[],requests:[],results:[],configured:false,csrf:'csrf',q:''});
 contains(skills,['class="sidebar"','Skill library','name="markdown"','name="trust"']);
 const market=marketplacePage({q:'',entries:[],registrySource:'official',devices:[],csrf:'csrf'});
 contains(market,['class="sidebar"','MCP INTEGRATIONS','action="/admin/marketplace"',
   'name="custom_type"','name="custom_spec"','action="/admin/plugins/install"']);
 const install=installPage({csrf:'csrf',devices:[],custom:{type:'npm',spec:'valid-pkg@1.0.0'}});
 contains(install,['class="sidebar"','class="panel panel-form"','name="source" value="custom"',
   'name="custom_spec"','name="plugin_id"']);
 const outcome=installResultPage('Done',[{device:'PC',ok:true,message:'Installed'}]);
 contains(outcome,['class="sidebar"','INSTALLATION RESULTS','Installed']);
});
