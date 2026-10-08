#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const web=process.argv[2];if(!web)throw Error('Usage: node tools/sync_b25_renderer.cjs <web-repository>');
const src=path.join(path.resolve(web),'browser/b25-renderer.mjs'),dst=path.join(__dirname,'../shared/b25-renderer.mjs');
const data=fs.readFileSync(src);if(!data.toString().startsWith('// Canonical B25 PNG drawing'))throw Error('Not canonical B25 renderer');
fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,data);
console.log('Shared B25 renderer SHA256: '+crypto.createHash('sha256').update(data).digest('hex'));
