// 极简 YAML 解析器:仅支持本项目 .dsh/autopilot.yml 的受控形状
// (嵌套 map、行内列表 [a, b]、标量)。不依赖外部库。
// 约束:列表一律行内形态(key: [a, b]),不允许 "- item" 块。
export function parseMiniYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = line.match(/^ */)[0].length;
    const m = trimmed.match(/^([\w.-]+):(?:\s*(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const rest = (m[2] ?? "").trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (rest === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else if (rest.startsWith("[")) {
      parent[key] = rest.slice(1, -1).split(",").map((s) => scalarOf(s.trim())).filter((s) => s !== "");
    } else {
      parent[key] = scalarOf(rest);
    }
  }
  return root;
}

function scalarOf(s) {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}
