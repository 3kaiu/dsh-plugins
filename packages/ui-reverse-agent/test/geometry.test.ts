import { compareGeometry } from "@3kaiu/dsh-plugin-kit";
const ref=[{id:'a',name:'header',rect:{x:0,y:0,w:1440,h:80},children:[{id:'b',name:'logo',rect:{x:20,y:20,w:100,h:40},children:[]}]}];
const impl=[{id:'a',name:'header',rect:{x:0,y:0,w:1440,h:64},children:[{id:'b',name:'logo',rect:{x:20,y:20,w:100,h:40},children:[]}]}];
const out=compareGeometry({referenceTree:ref, implementedTree:impl, tolerance:2});
console.log('geometry',JSON.stringify(out));
if(out.mismatches.length!==1) throw new Error('应检出 1 个高度偏差');
if(out.mismatches[0].prop!=='height' || out.mismatches[0].delta!==16) throw new Error('偏差应为 16');
console.log('geometry OK ✓');
