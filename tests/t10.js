const WebSocket=require('ws');
const ws=new WebSocket('ws://127.0.0.1:6700');
const send=(t,id)=>ws.send(JSON.stringify({post_type:'message',message_type:'group',group_id:999999999,
 user_id:44000010,self_id:10000,raw_message:t,
 message:[{type:'text',data:{text:t}}],font:0,
 sender:{user_id:44000010,nickname:'t',card:'',role:'member'},time:Math.floor(Date.now()/1000),message_id:id}));
ws.on('open',()=>{ setTimeout(()=>{console.log('>>> /on查曲 Fatal');send('/on查曲 Fatal',669010);},300);
                   setTimeout(()=>{console.log('>>> /on查曲 ファタール');send('/on查曲 ファタール',669011);},7000); });
ws.on('message',d=>console.log('<<< '+d.toString().slice(0,320)));
setTimeout(()=>process.exit(0),20000);
