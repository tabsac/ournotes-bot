const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ournotes-command-smoke-'));
process.env.ON_DIR=root;
const commands=[],replies=[];
const http=require('node:http'),https=require('node:https');let requests=0;
http.request=https.request=()=>{requests++;throw Error('Network disabled in command smoke test');};
require('../on_commands.js')({commands,CONFIG:{},imageCqFromPath:p=>p,sendReply:(_ws,_action,body)=>replies.push(body.message)});
function command(text){return commands.find(c=>c.match(text));}
(async()=>{
 for(const name of ['表情','贴纸','个人信息','b25','歌榜组卡','活动组卡','激奏组卡','自由组卡','日常组卡','清火组卡'])assert(command('/on'+name),name+' registered');
 for(const text of ['/arkdle','/ark关卡','/q弹','/弹跳'])assert.equal(command(text),undefined,'Unrelated command excluded: '+text);
 for(const name of ['歌榜组卡','活动组卡','激奏组卡','自由组卡','日常组卡','清火组卡']){
  const text='/on'+name,c=command(text),start=replies.length;
  c.execute({}, {message_type:'private',user_id:123456,sender:{user_id:123456}},c.match(text));
  await new Promise(resolve=>setImmediate(resolve));
  assert(replies.slice(start).some(s=>String(s).includes('https://on.tabsac.com/#plan')),name+' returns webpage');
 }
 assert.equal(requests,0,'Average commands must not submit server jobs');
 console.log('PASS ON commands registered, unrelated commands absent, six non-song routes link webpage, no network or QQ messages');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
 const temp=path.resolve(os.tmpdir()),target=path.resolve(root);assert(target.startsWith(temp+path.sep)&&path.basename(target).startsWith('ournotes-command-smoke-'));fs.rmSync(target,{recursive:true,force:true});
});
