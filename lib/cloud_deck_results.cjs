'use strict';
const validUid=value=>typeof value==='number'&&!Number.isSafeInteger(value)?'':/^\d{1,30}$/.test(String(value||''))?String(value):'';
function resultUid(payload){const imported=payload?.actual_inputs?.account_import||payload?.document?.account_import||payload?.profile?.account_import||{};return validUid(payload?.gameUid||imported.account_id_text||imported.account_id);}
function time(value){if(typeof value==='number')return value<1e12?value*1000:value;return Date.parse(value||'')||0;}
/** Read only results belonging to the already authenticated QQ's web account. */
function selectCloudDeck(data,{goal,method,profileId='',growthMode}){
  const rows=(data?.results||[]).filter(row=>row.kind==='deck-batch'||row.payload?.kind==='deck-batch');
  rows.sort((a,b)=>time(b.payload?.computedAt)-time(a.payload?.computedAt)||time(b.updatedAt)-time(a.updatedAt));
  const preferred=validUid(profileId);
  for(const record of rows){
    const payload=record.payload;if(payload?.kind!=='deck-batch'||payload.schema_version!==1||!Array.isArray(payload.sections)||!payload.display)continue;
    if(growthMode&&(payload.options?.growthMode||'current-max')!==growthMode)continue;
    const uid=resultUid(payload);if(preferred&&uid&&uid!==preferred)continue;
    if(preferred&&!uid&&rows.some(r=>resultUid(r.payload)))continue;
    if(['daily','gekiso'].includes(goal)&&payload.options?.song&&payload.options.song!=='平均')continue;
    const fallback=payload.options?.methods?.length===1?payload.options.methods[0]:'';
    const sections=[];
    for(const section of payload.sections.filter(s=>s.goal===goal)){
      const entries=[];
      for(const entry of section.entries||[{rows:section.rows,method:section.method}]){
        const entryMethod=entry.method||section.method||fallback;
        const selected=(entry.rows||[]).filter(row=>(entryMethod||row.method||row.score?.method)===method&&
          row.member_ids?.length===5&&row.snap_ids?.length===5);
        if(selected.length){let chosen=selected;if(goal==='leaderboard'){const best=new Map();for(const row of selected){const value=Number(row.target_value??row.score);if(!best.has(row.song_id)||value>Number(best.get(row.song_id).target_value??best.get(row.song_id).score))best.set(row.song_id,row);}chosen=[...best.values()].sort((a,b)=>Number(b.target_value??b.score)-Number(a.target_value??a.score));}entries.push({...entry,method,rows:chosen});}
      }
      if(entries.length)sections.push({...section,method,entries});
    }
    if(!sections.length)continue;
    if(['activity','challenge'].includes(goal)){
      const metrics=new Set(sections.flatMap(s=>s.entries.map(e=>e.metric)));
      if(!(goal==='activity'?['cp','event_pt','shop_pt']:['event_pt','shop_pt']).every(metric=>metrics.has(metric)))continue;
    }
    return {batch:{...payload,sections,options:{...payload.options,goals:[goal],methods:[method]}},
      profileId:uid||preferred,resultId:record.id};
  }
  return null;
}
module.exports={selectCloudDeck,resultUid};
