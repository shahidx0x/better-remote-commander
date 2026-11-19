import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commandEnvironment,commandEnvironmentPolicy} from '../dist/runtime/command-environment.js';
import {managedTerminationState} from '../dist/runtime/process-termination.js';

test('compatibility preserves legacy Node project flags while removing test harness environment',()=>{
  const inherited={PATH:'bin',PATHEXT:'.EXE;.CMD',MONGODB_URI:'mongodb://example/db',
    BRC_RELAY_TOKEN:'relay-private',OPENAI_API_KEY:'sk-do-not-copy',NODE_OPTIONS:'--inspect',
    NODE_TEST_CONTEXT:'test',NODE_TEST_REPORTER:'json'};
  const result=commandEnvironment(inherited,{},'compat');
  assert.equal(result.MONGODB_URI,'mongodb://example/db');
  assert.equal(result.BRC_RELAY_TOKEN,'relay-private');
  assert.equal(result.NODE_OPTIONS,'--inspect');
  for(const name of ['NODE_TEST_CONTEXT','NODE_TEST_REPORTER'])
    assert.equal(result[name],undefined);
});

test('isolated environment only inherits OS essentials, strips ambient service credentials',()=>{
 const inherited={PATH:'tools',PATHEXT:'.EXE;.CMD',SystemRoot:'C:\\Windows',USERPROFILE:'C:\\Users\\Fixture',
  BRC_RELAY_TOKEN:'private',OPENAI_API_KEY:'secret',ANTHROPIC_API_KEY:'private',
  AWS_SECRET_ACCESS_KEY:'private',GH_TOKEN:'private',MONGODB_URI:'mongodb://fixture/db',
  NODE_OPTIONS:'--inspect',NODE_TEST_CONTEXT:'test'};
 const isolated=commandEnvironment(inherited,{},'isolated','');
 assert.equal(isolated.PATH,'tools');
 assert.equal(isolated.PATHEXT,'.EXE;.CMD');
 assert.equal(isolated.SystemRoot,'C:\\Windows');
 assert.equal(isolated.BRC_RELAY_TOKEN,undefined);
 assert.equal(isolated.OPENAI_API_KEY,undefined);
 assert.equal(isolated.MONGODB_URI,undefined);
 assert.equal(isolated.NODE_OPTIONS,undefined);
 assert.deepEqual(Object.keys(isolated).sort(),['PATH','PATHEXT','SystemRoot','USERPROFILE'].sort());
});

test('operator-approved names and explicit toolchain env are available in isolated mode',()=>{
 const inherited={PATH:'tools',MONGODB_URI:'mongodb://fixture/db',BRC_RELAY_TOKEN:'private',
  NODE_OPTIONS:'--inspect',NEXT_PUBLIC_SITE_NAME:'Demo'};
 const isolated=commandEnvironment(inherited,
   {DOTNET_NOLOGO:'1',COREPACK_ENABLE_NETWORK:'0',NODE_OPTIONS:'--unsafe'},
   'isolated','MONGODB_URI,NEXT_PUBLIC_SITE_NAME, NODE_OPTIONS, bad-name!');
 assert.equal(isolated.MONGODB_URI,inherited.MONGODB_URI);
 assert.equal(isolated.NEXT_PUBLIC_SITE_NAME,'Demo');
 assert.equal(isolated.DOTNET_NOLOGO,'1');
 assert.equal(isolated.COREPACK_ENABLE_NETWORK,'0');
 assert.equal(isolated.BRC_RELAY_TOKEN,undefined);
 assert.equal(isolated.NODE_OPTIONS,undefined);
 assert.equal(isolated['bad-name!'],undefined);
});

test('isolated is the default; explicit compatibility escape remains available',()=>{
 assert.equal(commandEnvironmentPolicy('isolated'),'isolated');
 assert.equal(commandEnvironmentPolicy('compat'),'compat');
 assert.equal(commandEnvironmentPolicy(undefined),'isolated');
});

test('termination status never equates request with confirmed process tree exit',()=>{
 assert.equal(managedTerminationState(false,false),'not_requested');
 assert.equal(managedTerminationState(false,true),'not_requested');
 assert.equal(managedTerminationState(true,false),'unconfirmed');
 assert.equal(managedTerminationState(true,true),'root_exit_observed');
});
