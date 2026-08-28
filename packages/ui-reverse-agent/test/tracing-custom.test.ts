import { createTracer, defineRule, checkCustomRules, PRESET_RULES } from "../dist/index.js";

let t = createTracer('test-1');
let s1 = t.start('parse', { sections: 10 });
await new Promise(r=>setTimeout(r,5));
s1.end({ ok: true });
let r = t.report();
if (r.count !== 1) throw new Error('tracer');
console.log('tracer', r.total, r.spans[0].name);

let rule = defineRule({ id: 'test', prop: 'gap', test: v => v % 8 === 0, message: 'gap 8x' });
let c1 = checkCustomRules({ prop: 'gap', value: 16 }, [rule]);
if (!c1.passed) throw new Error('16 should pass');
let c2 = checkCustomRules({ prop: 'gap', value: 13 }, [rule]);
if (c2.passed) throw new Error('13 should fail');
console.log('custom', c1.passed, c2.violations[0].rule);
let c3 = checkCustomRules({ prop: 'width', value: 1500 }, [PRESET_RULES.maxWidth]);
if (c3.passed) throw new Error('maxWidth');
console.log('preset rule', c3.violations[0].rule);

console.log('tracing-custom OK ✓');
