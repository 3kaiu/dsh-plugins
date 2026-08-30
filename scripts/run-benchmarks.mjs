#!/usr/bin/env node
// run-benchmarks.mjs — benchmarks/ 全量回归一键化(SKILL §⑦ 的执行体)
//
// 用法: node scripts/run-benchmarks.mjs [--filter <case名称子串>] [--keep]
//
// 每个案例(case-*/)的完整回归闭环:
//   1. analyze   design.json → UI Truth 产物包 + 四闸门禁(契约/几何守恒/样式守恒/Yoga真值)
//   2. 真值块清单 ← 蓝图 TEXT 叶子派生(visual-diff 契约: "设计侧清单来自蓝图 bounds")
//   3. 探针      restore.html → 同会话 {render.png + render.blocks.json}(ui-restore dist/dom-blocks.js)
//   4. 好例断言  truth.png vs 渲染图 → 收敛语义
//        HARD: 区域归零(clusterCount===0) + diffRatio<0.02(亚像素/AA 噪声级)
//        WARN: blockMatchRate<0.95(清单粒度尚未对齐蓝图的富文本切分 —— V2 typography 校准项)
//   5. 坏例断言  restore-bad.html 注入偏差必须被检出(corrections 非空或区域>0) —— 封堵假阴性出口
//   6. session   记账到 .dsh/bench/<case>/session.json(.dsh 已被 gitignore, 产物不污染仓库)
//
// 设计要点: 编排只消费 pipeline 单一实现(analyzeDesign/verifyScreenshots), 不复制门禁逻辑;
// 渲染探针复用 dom-blocks.probe —— png 与块清单同一页面会话产出, 坐标/像素严格同空间。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeDesign, verifyScreenshots } from '../packages/ui-restore/dist/pipeline.js';
import { decodePng } from '../packages/ui-restore/dist/index.js';
import { probe } from '../packages/ui-restore/dist/dom-blocks.js';
import { findSystemChrome } from '../packages/ui-restore/dist/screenshot.js';
import { execFileSync } from 'node:child_process';

/** 运行环境 Chrome 大版本(像素级冻结基线的权威性依据); 不可得返回 null */
function runnerChromeMajor() {
  try {
    const bin = findSystemChrome();
    if (!bin) return null;
    const v = execFileSync(bin, ['--version'], { encoding: 'utf8' });
    return parseInt((v.match(/(\d+)\./) || [])[1] ?? '', 10) || null;
  } catch { return null; }
}
const RUNNER_CHROME = runnerChromeMajor();

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const benchDir = path.join(rootDir, 'benchmarks');
const args = process.argv.slice(2);
const flagVal = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const has = (n) => args.includes(`--${n}`);
const filter = flagVal('filter');
const BMR_WARN = 0.95;

const PAD_END = [4, 20]; const cases = [];
for (const d of fs.readdirSync(benchDir).sort()) {
  if (!d.startsWith('case-')) continue;
  if (filter && !d.includes(filter)) continue;
  const dir = path.join(benchDir, d);
  const need = ['design.json', 'truth.png'];
  if (!need.every((f) => fs.existsSync(path.join(dir, f)))) continue;
  if (!fs.existsSync(path.join(dir, 'restore.html'))) continue;
  cases.push({ name: d.slice('case-'.length), dir });
}
if (!cases.length) { console.error('无可用案例(benchmarks/case-*: design.json+truth.png+restore.html)'); process.exit(1); }

/** 从蓝图叶子派生设计侧块清单(TEXT 叶子, 画布绝对坐标) */
function truthBlocksFromBlueprint(bpFiles) {
  const bp = JSON.parse(fs.readFileSync(bpFiles, 'utf8'));
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.text === 'string' && n.text.trim() && n.bounds) {
      out.push({ text: n.text.replace(/\s+/g, ' ').trim(), x: n.bounds.x, y: n.bounds.y, width: n.bounds.width ?? 0, height: n.bounds.height ?? 0 });
    }
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c);
  };
  for (const r of [...(bp.tree || []), ...(bp.floatings || [])]) walk(r);
  return { list: out, canvas: bp.canvas };
}

