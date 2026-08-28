import { compareScreenshots } from "@3kaiu/dsh-plugin-kit";
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pixel-'));
const ref=path.join(dir,'ref.png');
const cur=path.join(dir,'cur.png');
const cur2=path.join(dir,'cur2.png');
// minimal PNG buffers (same header, diff byte)
const base=Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,13,0x49,0x48,0x44,0x52,0,0,0,10,0,0,0,10,8,2,0,0,0,1,2,3,4,0,0,0,0,0,0,0,0,10,0,0,0,10]);
fs.writeFileSync(ref, base);
fs.writeFileSync(cur, base);
const same=compareScreenshots({reference:ref, current:cur});
console.log('same',same);
if(same.ssim!==1 || same.pixelDiffRatio!==0) throw new Error('同图应 ssim=1');
const diffBuf=Buffer.from(base);
diffBuf[30]= (diffBuf[30]+1)%256;
fs.writeFileSync(cur2, diffBuf);
const diff=compareScreenshots({reference:ref, current:cur2});
console.log('diff',diff);
if(diff.ssim===1) throw new Error('异图 ssim 不应为 1');
if(!diff.heatmap || !fs.existsSync(diff.heatmap)) throw new Error('应生成热图');
console.log('pixel OK ✓');
// missing file
const miss=compareScreenshots({reference:ref, current:path.join(dir,'no.png')});
if(miss.aligned!==false) throw new Error('缺失应 aligned false');
console.log('pixel missing OK ✓');
