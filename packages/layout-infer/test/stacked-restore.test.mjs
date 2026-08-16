// 堆叠稿层级重建回归测试
// fixture: mg-stacked-sections.json — 拍平稿 30 个根级兄弟节点(无 flexContainerInfo, 纯绝对坐标)
// 验证 reconstructHierarchy 能还原: 背景层/状态栏/导航栏/卡片/TabBar/贴纸容器/溢出节点
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconstructHierarchy, ROLES } from "@3kaiu/dsh-plugin-kit";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mg-stacked-sections.json");
const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
const { tree, stats } = reconstructHierarchy({ canvas: fx.meta.canvas, nodes: fx.nodes });

const assert = (cond, msg) => {
  if (!cond) throw new Error("堆叠稿重建失败: " + msg);
};

// 1. 统计: 30 节点全部参与, 背景 1, 容器块 3, 溢出 1
assert(stats.total === 30, "total=" + stats.total);
assert(stats.background === 1, "background=" + stats.background);
assert(stats.container === 3, "container=" + stats.container);
assert(stats.offCanvas === 1, "offCanvas=" + stats.offCanvas);
assert(stats.item === 5, "item=" + stats.item);

// 2. 背景层在最前, 角色 background
assert(tree[0].role === ROLES.BACKGROUND, "首块应为 background, got " + tree[0].role);
assert(tree[0].name === "矩形 148435", "背景应为渐变矩形");

// 3. 状态栏/导航栏: 全宽条独立且角色正确
const statusBar = tree.find((n) => n.role === ROLES.STATUS_BAR);
const navBar = tree.find((n) => n.role === ROLES.NAV_BAR);
assert(statusBar && statusBar.bbox.width === 375 && statusBar.bbox.y === 0, "状态栏缺失或尺寸错");
assert(navBar && navBar.bbox.y === 44, "导航栏缺失或位置错");

// 4. 卡片: 学习卡/贴纸卡/课程tab容器独立成 card 块
const cards = tree.filter((n) => n.role === ROLES.CARD);
assert(cards.length === 3, "card 应为 3, got " + cards.length);
const stickerCard = cards.find((n) => n.name === "组 174137");
assert(stickerCard, "贴纸卡缺失");
assert(stickerCard.children.length === 4, "贴纸卡应吸收 4 个贴纸, got " + stickerCard.children.length);

// 5. TabBar: 背景条 + 5 个 item(icon+label) + home indicator
const tabBar = tree.find((n) => n.role === ROLES.TAB_BAR);
assert(tabBar, "TabBar 缺失");
const tabItems = tabBar.children.filter((n) => n.role === ROLES.ITEM);
assert(tabItems.length === 5, "TabBar item 应为 5, got " + tabItems.length);
for (const it of tabItems) {
  assert(it.children.length === 2, "TabBar item 应有 icon+label 两个子节点: " + it.name);
  assert(it.bbox.height === 38, "TabBar item 高度应为 38(icon24+gap+label14): " + it.name);
}
assert(tabBar.children.some((n) => n.role === ROLES.BACKGROUND), "TabBar 背景条缺失");
assert(tabBar.children.some((n) => n.name.includes("Home Indicator")), "Home Indicator 缺失");

// 6. 溢出节点: 最后一个 off-canvas
const offCanvas = tree[tree.length - 1];
assert(offCanvas.role === ROLES.OFF_CANVAS && offCanvas.name === "阿祖搞定常用高频词", "溢出节点未识别");

// 7. 树无重复 id(除故意叠加的背景)
const ids = new Set();
const walk = (ns) => {
  for (const n of ns) {
    if (ids.has(n.id)) throw new Error("重复 id: " + n.id);
    ids.add(n.id);
    walk(n.children || []);
  }
};
walk(tree);
assert(ids.size > 0, "树为空");

console.log("堆叠稿重建回归: 背景/状态栏/导航栏/卡片/TabBar/贴纸吸收/溢出 全部正确 ✓");