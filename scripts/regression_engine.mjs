// Run against a built variant. All writes go to isolated temporary databases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const variant = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-regression-'));
Object.assign(process.env, { MEMORY_DB_DIR: temp, EMBED_MODE: 'none', CASTALIA_PROJECT: 'regression',
  TRIAGE_LLM_API_KEY: 'fixture-only', TRIAGE_LLM_URL: 'https://fixture.invalid/v1' });
delete process.env.MEMORY_DB_PATH;
globalThis.fetch = async () => new Response(JSON.stringify({choices:[{message:{content:'{"memType":"user"}'}}]}),
  {status:200,headers:{'Content-Type':'application/json'}});
const load = name => import(pathToFileURL(path.join(variant, 'dist', name)).href);
const {saveMemory, findDbByMemoryId} = await load('store.js');
const {applyReflectActions} = await load('reflect.js');
const {DatabaseManager} = await load('db.js');
const project = 'regression';
const row = id => findDbByMemoryId(id, project)?.db.prepare('SELECT * FROM memory WHERE id = ?').get(id);
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const act = async action => {
  const result = await applyReflectActions([action], 'fixture', project);
  check(result.receipts.length === 1, 'exactly one receipt per action');
  return result;
};
try {
  const classified = await saveMemory({text:'prefers concise answers', autoClassify:true, project,
    ...(variant.endsWith('Castalia-Anima') ? {memType:'user'} : {})});
  check(classified.memType === 'user' && findDbByMemoryId(classified.id,project).memType === 'user', 'classification routes actual DB');
  const a = await saveMemory({text:'source alpha', project, tags:['old'], importance:0.4, emotionalImpact:8});
  const dup = await saveMemory({text:'source alpha', project, tags:['incoming'], importance:0.9});
  check(dup.id === a.id && dup.importance === 0.4 && dup.tags[0] === 'old', 'duplicate returns stored metadata');
  const b = await saveMemory({text:'source beta',project});
  let result = await act({action:'merge',sourceIds:[a.id,'missing'],newText:'invalid merge'});
  check(result.applied === 0 && row(a.id).is_active === 1, 'missing source preserves valid source');
  result = await act({action:'merge',sourceIds:[a.id,a.id],newText:'duplicate sources'});
  check(result.applied === 0 && row(a.id).is_active === 1, 'duplicate sources rejected');
  result = await act({action:'delete',targetId:'%'});
  check(result.applied === 0 && row(a.id).is_active === 1, 'wildcard ID rejected');
  const db = findDbByMemoryId(a.id,project).db;
  db.prepare('UPDATE memory SET id = ? WHERE id = ?').run('ambiguous-one',a.id);
  db.prepare('UPDATE memory SET id = ? WHERE id = ?').run('ambiguous-two',b.id);
  a.id='ambiguous-one'; b.id='ambiguous-two';
  result = await act({action:'delete',targetId:'ambiguous'});
  check(result.applied === 0 && row(a.id).is_active === 1, 'ambiguous prefix rejected');
  result = await act({action:'split',targetId:a.id,fragments:[{text:'valid fragment'},{text:' '}]});
  check(result.applied === 0 && row(a.id).is_active === 1, 'invalid split preserves source');
  db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON memory WHEN NEW.source IN ('reflect_merge','reflect_split') BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  result = await act({action:'merge',sourceIds:[a.id,b.id],newText:'will fail'});
  check(result.applied === 0 && row(a.id).is_active === 1 && row(b.id).is_active === 1, 'failed save preserves merge sources');
  result = await act({action:'split',targetId:a.id,fragments:[{text:'will fail'}]});
  check(result.applied === 0 && row(a.id).is_active === 1, 'failed split save preserves source');
  db.exec('DROP TRIGGER fixture_fail');
  if (!variant.endsWith('Castalia-Anima')) {
    const locked = await saveMemory({text:'locked identity',project, identityLocked:true});
    result = await act({action:'delete',targetId:locked.id});
    check(result.applied === 0 && row(locked.id).is_active === 1, 'identity lock blocks reflection deletion');
    result = await act({action:'merge',sourceIds:[a.id,locked.id],newText:'must reject'});
    check(result.applied === 0 && row(a.id).is_active === 1, 'locked merge preserves valid source');
  }
  result = await act({action:'relate',sourceId:a.id,targetIdRelate:'missing',relationType:'related_to'});
  check(result.applied === 0, 'relate validates both endpoints');
  result = await act({action:'merge',sourceIds:[a.id,b.id],newText:a.text});
  check(result.applied === 1 && row(a.id).is_active === 1 && row(b.id).is_active === 0, 'dedup merge keeps output active');
  if (variant.endsWith('Castalia-Anima')) db.prepare('UPDATE memory SET vad_valence = 0.8, agent_mood = ? WHERE id = ?').run('happy',a.id);
  result = await act({action:'reclassify',targetId:a.id,newMemType:'user'});
  check(result.applied === 1 && findDbByMemoryId(a.id,project).memType === 'user', 'reclassify moves actual database: '+JSON.stringify(result));
  if (variant.endsWith('Castalia-Anima')) check(row(a.id).emotional_impact === 8 && row(a.id).vad_valence === 0.8 && row(a.id).agent_mood === 'happy', 'Anima migration retains emotion');
  console.log(JSON.stringify({variant, checks, ok:true}));
} finally {
  DatabaseManager.close(); fs.rmSync(temp, {recursive:true,force:true});
}
