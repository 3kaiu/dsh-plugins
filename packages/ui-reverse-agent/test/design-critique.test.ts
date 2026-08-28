import { critiqueDesign, generateDesignSystem } from "../dist/index.js";

let bp1 = {
  palette: Array.from({length:10},(_,i)=>({hex:`#${i}${i}${i}`, count:1})),
  typographyProfile: { a:{family:'Inter'}, b:{family:'Arial'}, c:{family:'Roboto'}, d:{family:'Mono'} },
  tree: [{ computed:{gap:2}}, {computed:{gap:4}}, {computed:{gap:8}}, {computed:{gap:16}}, {computed:{gap:24}}, {computed:{gap:32}}, {computed:{gap:48}}]
};
let c1 = critiqueDesign({ blueprint: bp1 });
if (c1.issues.length < 2) throw new Error(`critique ${c1.issues.length}`);
console.log('critique', c1.issues.map(i=>i.type).join(','), c1.suggestions.length);

let bp2 = {
  palette: [{hex:'#111',count:5},{hex:'#fff',count:3}],
  typographyProfile: { t1:{family:'Inter',size:14}, t2:{family:'Inter',size:16} },
  tree: [{ role:'header', name:'header', children: [{ role:'card', name:'card' }, { role:'card', name:'card2' }] }, { role:'header', name:'header2' }]
};
let ds = generateDesignSystem(bp2);
if (ds.tokens.colors.length !== 2) throw new Error('colors');
if (ds.components.length === 0) throw new Error('components');
console.log('designSystem', ds.summary);

console.log('design-critique OK ✓');
