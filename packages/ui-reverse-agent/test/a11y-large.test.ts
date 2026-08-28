import { checkA11y, filterAbandonedSections, paginateSections, largeFileDiagnostics } from "../dist/index.js";

let a1 = checkA11y({ tree: [{ tag: 'div', role: 'button', name: 'btn' }] });
if (a1.violations.length === 0) throw new Error('button no name should violation');
console.log('a11y button', a1.violations[0].rule);
let a2 = checkA11y({ tree: [{ tag: 'div', role: 'banner', name: 'header' }] });
if (a2.warnings.length === 0) throw new Error('banner div should warning');
console.log('a11y semantic', a2.warnings[0].rule);
let a3 = checkA11y({ tree: [{ tag: 'h1', name: 'h1' }, { tag: 'h3', name: 'h3' }] });
if (a3.warnings.length === 0) throw new Error('heading skip should warning');
console.log('a11y heading', a3.warnings[0].rule);
let a4 = checkA11y({ tree: [{ name: 'text', computed: { color: '#ffffff', backgroundColor: '#fefefe' } }] });
if (a4.warnings.length === 0) throw new Error('contrast low should warning');
console.log('a11y contrast', a4.warnings[0].ratio);
let a5 = checkA11y({ tree: [{ tag: 'img', name: 'cover' }] });
if (a5.warnings.length === 0) throw new Error('img alt should warning');
console.log('a11y img', a5.warnings[0].rule);

// large-file
let secs = [{ bbox: { x: 0, y: 0, width: 100, height: 100 } }, { bbox: { x: 2000, y: 0, width: 100, height: 100 } }, { bbox: { x: -200, y: 0, width: 100, height: 100 } }];
let f = filterAbandonedSections(secs, { width: 1440, height: 900 });
if (f.kept.length !== 1 || f.dropped !== 2) throw new Error(`filter ${f.kept.length}/${f.dropped}`);
console.log('filter', f.kept.length, f.dropped);
let p = paginateSections(Array.from({length:25},(_,i)=>({id:i})), 10);
if (p.pageCount !== 3 || p.pages[1].start !== 10) throw new Error('paginate');
console.log('paginate', p.pageCount);
let d = largeFileDiagnostics(secs, { width: 1440, height: 900 });
if (d.dropped !== 2) throw new Error('diag');
console.log('diag', d.recommendation);

console.log('a11y-large OK ✓');
