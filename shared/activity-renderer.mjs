export function validateActivity(a) {
 if(a?.kind!=='activity'||a.schema_version!==1||!a.actual_inputs?.profile?.inventory||!a.display) throw Error('活动方案格式不完整，请在网页重新计算');
 if(a.result?.goal){const r=a.result;if(r.search?.complete!==true||!['challenge_score','challenge_skip','cp','event_pt','shop_pt'].includes(r.goal.id)||!['normal','challenge'].includes(r.goal.mode)||!Array.isArray(r.recommendations)||r.recommendations.length<1||r.recommendations.length>3)throw Error('单局组卡尚未完成');for(const v of r.recommendations)if(v.member_ids?.length!==5||v.snap_ids?.length!==5||!v.per_live||!v.score?.order_rank_counts||!v.bonuses_10000||!Number.isFinite(v.target_value))throw Error('单局组卡数据不完整');return;}
 for(const obj of ['event_pt','shop_pt']) {const p=a.result?.plans?.[obj];if(!p?.totals)throw Error('活动方案尚未完成');for(const mode of ['normal','challenge']){const r=p[mode];if(!r || r.member_ids?.length!==5||r.snap_ids?.length!==5||!r.per_live||!r.score||!r.bonuses_10000)throw Error('组卡数据不完整');}}
}
export async function renderActivity(a,api) {
 validateActivity(a);if(a.result.goal)return renderSingleActivity(a,api);const W=1200,H=1740,c=api.createCanvas(W,H),x=c.getContext('2d');
 const f=n=>Number(n??0).toLocaleString('zh-CN');
 function box(y,h,fill='#ffffff'){x.fillStyle=fill;x.beginPath();x.roundRect(32,y,W-64,h,18);x.fill();}
 function text(t,px,py,size=22,color='#33435f',max=1080,bold=false){x.font=`${bold?'bold ':''}${size}px OurNotesB25`;x.fillStyle=color;t=String(t??'—');while(x.measureText(t).width>max&&t.length>1)t=t.slice(0,-2)+'…';x.fillText(t,px,py);}
 const gradient=x.createLinearGradient(0,0,W,H);gradient.addColorStop(0,'#e4e5ff');gradient.addColorStop(1,'#e8f5ff');x.fillStyle=gradient;x.fillRect(0,0,W,H);
 text('OurNotes  活动组卡',52,67,36,'#25375b',850,true);
 text(a.actual_inputs.name||'我的卡库',52,108,25);text('计算于 '+new Date(a.computedAt||a.savedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),52,143,20);
 text('Boost 预算 '+f(a.actual_inputs.settings.boost_budget)+' · 每场 '+f(a.actual_inputs.settings.boost_per_live)+' Boost · 已有 '+f(a.actual_inputs.settings.starting_cp)+' CP · 挑战消耗 '+f(a.actual_inputs.settings.challenge_cp)+' CP',52,182,21);
 const cards=Object.fromEntries(a.display.members.map(c=>[c.id,c])),snaps=Object.fromEntries(a.display.snaps.map(c=>[c.id,c])),songs=Object.fromEntries(a.display.songs.map(c=>[c.id,c.title]));
 const owned=a.actual_inputs.profile.inventory;
 async function image(src,px,py,w,h){const im=src&&await api.loadImage(src);if(im){const scale=Math.min(w/im.width,h/im.height),iw=im.width*scale,ih=im.height*scale;x.drawImage(im,px+(w-iw)/2,py+(h-ih)/2,iw,ih);}else{x.fillStyle='#e1e7f3';x.fillRect(px,py,w,h);text('暂无卡图',px+5,py+h/2,17,'#60718b',w-10);}}
 let y=212;
 for(const [obj,label] of [['event_pt','活动 PT 最优'],['shop_pt','商店 PT 最优']]) {
  const p=a.result.plans[obj],t=p.totals;box(y,650);text(label,54,y+43,29,'#286cba',420,true);
  text(f(t[obj])+' PT',740,y+43,32,'#286cba',400,true);
  text('活动 '+f(t.event_pt)+' PT  /  商店 '+f(t.shop_pt)+' PT  /  剩余 '+f(t.cp_remaining)+' CP',54,y+82,22);
  for(const [j,mode] of ['normal','challenge'].entries()) {
   const r=p[mode],dy=y+112+j*256;
   text((j?'挑战演出':'普通演出')+' · '+f(t[mode+'_plays'])+' 场',54,dy+20,25,'#263c60',380,true);
   text((songs[r.song_id]||'歌曲 #'+r.song_id)+' · '+r.difficulty,450,dy+20,23,'#33435f',690);
   for(let i=0;i<5;i++) {
    const px=54+i*216,mid=r.member_ids[i],sid=r.snap_ids[i],m=cards[mid],s=snaps[sid],growth=owned.members.find(c=>c.id===mid)||{},sg=owned.snaps.find(c=>c.id===sid)||{};
    await image(m?.thumbnail,px,dy+35,106,106);await image(s?.thumbnail,px+110,dy+71,68,68);
    text('#'+mid+' '+(m?.name||'')+(mid===r.leader_member_id?' ★':''),px,dy+164,19,'#25375b',202,true);
    text('Lv.'+growth.level+' · 特训 '+(growth.training_count+1)+' · 觉 '+growth.awakening_count,px,dy+190,18,'#536581',202);
    text('Live '+(growth.live_skill_level??'—')+' / Snap #'+sid+' Lv.'+sg.level+' 突'+sg.limit_break_count,px,dy+216,15,'#536581',202);
   }
   text('综合力 '+f(r.power)+'    活动加成 +'+r.bonuses_10000.event_pt/100+'%    商店加成 +'+r.bonuses_10000.shop_pt/100+'%',54,dy+245,20);
  }
  y+=672;
 }
 box(y,112);text('推荐乐曲 · 同预算下的完整循环收益',54,y+32,22,'#286cba',1080,true);
 for(const [i,mode] of ['normal','challenge'].entries()){const rows=a.result.top3?.event_pt?.[mode]||[];text((i?'挑战':'普通')+'：'+rows.slice(0,3).map(p=>songs[p[mode].song_id]||'#'+p[mode].song_id).join('  /  '),54,y+65+i*28,19,'#536581');}
 text('模型估算 · 仅展示已完成计算的方案；养成、预算或活动变化后请重新计算。',52,1692,20,'#536581');
 text('https://on.tabsac.com/  ·  /on活动组卡',52,1721,19,'#536581');return c;
}

