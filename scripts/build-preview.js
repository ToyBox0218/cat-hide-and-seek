'use strict';
// Makes an offline, self-contained review artifact. Does not deploy or publish.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),destination=path.resolve(process.argv[2]||path.join(root,'dist/cat-battle-preview.html'));
let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
let css=fs.readFileSync(path.join(root,'style.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'survival.css'),'utf8');
css=css.replace(/url\(['"]?(\.\/assets\/[^)'"\s]+)['"]?\)/g,(_,file)=>`url("data:image/png;base64,${fs.readFileSync(path.join(root,file)).toString('base64')}")`);
html=html.replace('<link rel="stylesheet" href="./style.css">',`<style>${css}</style>`).replace('<link rel="stylesheet" href="./survival.css">','');
html=html.replace(/<script src="\.\/([^\"]+)"><\/script>/g,(_,file)=>`<script>\n${fs.readFileSync(path.join(root,file),'utf8').replace(/<\/script/gi,'<\\/script')}\n</script>`);
html=html.replace(/"(\.\/assets\/audio\/[^"]+\.wav)"/g,(_,file)=>JSON.stringify(`data:audio/wav;base64,${fs.readFileSync(path.join(root,file)).toString('base64')}`));
html=html.replace('</body>', '<script>startPractice();</script></body>');
html=html.replace('<title>貓咪捉迷藏｜P2P 雙人尋貓</title>','<title>貓咪大對決｜本機審閱試玩版</title>');
if(/<script\s+src=|<link\s+rel="stylesheet"|url\(['"]?\.\/assets|"\.\/assets\/audio\//.test(html))throw Error('Preview still depends on external local assets');
fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,html);
console.log(JSON.stringify({file:destination,bytes:Buffer.byteLength(html),selfContained:true,startsIn:'explicitly labeled local practice',published:false}));
