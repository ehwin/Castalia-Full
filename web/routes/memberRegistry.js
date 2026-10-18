import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
export const registryPath = (dbDir) => process.env.GRAPH_MEMBERS_FILE || join(dirname(dbDir), 'federation-viz.json');
const key = p => realpathSync(p).replace(/\\/g, '/').toLowerCase();
export function readRegistry(dbDir) {
  const file = registryPath(dbDir);
  if (!existsSync(file)) return [];
  const items = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(items) || items.some(x => !x || typeof x.id !== 'string' || !x.id.trim() || typeof x.name !== 'string' || !x.name.trim() || x.name.length > 64 || /[\u0000-\u001f<>]/.test(x.name) || typeof x.dir !== 'string' || !isAbsolute(x.dir))) throw new Error('成员注册文件格式错误，拒绝覆盖');
  return items;
}
export function scanMember(dir) {
  if (!isAbsolute(dir) || !existsSync(dir) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('必须提供已有的绝对记忆根目录，不能是符号链接');
  const root = realpathSync(dir), files = [];
  for (const entry of readdirSync(root)) {
    if (/^(?:backup|archive|tmp|test|_bak)(?:[-_.]|$)/i.test(entry)) continue;
    const p = join(root, entry), st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isFile() && /^project-.+\.sqlite$/.test(entry)) files.push({ file: p, project: entry.slice(8, -7), memType: 'general' });
    if (!st.isDirectory()) continue;
    for (const mt of readdirSync(p)) {
      const sp = join(p, mt), ss = lstatSync(sp);
      if (ss.isSymbolicLink()) continue;
      const file = ss.isDirectory() ? join(sp, 'memory.sqlite') : (/\.sqlite$/.test(mt) ? sp : null);
      if (file && existsSync(file) && !lstatSync(file).isSymbolicLink()) files.push({file,project:entry,memType:ss.isDirectory()?mt:'general'});
    }
  }
  let active = 0; const valid = [], errors = [];
  for (const item of files) {
    let db;
    try {
      db = new Database(item.file, {readonly:true,fileMustExist:true});
      const cols = new Set(db.prepare('PRAGMA table_info(memory)').all().map(c=>c.name));
      if (!['id','text','is_active','project','mem_type','category','created_at'].every(c=>cols.has(c))) throw new Error('不兼容的 memory schema');
      active += Number(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE is_active=1').get().n);
      valid.push(item);
    } catch(e) { errors.push(`${item.project}/${item.memType}: ${e.message}`); }
    finally { db?.close(); }
  }
  return {dir:root, files:valid, libraries:valid.length, projects:new Set(valid.map(x=>x.project)).size, active, errors};
}
export function mergedMembers(base, dbDir) {
  const out = [], dirs = new Set(), names = new Set();
  for(const m of [...base.map(x=>({...x,registered:false})),...readRegistry(dbDir).filter(x=>x.enabled!==false).map(x=>({...x,registered:true}))]) {
    if (!m.dir) continue;
    let k; try{k=key(m.dir);}catch{k=m.dir.toLowerCase();}
    if(dirs.has(k))continue;
    if(names.has(m.name))continue;
    dirs.add(k);names.add(m.name);out.push(m);
  }
  return out;
}
function save(dbDir, items) {
  const file=registryPath(dbDir), temp=file+'.'+randomUUID()+'.tmp';
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(temp,JSON.stringify(items,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  renameSync(temp,file);
}
export function registerMember(base,dbDir,body) {
  const name=String(body?.name||'').trim(), dir=String(body?.dir||'').trim();
  if(!name||name.length>64||/[\u0000-\u001f<>]/.test(name))throw new Error('名称需为1–64个可显示字符');
  const info=scanMember(dir);
  if(!info.libraries)throw new Error('未找到兼容的记忆数据库');
  const members=mergedMembers(base,dbDir);
  if(members.some(m=>m.name===name))throw new Error('成员名称已存在');
  if(members.some(m=>{try{return key(m.dir)===key(info.dir);}catch{return false;}}))throw new Error('该目录已接入');
  const items=readRegistry(dbDir), item={id:randomUUID(),name,dir:info.dir,enabled:true};
  items.push(item);save(dbDir,items);return item;
}
export function removeMember(dbDir,id) {
  const items=readRegistry(dbDir), next=items.filter(x=>x.id!==id);
  if(next.length===items.length)throw new Error('未找到可移除的注册成员，环境配置成员不能在此移除');
  save(dbDir,next);
}
