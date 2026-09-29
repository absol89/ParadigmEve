import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const size = 160;
const clips = {
  spawn: [0,3,[130,110,100,140],false], idle:[4,7,[600,200,220,650],true],
  look:[8,11,[90,100,330,200],false], walk:[12,19,Array(8).fill(95),true],
  held:[20,23,[100,100,160,200],false], landing:[24,27,[70,100,130,170],false],
  poke:[28,31,[130,180,260,300],false], angry:[32,37,[150,110,90,180,150,200],false],
  punch:[38,55,[140,70,65,80,100,90,130,70,65,80,100,90,150,70,65,80,100,120],false],
  heavy:[56,65,[110,150,180,140,70,90,100,120,150,180],false],
  grab:[66,71,[100,120,150,160,140,170],false], carry:[72,79,Array(8).fill(110),true],
  throw:[80,87,[150,150,190,100,90,130,160,180],false],
  celebrate:[88,95,[140,120,100,150,100,110,250,250],false]
};

function state(frame) {
  for (const [name,[a,b]] of Object.entries(clips)) if (frame >= a && frame <= b) return [name, frame-a, b-a+1];
  throw new Error(String(frame));
}

function motion(frame) {
  const [clip,i,n] = state(frame);
  const phase = i / Math.max(1,n-1);
  const wave = Math.sin((i/Math.max(1,n))*Math.PI*2);
  let bob=0, x=0, paw=0, squash=0, ear=0;
  if (clip==='spawn') bob=Math.round((1-phase)*18);
  else if (clip==='idle'||clip==='look') bob=Math.round(Math.sin(i*Math.PI/2)*1.5);
  else if (clip==='walk'||clip==='carry') { bob=Math.round(Math.abs(wave)*3); x=Math.round(wave*2); }
  else if (clip==='held') bob=-10-i*2;
  else if (clip==='landing') squash=[7,4,2,0][i];
  else if (clip==='poke') x=[0,4,-3,0][i];
  else if (clip==='angry') ear=[0,2,4,5,3,0][i];
  else if (clip==='punch') paw=10+(i%6)*5;
  else if (clip==='heavy') paw=[0,5,10,18,28,38,25,14,6,0][i];
  else if (clip==='grab') paw=[0,8,18,28,34,32][i];
  else if (clip==='throw') paw=[28,34,38,32,20,10,4,0][i];
  else if (clip==='celebrate') bob=-[0,4,8,12,8,4,2,0][i];
  return {clip,i,bob,x,paw,squash,ear,wave};
}

const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">${body}</svg>`);
const ellipse = (cx,cy,rx,ry,fill,stroke='#332824',sw=3) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const line = (x1,y1,x2,y2,stroke,w=7) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"/>`;

function cat(frame) {
  const m=motion(frame), cx=80+m.x, hy=64+m.bob, by=104+m.bob+m.squash, ground=136;
  const body='#D99955', dark='#9C5D36', cream='#FFF8EB', ink='#332824', teal='#4BA9A3', pink='#F4A6A8';
  const blink=(m.clip==='idle'&&m.i===2)||(m.clip==='poke'&&m.i===2);
  const foot=m.clip==='walk'||m.clip==='carry' ? (m.i%2?4:-4) : 0;
  const px=cx+18+m.paw, py=100+m.bob-((m.clip==='grab'||m.clip==='throw')?8:0);
  return svg(`
    <path d="M ${cx+23} ${110+m.bob} Q ${cx+50} ${90+m.bob} ${cx+49} ${116+m.bob}" fill="none" stroke="${ink}" stroke-width="9" stroke-linecap="round"/>
    <path d="M ${cx+23} ${110+m.bob} Q ${cx+50} ${90+m.bob} ${cx+49} ${116+m.bob}" fill="none" stroke="${dark}" stroke-width="5" stroke-linecap="round"/>
    ${ellipse(cx,by+8,25,30,body)}
    ${ellipse(cx-11-foot,131,10,6,cream)}${ellipse(cx+11+foot,131,10,6,cream)}
    <path d="M ${cx-30} ${hy-15+m.ear} L ${cx-18} ${hy-42+m.ear} L ${cx-6} ${hy-16} Z" fill="${pink}" stroke="${ink}" stroke-width="4"/>
    <path d="M ${cx+30} ${hy-15+m.ear} L ${cx+18} ${hy-42+m.ear} L ${cx+6} ${hy-16} Z" fill="${pink}" stroke="${ink}" stroke-width="4"/>
    ${ellipse(cx,hy,35,31,body)}
    ${ellipse(cx,hy+14,23,13,cream,'none',0)}
    ${blink ? `<path d="M ${cx-19} ${hy-2} q 5 3 10 0 M ${cx+9} ${hy-2} q 5 3 10 0" fill="none" stroke="${ink}" stroke-width="3"/>`
      : ellipse(cx-14,hy,5,6,ink,'none',0)+ellipse(cx+14,hy,5,6,ink,'none',0)+ellipse(cx-12,hy-2,1.5,1.5,'white','none',0)+ellipse(cx+12,hy-2,1.5,1.5,'white','none',0)}
    <path d="M ${cx-4} ${hy+9} L ${cx+4} ${hy+9} L ${cx} ${hy+14} Z" fill="${pink}"/>
    <path d="M ${cx} ${hy+14} q -5 7 -10 1 M ${cx} ${hy+14} q 5 7 10 1" fill="none" stroke="${ink}" stroke-width="2"/>
    <rect x="${cx-22}" y="${hy+28}" width="44" height="6" rx="3" fill="${teal}"/>${ellipse(cx,hy+36,4,4,'#F3C84B',ink,1)}
    ${line(cx+15,99+m.bob,px,py,ink,10)}${line(cx+15,99+m.bob,px,py,body,6)}${ellipse(px,py,6,6,cream,ink,3)}
    <circle cx="${68+(frame%11)}" cy="${112+(frame%5)}" r="1.2"
      fill="rgb(${120+frame},${72+(frame%31)},${42+(frame%23)})" opacity=".72"/>
  `);
}

