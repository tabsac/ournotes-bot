#!/usr/bin/env node
// Draw B25 with the canonical browser renderer; no browser process or remote upload.
const fs=require('node:fs'), path=require('node:path');
const {pathToFileURL}=require('node:url');
async function main() {
    const args=process.argv.slice(2), val=k=>args[args.indexOf(k)+1];
    if(!args.includes('--in')||!args.includes('--out')) throw Error('Usage: b25-render.cjs --in record.json --out output.png [--assets path]');
    const root=path.resolve(args.includes('--assets')?val('--assets'):(process.env.ON_WEB_ASSETS||'/www/wwwroot/ournotes-web'));
    const lib=process.env.ON_B25_CANVAS?require(process.env.ON_B25_CANVAS):require('@napi-rs/canvas');
    if(!lib.GlobalFonts.registerFromPath(path.join(root,'static-data/b25-font.ttf'),'OurNotesB25')) throw Error('B25 font unavailable');
    const {renderActivity}=await import(pathToFileURL(path.resolve(__dirname,'../shared/activity-renderer.mjs')));

    const record=JSON.parse(fs.readFileSync(val('--in'),'utf8'));
    const model=JSON.parse(fs.readFileSync(path.join(root,'build-info.json'),'utf8')).activity_model;
    if(record.model!==model) throw Error('活动数据或模型已更新，请在网页重新计算');
    const canvas=await renderActivity(record,{
        createCanvas:lib.createCanvas,
        async loadImage(src) {
            if(!/^(?:\.\/)?(card-images)\/[a-zA-Z0-9_.-]+\.(webp|png|jpg)$/.test(src)) return null;
            try{return await lib.loadImage(path.join(root,src));}catch{return null;}
        },
    });
    const dst=path.resolve(val('--out'));
    if(path.extname(dst).toLowerCase()!=='.png') throw Error('B25 output must be PNG');
    const buf=await canvas.encode('png');
    fs.writeFileSync(dst,buf);
    console.log(JSON.stringify({width:canvas.width,height:canvas.height,bytes:buf.length}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
