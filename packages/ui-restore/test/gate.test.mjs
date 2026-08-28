// verify/gate 语义测试: fail-closed 默认(结构证据缺失即 FAIL)与显式 pixel-only 豁免。
// 背景(2026-08 审计 G2): 此前 regions/contract/verdict 缺失一律视为通过,
// 造成「只跑像素闸就宣布通过」的结构性假阴性出口。
import { evaluateGate } from "../dist/index.js";

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${label}\n  actual:   ${a}\n  expected: ${e}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const goodPixel = { diffRatio: 0.001 };
const okRegions = { clusterCount: 0, markedRatio: 0, regions: [] };
const okContract = { ok: true, errors: [] };
const okBp = {
  diffReport: { verdict: "PASS" },
  styleDiffReport: { verdict: "PASS" },
  truthReport: { verdict: "PASS" },
  canvas: { width: 375, height: 812 },
};

// 1) fail-closed 默认：像素完美但无结构证据 → FAIL
let g = evaluateGate({ pixel: goodPixel });
check("无结构证据 verdict=FAIL", g.verdict, "FAIL");
check("标记 regions+geometry 证据缺失", g.failedGates.includes("regions") && g.failedGates.includes("geometry"), true);
check("reason 说明证据缺失", g.reasons.some((r) => r.includes("结构性证据缺失")), true);

// 2) 显式 pixel-only → 旧语义豁免（像素过即过）
g = evaluateGate({ pixel: goodPixel, allowMissingEvidence: true });
check("显式 pixel-only 应 PASS", g.pass, true);
check("pixel-only 下 regions 跳过", g.detail.regions.detail.includes("pixel-only"), true);

// 3) 全证据齐 → PASS
g = evaluateGate({ pixel: goodPixel, regions: okRegions, blueprint: okBp, contract: okContract });
check("全证据齐应 PASS", g.pass, true);

// 4) geometry verdict FAIL → FAIL
g = evaluateGate({ pixel: goodPixel, regions: okRegions, blueprint: { ...okBp, diffReport: { verdict: "FAIL" } }, contract: okContract });
check("geometry verdict FAIL 应 FAIL", g.pass, false);
check("标记 geometry", g.failedGates.includes("geometry"), true);

// 5) contract 违约 → FAIL
g = evaluateGate({ pixel: goodPixel, regions: okRegions, blueprint: okBp, contract: { ok: false, errors: ["bad node"] } });
check("contract 违约应 FAIL", g.pass, false);

// 6) 像素超阈 → FAIL（原有闸不受影响）
g = evaluateGate({ pixel: { diffRatio: 0.5 }, regions: okRegions, blueprint: okBp, contract: okContract });
check("像素差超阈应 FAIL", g.pass, false);
check("标记 global", g.failedGates.includes("global"), true);

// 7) blocks 缺失不判违约（纯图标稿天然无文本块, 合法输入）
g = evaluateGate({ pixel: goodPixel, regions: okRegions, blueprint: okBp, contract: okContract, blocks: null });
check("blocks 缺失不阻断", g.pass, true);

// 8) pixel-only 不豁免像素闸本身
g = evaluateGate({ pixel: { diffRatio: 0.5 }, allowMissingEvidence: true });
check("pixel-only 下像素超阈仍 FAIL", g.pass, false);

if (failures > 0) {
  console.error(`gate 测试失败 ${failures} 项`);
  process.exit(1);
}
console.log("gate OK ✓ (8 cases)");