function dog(frame) {
  const m=motion(frame), cx=80+m.x, hy=64+m.bob, by=104+m.bob+m.squash;
  const tan='#D7A06A', brown='#84533E', cream='#FFF8EB', ink='#332824', blue='#5A84C8';
  const blink=(m.clip==='idle'&&m.i===2)||(m.clip==='poke'&&m.i===2);
  const foot=m.clip==='walk'||m.clip==='carry' ? (m.i%2?4:-4) : 0;
  const wag=(m.clip==='idle'||m.clip==='celebrate')?[-10,0,10,0][m.i%4]:Math.round(m.wave*8);
  const px=cx+18+m.paw, py=101+m.bob-((m.clip==='grab'||m.clip==='throw')?8:0);
  return svg(`
    ${line(cx-22,108+m.bob,cx-45,98+m.bob+wag,ink,10)}${line(cx-22,108+m.bob,cx-45,98+m.bob+wag,tan,6)}
    ${ellipse(cx,by+8,27,30,tan)}${ellipse(cx-11-foot,131,10,6,cream)}${ellipse(cx+11+foot,131,10,6,cream)}
    ${ellipse(cx-31,hy+2+m.ear,12,24,brown)}${ellipse(cx+31,hy+2+m.ear,12,24,brown)}
    ${ellipse(cx,hy,38,31,tan)}
    ${ellipse(cx,hy+15,25,14,cream,'none',0)}
    ${blink ? `<path d="M ${cx-19} ${hy-2} q 5 3 10 0 M ${cx+9} ${hy-2} q 5 3 10 0" fill="none" stroke="${ink}" stroke-width="3"/>`
      : ellipse(cx-14,hy,5,6,ink,'none',0)+ellipse(cx+14,hy,5,6,ink,'none',0)+ellipse(cx-12,hy-2,1.5,1.5,'white','none',0)+ellipse(cx+12,hy-2,1.5,1.5,'white','none',0)}
    ${ellipse(cx,hy+12,6,5,ink,'none',0)}
    <path d="M ${cx-9} ${hy+17} q 9 8 18 0" fill="none" stroke="${ink}" stroke-width="2"/>
    <path d="M ${cx-25} ${hy+28} L ${cx+25} ${hy+28} L ${cx} ${hy+45} Z" fill="${blue}"/>
    ${line(cx+15,99+m.bob,px,py,ink,10)}${line(cx+15,99+m.bob,px,py,tan,6)}${ellipse(px,py,6,6,cream,ink,3)}
    <circle cx="${69+(frame%9)}" cy="${113+(frame%5)}" r="1.2"
      fill="rgb(${105+frame},${70+(frame%37)},${55+(frame%19)})" opacity=".72"/>
  `);
}

function manifest() {
  const animations={};
  for (const [name,[a,b,ms,loop]] of Object.entries(clips)) animations[name]={frames:Array.from({length:b-a+1},(_,i)=>a+i),ms,loop};
  const hands={};
  for(let f=69;f<=84;f++) hands[String(f)]=[f<80?116:122,f<80?88:78,1];
  return {version:1,image:'atlas.png',width:1280,height:1920,columns:8,cellWidth:160,cellHeight:160,frameCount:96,anchor:[80,136],animations,hands};
}

async function build(id,displayName,description,draw) {
  const folder=path.join(root,'pets',id);
  fs.mkdirSync(folder,{recursive:true});
  const frames=[];
  for(let f=0;f<96;f++) {
    // Keep a hard transparent safety gutter at the bottom. Librsvg can leave a
    // one-pixel antialias fringe on the SVG viewport even when the visible art
    // is well above it; the pet contract requires every cell edge to be clear.
    frames.push(await sharp(draw(f))
      .extract({left:0,top:0,width:160,height:152})
      .extend({bottom:8,background:{r:0,g:0,b:0,alpha:0}})
      .png().toBuffer());
  }
  const atlas=await sharp({create:{width:1280,height:1920,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
    .composite(frames.map((input,f)=>({input,left:(f%8)*160,top:Math.floor(f/8)*160}))).png().toBuffer();
  fs.writeFileSync(path.join(folder,'atlas.png'),atlas);
  fs.writeFileSync(path.join(folder,'pet.json'),JSON.stringify({format:'cos-pet',version:1,id,displayName,description},null,2)+'\n');
  fs.writeFileSync(path.join(folder,'animations.json'),JSON.stringify(manifest(),null,2)+'\n');
  const labels=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1920">${Array.from({length:96},(_,f)=>`<text x="${(f%8)*160+5}" y="${Math.floor(f/8)*160+14}" font-family="Segoe UI, sans-serif" font-size="11" fill="#333">${f}</text>`).join('')}</svg>`);
  const sheet=await sharp({create:{width:1280,height:1920,channels:4,background:{r:246,g:246,b:242,alpha:1}}})
    .composite([{input:atlas},{input:labels}]).png().toBuffer();
  fs.writeFileSync(path.join(root,'docs','eve-tasks',`${id}-contact-sheet.png`),sheet);
}

await build('cat','Miso','A curious ginger chibi cat with a teal collar and a very expressive face.',cat);
await build('dog','Pip','A cheerful tan chibi dog with floppy ears, a blue bandana, and enthusiastic tail wags.',dog);
console.log('generated pets/cat, pets/dog and QA contact sheets');
