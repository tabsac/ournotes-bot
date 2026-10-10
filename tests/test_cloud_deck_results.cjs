const assert=require('node:assert/strict');
const {selectCloudDeck}=require('../lib/cloud_deck_results.cjs');
const row=method=>({method,member_ids:[1,2,3,4,5],snap_ids:[1,2,3,4,5],score:{method}});
const section=(goal,method)=>({goal,entries:(goal==='activity'?['cp','event_pt','shop_pt']:['score']).map(metric=>({metric,method,rows:[row(method)]}))});
const result=(id,sections,extra={})=>({id,kind:'deck-batch',payload:{kind:'deck-batch',schema_version:1,computedAt:`2026-10-${id}T12:00:00Z`,display:{members:[],snaps:[],songs:[]},options:{methods:['ap','skip']},sections,...extra}});
const data={account:{id:'test'},results:[result('11',[section('fire','ap')]),result('10',[section('activity','ap'),section('activity','skip')])]};
for(const method of ['ap','skip']){
 const match=selectCloudDeck(data,{goal:'activity',method});assert.equal(match.resultId,'10');assert.equal(match.batch.sections.length,1);
 assert.equal(match.batch.sections[0].entries.length,3);assert(match.batch.sections[0].entries.every(e=>e.method===method));
}
assert.equal(data.results[1].payload.sections.length,2,'Does not mutate saved result');
assert.equal(selectCloudDeck(data,{goal:'gekiso',method:'ap'}),null);
assert.equal(selectCloudDeck({results:[result('10',[section('activity','skip')])]},{goal:'activity',method:'ap'}),null);
assert.equal(selectCloudDeck({results:[result('10',[{goal:'activity',entries:[{metric:'cp',method:'ap',rows:[row('ap')]}]}])]},{goal:'activity',method:'ap'}),null,'Partial CP-only result cannot masquerade as complete activity');
const users={results:[result('11',[section('activity','ap')],{gameUid:'222'}),result('10',[section('activity','ap')],{gameUid:'111'})]};
assert.equal(selectCloudDeck(users,{goal:'activity',method:'ap',profileId:'111'}).profileId,'111');
assert.equal(selectCloudDeck(users,{goal:'activity',method:'ap',profileId:'333'}),null);
assert.equal(selectCloudDeck({results:[result('10',[section('daily','ap')],{options:{song:'100001',methods:['ap']}})]},{goal:'daily',method:'ap'}),null,'Song-specific result cannot answer average command');
assert(selectCloudDeck({results:[result('10',[section('daily','ap')],{options:{song:'',methods:['ap']}})]},{goal:'daily',method:'ap'}));
assert.equal(selectCloudDeck({results:[result('10',[section('activity','ap')],{schema_version:2})]},{goal:'activity',method:'ap'}),null);
for(const goal of ['leaderboard','gekiso','daily','fire'])assert(selectCloudDeck({results:[result('10',[section(goal,'skip')])]},{goal,method:'skip'}));
console.log('PASS saved batches: goals, AP/Skip, all three activity metrics, account UID, chronological fallback, song/average separation, immutable filtering');
