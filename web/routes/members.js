import { Router } from 'express';
import { DB_DIR, getAggregateDirs } from './lib.js';
import { readRegistry, registerMember, removeMember, scanMember } from './memberRegistry.js';
const router = Router();
function configured() { const items=readRegistry(DB_DIR); return getAggregateDirs().filter(x=>!items.some(m=>m.name===x.name&&m.dir===x.dir)); }
function localMutation(req) {
  const addr=req.socket?.remoteAddress || '';
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(addr))throw new Error('仅允许本机管理');
  const host=req.get('host') || '';
  if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))throw new Error('无效的本机 Host');
  const origin=req.get('origin');
  if(origin && new URL(origin).origin !== `${req.protocol || 'http'}://${host}`)throw new Error('拒绝跨站成员写入');
  if(req.get('sec-fetch-site')==='cross-site')throw new Error('拒绝跨站成员写入');
}
function info(item,registered) {
  const common={...item,id:item.id||'configured:'+item.name,registered,readOnly:!registered,graphUrl:'/?scope=federation&instance='+encodeURIComponent(item.name)};
  try { const s=scanMember(item.dir); return {...common,libraries:s.libraries,active:s.active,projects:s.projects,status:s.libraries?'ready':'empty',error:s.errors.join('; ')}; }
  catch(e) { return {...common,status:'unavailable',libraries:0,active:0,projects:0,error:e.message}; }
}
router.get('/members', (_req,res)=>{ try{const registered=readRegistry(DB_DIR).filter(x=>x.enabled!==false);res.setHeader('Cache-Control','no-store');res.json({ok:true,members:[...configured().map(x=>info(x,false)),...registered.map(x=>info(x,true))]});}catch(e){res.status(500).json({ok:false,error:e.message});} });
router.post('/members', (req,res)=>{ try { localMutation(req);const item=registerMember(configured(),DB_DIR,req.body);res.json({ok:true,member:info(item,true),restartRequired:false}); } catch(e){res.status(400).json({ok:false,error:e.message});} });
router.delete('/members/:id',(req,res)=>{try{localMutation(req);removeMember(DB_DIR,req.params.id);res.json({ok:true,restartRequired:false});}catch(e){res.status(400).json({ok:false,error:e.message});}});
export default router;
