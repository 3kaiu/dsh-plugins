import { antiHackScan } from "@3kaiu/dsh-plugin-kit";
const clean=antiHackScan({ treeStats:{total:20, absolute:2, flex:5}, domDump:{tree:[]}});
console.log('clean',clean);
if(!clean.passed || clean.blocked) throw new Error('clean 应通过');
const blocker=antiHackScan({ treeStats:{total:10, absolute:9, flex:1}, domDump:{tree:[]}});
console.log('blocker',blocker);
if(blocker.passed || !blocker.blocked) throw new Error('高 absolute 应 block');
if(!blocker.violations.some(v=>v.rule==='absolute-leaf-ratio')) throw new Error('应命中 absolute-leaf-ratio');
const refAware=antiHackScan({ treeStats:{total:10, absolute:6, flex:4}, domDump:{tree:[]}, reference:{stats:{total:10, absolute:6}}});
console.log('refAware',refAware);
if(refAware.blocked) throw new Error('参考本身高 absolute 时应放宽，不应 block');
// hidden
const hiddenTree=[{tag:'div', computed:{display:'none'}, children:[]},{tag:'div', computed:{display:'block'}, children:[]}];
const hidden=antiHackScan({ treeStats:{total:2, absolute:0}, domDump:{tree:hiddenTree}, codeStats:{inlineStyleCount:20}});
console.log('hidden',hidden);
if(!hidden.warnings.some(w=>w.rule==='inline-style-count')) throw new Error('应 warn inline-style');
console.log('antihack OK ✓');
