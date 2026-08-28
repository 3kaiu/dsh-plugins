import { apply } from "../dist/index.js";
const registered=[];
const ctx={ tools:{ register(def){ registered.push(def); return ()=>{}; } } };
apply(ctx);
const names=registered.map(t=>t.name);
console.log('registered',names.join(', '));
const must=['reference_ingest','neutral_ingest','browser_start','browser_viewport','browser_navigate','browser_screenshot','browser_dom_dump','browser_state_trigger','browser_console','browser_stop','compare_geometry','compare_typography','compare_palette','compare_screenshots','score_report','fanout_evaluate','verify_neutral','viewport_matrix','token_map','check_design_constraints','check_a11y','recovery_plan','ci_report','check_dsl_security','git_rollback_point','estimate_cost','capture_feedback','critique_design','generate_design_system','plan_experts','generate_handoff','anti_hack_scan','state_read','state_update'];
for(const n of must){ if(!names.includes(n)) throw new Error(`缺少 ${n}`);}
console.log('all required tools present ✓');
// 执行 compare_geometry
const cg=registered.find(t=>t.name==='compare_geometry');
const geom=await cg.execute({ referenceTree:[{id:'a',name:'header',rect:{x:0,y:0,w:1440,h:80},children:[]}], implementedTree:[{id:'a',name:'header',rect:{x:0,y:0,w:1440,h:64},children:[]}]},{});
console.log('compare_geometry',JSON.stringify(geom));
if(geom.mismatches.length===0) throw new Error('应检出几何偏差');
// 执行 score_report
const sr=registered.find(t=>t.name==='score_report');
const sc=await sr.execute({ struct:0.9, geom:0.9, pixel:0.9, type:0.9, color:0.9},{});
console.log('score_report',JSON.stringify(sc));
if(typeof sc.total!=='number') throw new Error('score_report 失败');
// 执行 state_read
const st=registered.find(t=>t.name==='state_read');
const s=await st.execute({},{});
console.log('state_read',s.exists!==undefined?'ok':'fail');
console.log('plugin-register OK ✓');
