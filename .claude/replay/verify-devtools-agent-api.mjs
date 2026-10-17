/**
 * 回放脚本：验证 agent HTTP API 的 Vue DevTools 能力链路
 *
 * 断言（红/绿输出）：
 * 1. /api/skill/silkpulse 返回的提示词包含 DevTools 辅助函数与面板映射说明
 * 2. 设备上线（vue-test-page 注入 SDK 连接 server）
 * 3. exec 调 __silkpulse_devtools_available() → vue: true
 * 4. exec 调 __silkpulse_devtools_tree() → 组件树非空且含 Vue 组件
 * 5. exec 调 __silkpulse_devtools_inspect(idx) → 读到 props/state 数据
 *
 * 前置：server 已在 8080 运行（SILKPULSE_ADMIN_KEY/PLAYGROUND_KEY 已配），
 * examples 目录已由 http.server 9099 静态服务。
 */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";
import fs from "node:fs";

const SERVER = "http://localhost:8080";
const PAGE_URL = "http://localhost:9099/vue-test-page.html";
const ADMIN_KEY = process.env.SILKPULSE_ADMIN_KEY ?? "admin-test";
const AUTH = { Authorization: `Bearer ${ADMIN_KEY}` };

function detectChromium() {
  for (const name of ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"]) {
    try {
      const found = execSync(`which ${name} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (found && fs.existsSync(found)) return found;
    } catch {}
  }
  throw new Error("未找到 chromium，请设置 CHROMIUM_PATH");
}

let failed = 0;
/** 断言输出（红/绿） */
function check(name, cond, detail = "") {
  const mark = cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
}

/** exec 辅助：对设备执行 code，返回解析后的 JSON */
async function exec(deviceId, code) {
  const resp = await fetch(`${SERVER}/api/agent/devices/${deviceId}/exec`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return resp.json();
}

// 1. skill 文档断言
const skill = await (await fetch(`${SERVER}/api/skill/silkpulse?key=${ADMIN_KEY}`)).text();
check("skill 文档包含 DevTools 辅助函数说明", skill.includes("__silkpulse_devtools_tree"));
check("skill 文档包含组件查询流程", skill.includes("查指定组件"));
check("skill 文档包含 Chrome DevTools 面板映射", skill.includes("与 Chrome DevTools 面板的对应关系"));

// 2. 起无头浏览器打开 Vue 测试页，等设备上线
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? detectChromium(),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.goto(PAGE_URL, { waitUntil: "networkidle2", timeout: 30000 });

let devices = [];
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const resp = await fetch(`${SERVER}/api/agent/devices`, { headers: AUTH });
  const data = await resp.json();
  devices = data.devices ?? [];
  if (devices.length > 0) break;
}
check("测试页设备上线", devices.length > 0, `共 ${devices.length} 台`);
if (devices.length === 0) {
  await browser.close();
  process.exit(1);
}
/** 连接已关闭的旧设备会残留在线列表直到超时，逐台重试选活设备 */
let deviceId = null;
for (const d of devices) {
  const probe = await exec(d.id, "return 1");
  if (probe.success) {
    deviceId = d.id;
    break;
  }
}
check("存在可 exec 的活设备", deviceId != null);
if (!deviceId) {
  await browser.close();
  process.exit(1);
}

// 3. 探测框架（轮询等待：设备上线后 Vue 可能仍在从 CDN 加载/挂载）
let avail = null;
for (let i = 0; i < 15; i++) {
  avail = await exec(deviceId, "return __silkpulse_devtools_available()");
  if (avail.success && JSON.parse(avail.result).vue === true) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check("devtools_available → vue: true", avail.success && JSON.parse(avail.result).vue === true, avail.result);

// 4. 组件树
const tree = await exec(deviceId, "return await __silkpulse_devtools_tree()");
const treeData = tree.success ? JSON.parse(tree.result) : null;
check(
  "devtools_tree → vue 组件树非空",
  treeData?.framework === "vue" && (treeData.tree?.length ?? 0) > 0,
  `framework=${treeData?.framework}, 顶层节点=${treeData?.tree?.length}`,
);

// 5. inspect 读 props/state：从树里找一个带 idx 的节点
/** 在树中深度优先找第一个带 idx 的节点 */
function findWithIdx(nodes) {
  for (const n of nodes ?? []) {
    if (n.idx != null) return n;
    const hit = findWithIdx(n.children);
    if (hit) return hit;
  }
  return null;
}
const node = findWithIdx(treeData?.tree);
check("树中存在带 idx 的组件", node != null, node ? `name=${node.name}, idx=${node.idx}` : "");
if (node) {
  const inspect = await exec(deviceId, `return await __silkpulse_devtools_inspect(${node.idx})`);
  const data = inspect.success ? JSON.parse(inspect.result) : null;
  const hasData = data && Object.keys(data).length > 0;
  check(
    `devtools_inspect(${node.idx}) → 读到组件数据`,
    Boolean(hasData),
    hasData ? `keys=${Object.keys(data).join(",")}` : inspect.error ?? "",
  );
}

await browser.close();
if (failed > 0) {
  console.error(`\x1b[31m失败 ${failed} 项\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m全部通过\x1b[0m");
