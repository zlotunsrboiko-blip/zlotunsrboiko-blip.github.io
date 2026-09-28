import fs from 'node:fs';
const root=new URL('../',import.meta.url),read=p=>fs.readFileSync(new URL(p,root),'utf8');
let html=read('public/index.html');
html=html.replace('<link rel="stylesheet" href="./styles.css">',()=>'<style>'+read('public/styles.css')+'</style>');
html=html.replace('<script src="./connection.js" defer></script>','').replace('<script src="./app.js" defer></script>','').replace('<script src="./pool.js" defer></script>','');
html=html.replace('</body>',()=>'<script>'+read('public/connection.js')+'</script><script>'+read('public/app.js')+'\n'+read('public/pool.js')+'</script></body>');
fs.writeFileSync(new URL('index.html',root),html);
console.log('GitHub Pages index.html rebuilt');
