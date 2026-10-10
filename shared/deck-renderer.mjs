export function deckPages(batch){
 if(batch?.kind!=='deck-batch'||batch.schema_version!==1||!Array.isArray(batch.sections)||!batch.display)throw Error('组卡结果不完整。');
 const rows=[];
 for(const section of batch.sections){for(const entry of section.entries||[{rows:section.rows,method:section.method}]){
  const selected=['activity','fire','challenge'].includes(section.goal)?(entry.rows||[]).slice(0,1):(entry.rows||[]);
  for(const row of selected){if(row.member_ids?.length!==5||row.snap_ids?.length!==5)throw Error('队伍卡牌数量不正确。');rows.push({section,entry,row,alternatives:['activity','fire','challenge'].includes(section.goal)?(entry.rows||[]).slice(1):[]});if(row.challenge_team){rows.push({section,entry:{...entry,label:'对应挑战演出 · '+(entry.metric==='event_pt'?'活动 PT':'徽章')},row:row.challenge_team,alternatives:[]});}}
 }}
 if(!rows.length)throw Error('当前没有完成的组卡结果。');
 const pages=[];for(let i=0;i<rows.length;i+=6)pages.push(rows.slice(i,i+6));return pages;
}
export async function renderDeckBatch(batch,api,page=0){
 const pages=deckPages(batch);if(!pages[page])throw Error('没有这一页。');const rows=pages[page],W=1200,H=300+rows.length*560+160,c=api.createCanvas(W,H),x=c.getContext('2d');
 const cards=new Map(batch.display.members.map(v=>[v.id,v])),snaps=new Map(batch.display.snaps.map(v=>[v.id,v])),songs=new Map(batch.display.songs.map(v=>[v.id,v.title]));const inventory=batch.profile?.inventory||{members:[],snaps:[]};
 function text(t,px,py,size=22,color='#33435f',width=1090,bold=false){x.font=`${bold?'bold ':''}${size}px OurNotesB25`;x.fillStyle=color;t=String(t??'—');while(x.measureText(t).width>width&&t.length>1)t=t.slice(0,-2)+'…';x.fillText(t,px,py);}
 function box(y,h){x.fillStyle='#ffffff';x.beginPath();x.roundRect(32,y,W-64,h,18);x.fill();}
 async function image(src,px,py,w,h){const im=src&&await api.loadImage(src);if(im){const factor=Math.min(w/im.width,h/im.height),iw=im.width*factor,ih=im.height*factor;x.drawImage(im,px+(w-iw)/2,py+(h-ih)/2,iw,ih);}else{x.fillStyle='#e1e7f3';x.fillRect(px,py,w,h);}}
 const f=v=>Number(v??0).toLocaleString('zh-CN',{maximumFractionDigits:2});const gradient=x.createLinearGradient(0,0,W,H);gradient.addColorStop(0,'#e4e5ff');gradient.addColorStop(1,'#e8f5ff');x.fillStyle=gradient;x.fillRect(0,0,W,H);
 const title=batch.sections.map(s=>s.label).filter((v,i,a)=>a.indexOf(v)===i).join(' / ');text('OurNotes · '+title,52,65,36,'#25375b',1090,true);
 const player=batch.player;let left=52;if(player?.avatarCardId){await image('avatar-images/avatar-'+Number(player.avatarCardId)+'.webp',52,87,100,100);left=172;}
 text(player?.name||batch.name||'我的卡库',left,120,27,'#25375b',980,true);if(player)text('UID '+player.profileId+' · Rank '+player.rank+' · 更新 '+player.lastUpdatedAt,left,158,21,'#536581',980);
 text('计算于 '+new Date(batch.computedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' · '+(page+1)+' / '+pages.length+' 页',52,225,21);
 text((batch.options?.growthMode==='full-training'?'满特训 · 满等级':batch.options?.growthMode==='current-max'?'当前特训／解锁阶段满等级':'已保存养成')+' · 成员卡 3:4 · 留影卡 16:9',52,264,18,'#536581');
 for(const [index,item] of rows.entries()){
  const {section,entry,row,alternatives}=item,y=300+index*560;box(y,540);const method=entry.method||section.method;const song=row.song_title||songs.get(row.song_id)||'';text((entry.label||section.label)+' · '+(method==='skip'?'Skip':'非 Skip'),song?134:54,y+42,27,'#286cba',1075,true);if(song&&Number.isSafeInteger(Number(row.song_id))&&Number(row.song_id)>0){await image('jacket-images/song-'+Number(row.song_id)+'.webp',54,y+14,64,64);}const songLeft=song?134:54;text(song?(song+' · '+(row.difficulty||'')):'跨曲平均队伍 · 覆盖 '+row.covered_sheets+' 首',songLeft,y+77,22,'#33435f',600-songLeft-20);
  for(let i=0;i<5;i++){const px=54+i*216,mid=row.member_ids[i],sid=row.snap_ids[i],m=cards.get(mid),s=snaps.get(sid),g=inventory.members.find(v=>v.id===mid)||{},sg=inventory.snaps.find(v=>v.id===sid)||{};await image(m?.thumbnail,px,y+95,176,176*4/3);await image(s?.thumbnail,px,y+337,176,99);text('#'+mid+' '+(m?.name||'')+(mid===row.leader_member_id?' ★':''),px,y+461,17,'#25375b',202,true);text('Lv.'+(g.level??'—')+' · Live '+(g.live_skill_level??'—')+' · 激奏 '+(g.gekisou_skill_level??'—'),px,y+485,15,'#536581',202);text('Snap #'+sid+' · Lv.'+(sg.level??'—')+' · 突'+(sg.limit_break_count??'—'),px,y+508,15,'#536581',202);}
  let metric=row.average_relative_score!==undefined?'平均相对表现 '+f(row.average_relative_score*100)+'% · 薄弱场景 '+f(row.weak_relative_score*100)+'%':row.target_value!==undefined?f(row.target_value)+' '+(entry.unit||'')+' / 局'+(row.stage==='challenge'?' · '+row.consumed+' CP':''):'参考分 '+f(row.score);
  text(metric,600,y+76,22,'#286cba',550,true);
  if(alternatives.length)text('备选乐曲：'+alternatives.map(v=>v.song_title||songs.get(v.song_id)||'#'+v.song_id).join(' / '),54,y+531,15,'#536581',1070);
 }
 const notes=[...new Set(batch.sections.flatMap(s=>s.notes||[]))];text(notes[0]||'模型估算；限时搜索不宣称最优。',52,H-115,19,'#536581');if(batch.sections.some(s=>s.goal==='gekiso'))text('激奏为单人任务模型参考，不预测多人连胜；Skip 不触发激奏任务。',52,H-80,19,'#536581');else text('各目标分别推荐；修改卡库、养成、条件或活动后会重新计算。',52,H-80,19,'#536581');text('https://on.tabsac.com/#plan',52,H-40,20);return c;
}
