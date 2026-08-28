import { checkDslSecurity, sanitizeText, sanitizeDsl, gitStatus, ensureRollbackPoint } from "../dist/index.js";

let r1 = checkDslSecurity({ nodes: [{ text: '<script>alert(1)</script>' }] });
if (r1.passed || r1.violations.length === 0) throw new Error('xss should fail');
console.log('xss', r1.violations[0].rule);
let r2 = checkDslSecurity({ nodes: [{ fill: 'https://evil.com/img.png' }] });
if (r2.warnings.length === 0) throw new Error('untrusted url should warn');
console.log('url warn', r2.warnings[0].rule);
let r3 = checkDslSecurity({ nodes: [{ text: 'Hello' }, { fill: 'https://image-resource.mastergo.com/a.png' }] });
if (!r3.passed) throw new Error('clean should pass');
console.log('clean pass', r3.summary);
let t = sanitizeText('hi\x00\x01\nok' + 'x'.repeat(20000));
if (t.includes('\x00') || t.length !== 10000) throw new Error('sanitize');
console.log('sanitize', t.length);
let dsl = { nodes: [{ text: 'hi\x00\x01' }] };
let s = sanitizeDsl(dsl);
if (s.nodes[0].text.includes('\x00')) throw new Error('sanitizeDsl should strip control chars');
console.log('sanitizeDsl', JSON.stringify(s.nodes[0].text));

let st = gitStatus(process.cwd());
if (typeof st.clean !== 'boolean') throw new Error('gitStatus');
console.log('gitStatus', st.clean, st.dirtyFiles.length);
let rp = ensureRollbackPoint({ iteration: 5 }, process.cwd());
if (!rp.git || rp.iteration !== 5) throw new Error('rollbackPoint');
console.log('rollbackPoint', rp.git);

console.log('security-git OK ✓');