/** 收敛判定: 返回 {ok, reasons[], warnings[]} —— 好=验收达成, 允许像素噪声但位置/区域零差 */
function judgeGood(v, canvas) {
  const regions = v.regions?.clusterCount ?? null;
  const okPx = v.pixel.diffRatio != null && v.pixel.diffRatio < 0.02;
  const okRegions = regions === 0;
  const reasons = [];
  if (!okPx) reasons.push(`diffRatio=${v.pixel.diffRatio} ≥0.02`);
  if (!okRegions) reasons.push(`差异区域=${regions} 未归零`);
  const bmr = v.blocks?.blockMatchRate ?? null;
  return {
    ok: okPx && okRegions,
    reasons, bmr, regions,
    warnBmr: bmr != null && bmr < BMR_WARN ? `BMR=${bmr}<${BMR_WARN}` : null,
    // 注意: unmatchedRender/unmatchedDesign 是 verifyScreenshots 返回值的顶层字段(pipeline 契约),
    // 不在 blocks 子对象内; 计数经 slice(0,8) 截断, 仅作量级归因参考
    unmatchedD: (v.unmatchedDesign ?? []).length,
    unmatchedR: (v.unmatchedRender ?? []).length,
  };
}
// 设计侧未命中样例在 row 上仅保留计数与首例, 全量走 session/artifacts 排查

const results = [];
for (const c of cases) {
  const art = path.join(rootDir, '.dsh', 'bench', c.name);
  fs.mkdirSync(art, { recursive: true });
  const row = { name: c.name, gates: {}, bad: null, ok: false, reasons: [] };
  try {
    // 1) analyze —— 四闸 + 产物包(含 blueprint.json)
    const a = await analyzeDesign(path.join(c.dir, 'design.json'), { outDir: path.join(art, 'out') });
    row.gates = a.summary.gates;
    row.lintWarn = a.lint.checks.filter((x) => x.level !== 'PASS').map((x) => `${x.level}:${x.check}`).join(' ') || null;
    if (row.lintWarn) console.log(`  ! [体检] ${c.name}: ${row.lintWarn}(详见 lint 设计, 不阻断回归)`);

    // 2+3) 真值块清单(蓝图派生) + 渲染探针(好例)
    const tb = truthBlocksFromBlueprint(a.files.blueprint);
    // 视口对齐权威 = 基准 truth.png 的真实像素, 而非蓝图 canvas —— ingest 对含越界内容
    // (绝对定位负坐标段)的稿会按内容外接盒推导画布(实证: live-course-card 蓝图画布=688x812,
    // 库内基准图=375x812)。空间推导口径属 V2-1 UI Truth 专项; benchmark 以基准图为锚保证可回归。
    const tMeta = decodePng(fs.readFileSync(path.join(c.dir, 'truth.png')));
    const W = tMeta.width, H = tMeta.height;
    fs.writeFileSync(path.join(art, 'truth.blocks.json'), JSON.stringify(tb.list, null, 1));
    await probe(path.join(c.dir, 'restore.html'), path.join(art, 'good.blocks.json'),
      { png: path.join(art, 'good.render.png'), width: W, height: H });

    // 4) 好例收敛断言(truth.png 为库内基准; 尺寸失配会让 comparePng 硬失败 → 直接 FAIL)
    //    像素级断言的权威性 = 制作时 Chrome === 运行时 Chrome(case meta.json 记录):
    //    跨 Chrome 版本的字形/AA 差异会打穿 <2%/区域归零 断言 —— 版本不匹配时降级为
    //    「四闸 + BMR 报告 + 坏例检出」(全部确定性), 像素断言仅在基线浏览器权威时执行。
    const meta = fs.existsSync(path.join(c.dir, 'meta.json'))
      ? JSON.parse(fs.readFileSync(path.join(c.dir, 'meta.json'), 'utf8')) : {};
    const pixelAuthoritative = meta.chromeMajor != null && meta.chromeMajor === RUNNER_CHROME;
    const good = verifyScreenshots({
      truthPng: path.join(c.dir, 'truth.png'), renderPng: path.join(art, 'good.render.png'),
      bpPath: a.files.blueprint,
      blocksTruth: path.join(art, 'truth.blocks.json'), blocksRender: path.join(art, 'good.blocks.json'),
    });
    Object.assign(row, judgeGood(good), { pixelRatio: good.pixel.diffRatio });
    if (!pixelAuthoritative) {
      row.pixelSkip = `Chrome ${RUNNER_CHROME ?? '?'} ≠ 基线 ${meta.chromeMajor ?? '未记录'}`;
      const gatesOK = ['contract', 'geometry', 'style'].every((k) => String(row.gates[k] ?? '').startsWith('PASS')); // truth 为软门禁(既有语义), 不入硬判定
      row.ok = gatesOK; // 像素断言让位; 四闸(纯数学, 版本无关)+坏例检出(见下)继续把关
    }
    if (!row.ok && !row.pixelSkip) row.reasons.push(`好例未收敛: ${[`diffRatio=${good.pixel.diffRatio}`, `clusters=${good.regions}`].join(' / ')}`);
    if (row.warnBmr) {
      row.bmrNote = `${row.warnBmr}(unmatchedD=${row.unmatchedD}, unmatchedR=${row.unmatchedR})`;
      console.log(`  ! [WARN] ${c.name}: ${row.bmrNote} —— 清单粒度 vs 蓝图富文本切分, V2 typography 校准项`);
    }

    // 5) 坏例断言: 注入偏差必须被检出(假阴性出口封堵)
    const badHtml = path.join(c.dir, 'restore-bad.html');
    if (fs.existsSync(badHtml)) {
      await probe(badHtml, path.join(art, 'bad.blocks.json'), { png: path.join(art, 'bad.render.png'), width: W, height: H });
      const bad = verifyScreenshots({
        truthPng: path.join(c.dir, 'truth.png'), renderPng: path.join(art, 'bad.render.png'), bpPath: a.files.blueprint,
        blocksTruth: path.join(art, 'truth.blocks.json'), blocksRender: path.join(art, 'bad.blocks.json'),
      });
      row.bad = { detected: (bad.corrections?.corrections?.length ?? 0) > 0 || (bad.regions?.clusterCount ?? 0) > 0, clusters: bad.regions?.clusterCount ?? 0, corrections: bad.corrections?.corrections ?? [] };
      if (!row.bad.detected) row.reasons.push('坏例注入偏差未被检出(假阴性!)');
      if (row.pixelSkip && row.bad.detected && row.ok) row.reasons = row.reasons.filter((r) => !r.startsWith('好例未收敛'));
    }
    if (!fs.existsSync(badHtml)) row.badSkipped = true;

    // 6) session 记账(形态对齐 restore.mjs, 便于人工排查)
    fs.writeFileSync(path.join(art, 'session.json'), JSON.stringify({
      case: c.name, createdAt: new Date().toISOString(),
      gates: row.gates, lint: row.lintWarn,
      good: { diffRatio: good.pixel.diffRatio, regions: good.regions, bmr: good.blocks?.blockMatchRate ?? null,
        matchedPairs: good.blocks?.matchedPairs ?? null, posSim: good.blocks?.positionSimilarity ?? null,
        // 注: unmatched 计数被 pipeline slice(0,8) 截断, 仅作量级参考; 全量清单见 *.blocks.json
        truthBlocks: tb.list.length, unmatchedD: row.unmatchedD ?? null, unmatchedR: row.unmatchedR ?? null },
      bad: row.bad,
      reasons: row.reasons,
    }, null, 1));
    row.ok = row.ok && (!row.bad || row.bad.detected);
  } catch (e) {
    row.error = e.message; row.ok = false;
  }
  results.push(row);
}

