const WebSocket=require('ws');
const ws=new WebSocket('ws://127.0.0.1:6700');
ws.on('open',()=>setTimeout(()=>ws.send(JSON.stringify({post_type:'message',message_type:'group',group_id:999999999,
 user_id:43000007,self_id:10000,raw_message:'/on谱面预览 焚音打',
 message:[{type:'text',data:{text:'/on谱面预览 焚音打'}}],font:0,
 sender:{user_id:43000007,nickname:'t',card:'',role:'member'},time:Math.floor(Date.now()/1000),message_id:667007})),300));
ws.on('message',d=>{console.log('<<< '+d.toString().slice(0,300));setTimeout(()=>process.exit(0),400)});
setTimeout(()=>process.exit(0),26000);
