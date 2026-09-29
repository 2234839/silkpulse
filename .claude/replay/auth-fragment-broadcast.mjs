/**
 * auth 改造验证：fragment 注入 + 兄弟 tab 共享 + 鉴权矩阵（断言式红/绿输出）
 */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";

const SERVER = process.env.SILKPULSE_SERVER ?? "http://localhost:8080";
const ADMIN_KEY = process.env.SILKPULSE_ADMIN_KEY ?? "";
const PG_KEY = process.env.SILKPULSE_PLAYGROUND_KEY ?? "";
let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => { console.error(`✗ ${m}`); failed++; };

function detectChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const n of ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"]) {
    try { const f = execSync(`which ${n} 2>/dev/null`, { encoding: "utf8" }).trim(); if (f) return f; } catch {}
  }
  throw new Error("no chromium");
}

// ── 鉴权矩阵（HTTP）──
const matrix = [
  ["无 token", "", 401],
  ["错误 token", "wrong-key", 401],
  ["admin token", ADMIN_KEY, 200],
  ["playground token", PG_KEY, 200],
];
for (const [name, key, expect] of matrix) {
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const res = await fetch(`${SERVER}/api/devices`, { headers });
  (res.status === expect ? ok : bad)(`鉴权矩阵 HTTP：${name} → ${res.status}（期望 ${expect}）`);
}

// ── WS 鉴权矩阵 ──
async function wsTest(name, query, expectOpen) {
  await new Promise((resolve) => {
    let settled = false;
    const done = (fn) => { if (!settled) { settled = true; fn(); } resolve(); };
    const ws = new WebSocket(`ws://${new URL(SERVER).host}/ws/console${query}`);
    const t = setTimeout(() => { ws.close(); done(() => expectOpen ? bad(`WS：${name} 超时`) : ok(`WS：${name} 被拒 ✓`)); }, 3000);
    ws.onopen = () => { clearTimeout(t); done(() => expectOpen ? ok(`WS：${name} 连接成功 ✓`) : bad(`WS：${name} 不应连上`)); ws.close(); };
    ws.onclose = () => { clearTimeout(t); done(() => expectOpen ? bad(`WS：${name} 被拒`) : ok(`WS：${name} 被拒 ✓`)); };
    ws.onerror = () => {};
  });
}
await wsTest("无 token", "", false);
await wsTest("错误 token", "?token=wrong", false);
await wsTest("admin token", `?token=${encodeURIComponent(ADMIN_KEY)}`, true);
await wsTest("playground token", `?token=${encodeURIComponent(PG_KEY)}`, true);

// ── 浏览器断言 ──
const browser = await puppeteer.launch({ executablePath: detectChromium(), headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });

// 1. fragment 注入：#key= 用后即清 + localStorage 落库
{
  const page = await browser.newPage();
  await page.goto(`${SERVER}/#key=${encodeURIComponent(ADMIN_KEY)}`, { waitUntil: "networkidle0", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));
  const hash = await page.evaluate(() => location.hash);
  const stored = await page.evaluate(() => localStorage.getItem("__silkpulse_auth_key__"));
  (hash === "" || !hash.includes("key=") ? ok : bad)(`fragment 用后即清（hash="${hash}"）`);
  stored === ADMIN_KEY ? ok("fragment key 写入 localStorage ✓") : bad(`localStorage="${stored}"`);
  await page.close();
}

// 2. query 兼容：?key= 仍生效
{
  const page = await browser.newPage();
  await page.goto(`${SERVER}/?key=${encodeURIComponent(ADMIN_KEY)}`, { waitUntil: "networkidle0", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));
  const stored = await page.evaluate(() => localStorage.getItem("__silkpulse_auth_key__"));
  stored === ADMIN_KEY ? ok("query ?key= 兼容路径 ✓") : bad(`localStorage="${stored}"`);
  await page.close();
}

// 3. BroadcastChannel：A 发 key-updated → B 的 useAuth 模块单例采纳（写 localStorage）
{
  const pageA = await browser.newPage();
  await pageA.goto(`${SERVER}/#key=${encodeURIComponent(ADMIN_KEY)}`, { waitUntil: "networkidle0", timeout: 15000 });
  const pageB = await browser.newPage();
  await pageB.goto(`${SERVER}/`, { waitUntil: "networkidle0", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));
  await pageB.evaluate(() => localStorage.removeItem("__silkpulse_auth_key__"));
  await pageA.evaluate(() => new BroadcastChannel("silkpulse-auth").postMessage({ type: "key-updated", key: "probe-key-xyz" }));
  await new Promise((r) => setTimeout(r, 500));
  const storedB = await pageB.evaluate(() => localStorage.getItem("__silkpulse_auth_key__"));
  storedB === "probe-key-xyz" ? ok("key-updated 广播 → 兄弟 tab 采纳 ✓") : bad(`B 的 localStorage="${storedB}"`);
  // key-cleared 广播 → B 同步登出
  await pageA.evaluate(() => new BroadcastChannel("silkpulse-auth").postMessage({ type: "key-cleared" }));
  await new Promise((r) => setTimeout(r, 500));
  const clearedB = await pageB.evaluate(() => localStorage.getItem("__silkpulse_auth_key__"));
  clearedB === null ? ok("key-cleared 广播 → 兄弟 tab 同步登出 ✓") : bad(`清除后 B="${clearedB}"`);
  await pageA.close();
  await pageB.close();
}

await browser.close();
console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
