#!/usr/bin/env python3
"""Export public game art, or validate and atomically publish the staged images."""
import argparse, hashlib, io, json, os, pathlib, shutil, time
from PIL import Image

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def rows(p):
    v=json.loads(p.read_text())
    return v.get('_allData', []) if isinstance(v,dict) else v

def export(on, stage):
    jobs=[]
    for r in rows(on/'master/MasterMemberCard.json'):
        jobs.append(('thumb',str(r['_id']), 'card-images/members-%s.webp'%r['_id']))
    for r in rows(on/'master/MasterSupportCard.json'):
        jobs.append(('support',str(r['_id']), 'card-images/snaps-%s.webp'%r['_id']))
    for r in json.loads((on/'songs.json').read_text()).get('songs',[]):
        if r.get('jacket'): jobs.append(('jacket',r['jacket'], 'jacket-images/song-%s.webp'%r['id']))
    files={}; missing=[]; updated=0
    old=json.loads((stage/'image-manifest.json').read_text()) if (stage/'image-manifest.json').exists() else {}
    source_hashes={}
    for kind,name,dest in jobs:
        candidates=[on/'art'/kind/(name+ext) for ext in ('.jpg','.png','.jpeg')]
        src=next((p for p in candidates if p.is_file()),None)
        if not src: missing.append(dest); continue
        h=digest(src); target=stage/dest; target.parent.mkdir(parents=True,exist_ok=True)
        if old.get('sources',{}).get(dest)!=h or not target.exists() or old.get('files',{}).get(dest)!=digest(target):
            with Image.open(str(src)) as im:
                im.load(); im=im.convert('RGB'); im.thumbnail((512,512),getattr(Image,'Resampling',Image).LANCZOS)
                buf=io.BytesIO(); im.save(buf,'WEBP',quality=90,method=6)
            temp=target.with_name(target.name+'.tmp'); temp.write_bytes(buf.getvalue()); os.replace(str(temp),str(target)); updated+=1
        with Image.open(str(target)) as im: im.verify()
        files[dest]=digest(target); source_hashes[dest]=h
    result={'schema_version':1,'files':files,'sources':source_hashes,'missing':missing}
    stage.mkdir(parents=True,exist_ok=True)
    temp=stage/'image-manifest.tmp'; temp.write_text(json.dumps(result,sort_keys=True)); os.replace(str(temp),str(stage/'image-manifest.json'))
    print(json.dumps({'images':len(files),'converted':updated,'missing':missing}))

def publish(stage, root):
    m=json.loads((stage/'image-manifest.json').read_text()); files=m['files']
    for name,h in files.items():
        parts=pathlib.PurePosixPath(name).parts
        if len(parts)!=2 or parts[0] not in ('card-images','jacket-images') or not parts[1].endswith('.webp') or '..' in parts:
            raise ValueError('Unsafe image name')
        if digest(stage/name)!=h: raise ValueError('Image digest mismatch: '+name)
        with Image.open(str(stage/name)) as im: im.verify()
    files=dict(files); files['image-manifest.json']=digest(stage/'image-manifest.json')
    owner=(root/'index.html').stat()
    backup=pathlib.Path('/var/backups/ournotes-web-images')/time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
    changed=0
    for name,h in sorted(files.items(),key=lambda x:x[0]=='image-manifest.json'):
        dst=root/name
        if dst.exists() and digest(dst)==h: continue
        if dst.exists():
            saved=backup/name; saved.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(str(dst),str(saved))
        dst.parent.mkdir(parents=True,exist_ok=True); tmp=dst.with_name(dst.name+'.image-publish')
        shutil.copyfile(str(stage/name),str(tmp)); os.chmod(str(tmp),0o644); os.chown(str(tmp),owner.st_uid,owner.st_gid); os.replace(str(tmp),str(dst)); changed+=1
    for name,h in files.items():
        if digest(root/name)!=h: raise ValueError('Published digest mismatch')
    print(json.dumps({'published':len(files)-1,'changed':changed,'backup':str(backup)}))

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--publish',action='store_true'); p.add_argument('--on',default='/home/admin/bot/data/on'); p.add_argument('--stage',default='/home/admin/bot/data/web-images'); p.add_argument('--root',default='/www/wwwroot/ournotes-web'); a=p.parse_args()
    if a.publish: publish(pathlib.Path(a.stage),pathlib.Path(a.root))
    else: export(pathlib.Path(a.on),pathlib.Path(a.stage))