// 汇总表
const col = (s, w) => String(s ?? '-').slice(0, w).padEnd(w);
console.log('\n=== benchmark 回归汇总 ===');
console.log(`${col('case', PAD_END[1])}${col('契约', PAD_END[0])}${col('几何', PAD_END[0])}${col('样式', PAD_END[0])}${col('真值', PAD_END[0])}${col('diff%', PAD_END[0])}${col('区域', PAD_END[0])}${col('BMR', PAD_END[0])}${col('坏例检出', PAD_END[0])}判定`);
for (const r of results) {
  if (r.error) { console.log(`${col(r.name, PAD_END[1])}执行失败: ${r.error}`); continue; }
  const g = r.gates;
  const short = (v) => String(v ?? '').replace(/^PASS_/, '').replace('FAIL_', 'F:');
  console.log(`${col(r.name, PAD_END[1])}${col(short(g.contract), PAD_END[0])}${col(short(g.geometry), PAD_END[0])}${col(short(g.style), PAD_END[0])}${col(short(g.truth), PAD_END[0])}${col(String(r.pixelRatio), PAD_END[0])}${col(String(r.regions), PAD_END[0])}${col(r.bmr != null ? r.bmr : '-', PAD_END[0])}${col(r.bad == null ? (r.badSkipped ? 'skip' : '-') : (r.bad.detected ? 'YES' : 'NO!'), PAD_END[0])}${r.ok ? '✅' : '❌ ' + r.reasons.join('; ')}`);
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `\n全部通过(${results.length} 案例)` : `\n${failed.length}/${results.length} 案例未过门槛`);
// BMR 语义边界(诚实声明): BMR 度量「真文本节点」的对齐度。设计稿中文本以矢量字形(svgKey)
// 呈现的部分不会成为 DOM 文本节点, 此类稿 BMR 天然 <1 且不算回归失败 —— 故仅 WARN 不入硬门禁。
// 达成 BMR=1 的验收只在「文本全部落为真文本节点」的渲染体上成立(V2 typography/字形判定专项)。
process.exit(failed.length ? 1 : 0);