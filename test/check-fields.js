const fs=require('fs');
const { Raw: TL } = require('@tgsnake/skema');
const src=fs.readFileSync('src/methods.js','utf8');
const re=/new TL\.([A-Za-z_][\w.]*)\s*\(\s*\{/g;
let m, problems=[];
function cls(n){ let C=TL; for(const p of n.split('.')){ if(!C||!C[p]) return null; C=C[p]; } return C; }
while((m=re.exec(src))){
  const name=m[1];
  let i=m.index+m[0].length-1, depth=0, end=-1;
  for(let j=i;j<src.length;j++){ const c=src[j]; if(c==='{')depth++; else if(c==='}'){depth--; if(depth===0){end=j;break;} } }
  if(end<0) continue;
  const body=src.slice(i+1,end);
  const keys=[]; let d=0, cur='';
  for(let j=0;j<body.length;j++){ const c=body[j];
    if(c==='{'||c==='('||c==='[') d++;
    else if(c==='}'||c===')'||c===']') d--;
    if(d===0 && c===','){ keys.push(cur.trim()); cur=''; }
    else cur+=c;
  }
  if(cur.trim()) keys.push(cur.trim());
  const keyNames=keys.map(k=>k.split(':')[0].trim()).filter(Boolean).filter(k=>!k.startsWith('...'));
  const C=cls(name);
  if(!C){ problems.push(name+': НЕТ КЛАССА В СХЕМЕ'); continue; }
  let inst; try{ inst=new C({}); }catch(e){ inst={_slots:[]}; }
  const sl=(inst._slots||[]).map(String);
  for(const k of keyNames){ if(sl.length && !sl.includes(k)) problems.push(name+'.'+k+' — лишнее поле (в схеме: '+sl.join(', ')+')'); }
}
if(!problems.length) console.log('✅ все поля совпадают со схемой skema');
else { console.log('НАЙДЕНО ('+problems.length+'):'); problems.forEach(p=>console.log('  •',p)); }
