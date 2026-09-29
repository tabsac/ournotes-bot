const WebSocket=require('ws');
const ADMIN=YOUR_ADMIN_QQ;
const ws=new WebSocket('ws://127.0.0.1:6700');
const send=(t,id)=>ws.send(JSON.stringify({post_type:'message',message_type:'group',group_id:999999999,
 user_id:ADMIN,self_id:10000,raw_message:t,
 message:[{type:'text',data:{text:t}}],font:0,
 sender:{user_id:ADMIN,nickname:'admin',card:'',role:'admin'},time:Math.floor(Date.now()/1000),message_id:id}));
ws.on('open',()=>{ setTimeout(()=>{console.log('>>> /on更新 主数据');send('/on更新 主数据',669101);},300);
                   setTimeout(()=>{console.log('>>> /on更新 主数据 应用');send('/on更新 主数据 应用',669102);},8000); });
ws.on('message',d=>console.log('<<< '+d.toString().slice(0,420)));
setTimeout(()=>process.exit(0),24000);
