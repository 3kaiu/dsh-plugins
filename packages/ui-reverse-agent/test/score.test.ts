import { scoreReport } from "@3kaiu/dsh-plugin-kit";
const s=scoreReport({struct:0.95, geom:0.9, pixel:0.92, type:0.94, color:0.96, previousTotal:0.91});
console.log('score',s);
if(Math.abs(s.total-0.929)>0.01) throw new Error(`total 应 ~0.929 得 ${s.total}`);
if(s.delta!==0.019 && s.delta!==0.018) throw new Error(`delta 应 0.019 得 ${s.delta}`);
if(s.regression) throw new Error('不应触发 regression');
const r=scoreReport({struct:0.5, geom:0.5, pixel:0.5, type:0.5, color:0.5, previousTotal:0.9});
if(!r.regression) throw new Error('应触发 regression');
if(r.total!==-1){
  // 非 blocked 时 total 0.5，回归检测应 true
}
const blocked=scoreReport({struct:1, geom:1, pixel:1, type:1, color:1, blocked:true});
if(blocked.total!==-1) throw new Error('blocked 时 total 应 -1');
if(blocked.complete) throw new Error('blocked 不应 complete');
// 自动归一：仅传 struct/geom
const partial=scoreReport({compareLayouts:{matched:8, missing:[{path:'a'}]}, compareScreenshots:{ssim:0.9}});
console.log('partial',partial);
if(typeof partial.total!=='number') throw new Error('partial 评分失败');
console.log('score OK ✓');