async function renderSingleActivity(a,api) {
 const W=1200,H=360+444*a.result.recommendations.length,c=api.createCanvas(W,H),x=c.getContext('2d'),g=a.result.goal;
 const f=n=>Number(n??0).toLocaleString('zh-CN',{maximumFractionDigits:2});
 function text(t,px,py,size=22,color='#33435f',max=1080,bold=false){x.font=`${bold?'bold ':''}${size}px OurNotesB25`;x.fillStyle=color;t=String(t??'—');while(x.measureText(t).width>max&&t.length>1)t=t.slice(0,-2)+'…';x.fillText(t,px,py);}
 function box(y,h){x.fillStyle='#ffffff';x.beginPath();x.roundRect(32,y,W-64,h,18);x.fill();}
 const gradient=x.createLinearGradient(0,0,W,H);gradient.addColorStop(0,'#e4e5ff');gradient.addColorStop(1,'#e8f5ff');x.fillStyle=gradient;x.fillRect(0,0,W,H);
 text('OurNotes · '+g.label,52,67,36,'#25375b',1090,true);text(a.actual_inputs.name||'我的卡库',52,108,25);
 text('计算于 '+new Date(a.computedAt||a.savedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),52,143,20);
 text((g.mode==='normal'?'普通':'挑战')+'演出 · '+(g.method==='ap'?'AP / 120 种技能顺序平均':'跳过参考')+' · '+g.consumed+(g.mode==='normal'?' Boost':' CP')+' / 局',52,182,21);
 const cards=Object.fromEntries(a.display.members.map(c=>[c.id,c])),snaps=Object.fromEntries(a.display.snaps.map(c=>[c.id,c])),songs=Object.fromEntries(a.display.songs.map(c=>[c.id,c.title])),owned=a.actual_inputs.profile.inventory;
 async function image(src,px,py,w,h){const im=src&&await api.loadImage(src);if(im){const scale=Math.min(w/im.width,h/im.height),iw=im.width*scale,ih=im.height*scale;x.drawImage(im,px+(w-iw)/2,py+(h-ih)/2,iw,ih);}else{x.fillStyle='#e1e7f3';x.fillRect(px,py,w,h);}}
 for(const [j,r] of a.result.recommendations.entries()) {
  const y=212+j*444;box(y,426);
  text((j+1)+'. '+(songs[r.song_id]||'#'+r.song_id)+' · '+r.difficulty,54,y+42,28,'#286cba',680,true);
  text(f(r.target_value)+' '+g.unit+'/局',760,y+42,28,'#286cba',350,true);
  text('综合力 '+f(r.power)+' · '+(g.method==='ap'?'平均分 '+f(r.score.average_score):'跳过分 '+f(r.score.minimum_score)),54,y+78,22);
  text('参考分 '+f(r.score.minimum_score)+' ～ '+f(r.score.maximum_score)+' · '+Object.entries(r.score.order_rank_counts).filter(([,n])=>n).map(([k,n])=>k+' '+n+'/'+r.score.skill_orders).join(' / '),54,y+110,21);
  for(let i=0;i<5;i++) {
   const px=54+i*216,mid=r.member_ids[i],sid=r.snap_ids[i],m=cards[mid],s=snaps[sid],growth=owned.members.find(c=>c.id===mid)||{},sg=owned.snaps.find(c=>c.id===sid)||{};
   await image(m?.thumbnail,px,y+130,106,106);await image(s?.thumbnail,px+110,y+166,68,68);
   text('#'+mid+' '+(m?.name||'')+(mid===r.leader_member_id?' ★':''),px,y+266,19,'#25375b',202,true);
   text('Lv.'+growth.level+' · 特训 '+(growth.training_count+1)+' · 觉 '+growth.awakening_count,px,y+294,18,'#536581',202);
   text('Live '+(growth.live_skill_level??'—')+' / Snap #'+sid+' Lv.'+sg.level+' 突'+sg.limit_break_count,px,y+322,15,'#536581',202);
  }
  text('活动加成 +'+r.bonuses_10000.event_pt/100+'% · 徽章加成 +'+r.bonuses_10000.shop_pt/100+'%',54,y+359,21);
  text('平均单局：'+f(r.per_live.event_pt)+' 活动 PT / '+f(r.per_live.shop_pt)+' 徽章'+(g.mode==='normal'?' / '+f(r.per_live.cp)+' CP':''),54,y+392,21);
 }
 text('单局组卡 · 无需总预算 · 模型估算 · 当前候选池内完整搜索',52,H-100,21);
 text('修改养成、目标或活动后请重新计算。https://on.tabsac.com/ · /on活动组卡',52,H-50,20);
 return c;
}
