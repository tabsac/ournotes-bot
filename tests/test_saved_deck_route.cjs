const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'on-cloud-deck-test-')),on=path.join(temp,'on');fs.mkdirSync(on);process.env.ON_DIR=on;
fs.mkdirSync(path.join(temp,'api'));fs.writeFileSync(path.join(temp,'api/api.env'),'ON_BOT_SECRET=synthetic\n');
const base={kind:'deck-batch',schema_version:1,computedAt:'2026-10-11T00:00:00Z',display:{members:[],snaps:[],songs:[]},options:{methods:['ap','skip']}};
const original={goal:'activity',entries:['cp','event_pt','shop_pt'].map(metric=>({metric,method:'skip',rows:[{member_ids:[1,2,3,4,5],snap_ids:[1,2,3,4,5],score:{method:'skip'}}]}))};
base.sections=[...['ap','skip'].map(method=>({...original,entries:original.entries.map(e=>({...e,method,rows:e.rows.map(r=>({...r,method,score:{...r.score,method}}))}))})),{goal:'fire',entries:original.entries}];
let state='saved',requests=[],messages=[],rendered=[];
const http=require('node:http');http.request=(options,callback)=>{const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{requests.push(options.path);assert(!options.path.includes('deck-jobs'),'No server recomputation for non-song command');const res=new EventEmitter();res.statusCode=200;callback(res);const reply=state==='unbound'?{account:null,results:[]}:{account:{id:'synthetic'},results:state==='saved'?[{id:'saved',kind:'deck-batch',payload:base}]:[]};res.emit('data',Buffer.from(JSON.stringify(reply)));res.emit('end');});return req;};
require('node:child_process').spawn=(_exe,args)=>{const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
 queueMicrotask(()=>{const input=args[args.indexOf('--in')+1],output=args[args.indexOf('--out')+1];assert(input&&output);rendered.push(JSON.parse(fs.readFileSync(input,'utf8')));fs.writeFileSync(output,Buffer.alloc(24));fs.writeFileSync(output+'.pages.json',JSON.stringify([output]));child.emit('close',0);});return child;};
const commands=[];require(process.argv[2]||path.resolve(__dirname,'../on_commands.js'))({commands,CONFIG:{},imageCqFromPath:file=>({image:file}),sendReply:(_ws,_action,body)=>messages.push(body.message)});
const msg={message_type:'private',user_id:123,sender:{user_id:123}};
async function run(text){const before=messages.length,c=commands.find(c=>c.match(text));assert(c);c.execute({},msg,c.match(text));for(let i=0;i<100&&messages.length===before;i++)await new Promise(r=>setTimeout(r,10));return messages.slice(before);}
(async()=>{
 for(const method of ['ap','skip']){const replies=await run('/on活动组卡'+(method==='skip'?' skip':''));assert(replies.some(r=>r.image));const batch=rendered.at(-1);assert(batch.sections.every(s=>s.goal==='activity'));assert.equal(batch.sections[0].entries.length,3);assert(batch.sections.flatMap(s=>s.entries).every(e=>e.method===method));}
 state='missing';assert((await run('/on活动组卡')).some(s=>String(s).includes('尚无匹配')));
 state='unbound';assert((await run('/on活动组卡')).some(s=>String(s).includes('绑定当前 QQ')));
 assert.equal(requests.length,4);assert.equal(rendered.length,2);console.log('PASS actual command route: stored result renders CP/PT/badges, AP/Skip separated, no server job, missing/unbound fallback, no QQ sent');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{const target=path.resolve(temp);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('on-cloud-deck-test-'));fs.rmSync(target,{recursive:true,force:true});});
