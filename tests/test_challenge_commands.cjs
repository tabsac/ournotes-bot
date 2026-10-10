const assert=require('node:assert/strict');const {selectCloudDeck}=require('../lib/cloud_deck_results.cjs');
const row=(id,score)=>({song_id:id,score,method:'ap',member_ids:[1,2,3,4,5],snap_ids:[1,2,3,4,5]});
const payload={kind:'deck-batch',schema_version:1,options:{growthMode:'full-training',methods:['ap']},display:{members:[],snaps:[],songs:[]},sections:[{goal:'leaderboard',entries:[{method:'ap',rows:[row(1,10),row(1,20),row(2,30),row(3,40)]}]},{goal:'challenge',entries:['event_pt','shop_pt'].map(metric=>({metric,method:'ap',rows:[row(1,10)]}))}]};const data={results:[{kind:'deck-batch',payload}]};
assert.equal(selectCloudDeck(data,{goal:'challenge',method:'ap',growthMode:'current-max'}),null);
const found=selectCloudDeck(data,{goal:'leaderboard',method:'ap',growthMode:'full-training'});assert.equal(found.batch.sections[0].entries[0].rows.length,3);assert.equal(found.batch.sections[0].entries[0].rows.find(r=>r.song_id===1).score,20);assert.equal(payload.sections[0].entries[0].rows.length,4);
let messages=[];const commands=[];require('../on_commands.js')({commands,CONFIG:{},sendReply:(_w,_a,b)=>messages.push(b.message),imageCqFromPath:x=>x});
for(const text of ['/on挑战演出','/on挑战演出 skip 满特训','/on活动歌榜','/on歌榜组卡'])assert(commands.some(c=>c.match(text)),text);
for(const name of ['挑战演出','活动歌榜']){const text='/onhelp '+name,c=commands.find(c=>c.match(text));assert(c);c.execute({}, {message_type:'private',sender:{user_id:1}},c.match(text));assert(messages.at(-1).includes('用法：/on'+name));}
console.log('PASS challenge/song-board routes and help; full-training isolation; per-song best selection; saved data immutable');
