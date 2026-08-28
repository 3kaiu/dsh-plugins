import { compareTypography } from "@3kaiu/dsh-plugin-kit";
const ref=[{id:'t',name:'title',type:'TEXT',text:'Hello',font:{family:'Inter',size:16,weight:'400'},textColor:'#111',children:[]}];
const impl=[{id:'t',name:'title',type:'TEXT',text:'Hello',computed:{fontFamily:'Inter',fontSize:14,fontWeight:'400',color:'#111'},children:[]}];
const out=compareTypography({referenceTree:ref, implementedTree:impl});
console.log('typography',JSON.stringify(out));
if(!out.mismatches.some(m=>m.prop==='fontSize' && m.delta===2)) throw new Error('应检出 fontSize 偏差 2');
console.log('typography OK ✓');
// 同字体应无 family mismatch
const ref2=[{id:'t',name:'title',type:'TEXT',text:'Hello',font:{family:'Inter',size:16},children:[]}];
const impl2=[{id:'t',name:'title',type:'TEXT',text:'Hello',computed:{fontFamily:'Inter',fontSize:16},children:[]}];
const out2=compareTypography({referenceTree:ref2, implementedTree:impl2});
if(out2.mismatches.length!==0) throw new Error('同字体不应报 mismatch');
console.log('typography 同字体 OK ✓');
