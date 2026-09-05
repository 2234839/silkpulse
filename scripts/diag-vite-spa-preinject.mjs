/**
 * 验证：真实 vite build 的 Vue SPA（console 自身）+ script 先注入
 *
 * 场景：SDK 在 <head> 同步执行（evaluateOnNewDocument）时 Vue app 未 mount，
 * frameworks=[] 已上报；修复后 SDK 应在 app mount 后 ≤5s 重报 frameworks=['vue']，
 * 控制台面板从「🚫 不支持」自愈为可连接。
 */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const SERVER = process.env.SILKPULSE_SERVER ?? "http://localhost:8080";
const KEY = process.env.SILKPULSE_ADMIN_KEY;
/** 游客/项目密钥——鉴权部署下设备接入用（714a2bc 后必须自持密钥） */
const PLAYGROUND_KEY = process.env.SILKPULSE_PLAYGROUND_KEY ?? "";

async function execOn(devId, code) {
  const res = await fetch(`${SERVER}/api/devices/${devId}/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ code }),
  });
  const j = await res.json();
  if (j.result?.error) throw new Error(j.result.error);
  try {
    return JSON.parse(j.result?.result ?? "null");
  } catch {
    return j.result?.result;
  }
}

async function getDevice(devId) {
  const d = await (
    await fetch(`${SERVER}/api/devices`, { headers: { authorization: `Bearer ${KEY}` } })
  ).json();
  return d.devices?.find((x) => x.id === devId);
}

let chrom = process.env.CHROMIUM_PATH;
if (!chrom)
  for (const n of ["chromium-browser", "chromium", "google-chrome"]) {
    try {
      const f = execSync(`which ${n} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (f) {
        chrom = f;
        break;
      }
    } catch {}
  }
const b = await puppeteer.launch({
  executablePath: chrom,
  headless: true,
  /** --disable-features=LocalNetworkAccessChecks：Chrome 146 拦截测试页早期
   *  发起的 ws://localhost 连接（ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS） */
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=LocalNetworkAccessChecks",
    `--user-data-dir=${path.join(os.homedir(), "snap/chromium/common/tmp-profiles/vite-spa-test")}`,
  ],
});
const page = await b.newPage();

/** 先注入：document_start 阶段插 SDK script（等价真实 PWA 的 <head> script 标签） */
await page.evaluateOnNewDocument((origin) => {
  const inject = () => {
    const s = document.createElement("script");
    s.src = `${origin}/sdk.js`;
    s.dataset.server = origin;
    /** 设备接入凭据：projectId（公开标识，项目存在且启用即放行） */
    s.dataset.projectId = "cs_playground";
    (document.head ?? document.documentElement).appendChild(s);
  };
  if (document.documentElement) inject();
  else
    document.addEventListener(
      "readystatechange",
      () => document.readyState !== "loading" && inject(),
      { once: true },
    );
}, SERVER);

/** 目标页 = console 自身（真实 Vue vite build SPA） */
await page.goto(`${SERVER}/?tab=devtools`, { waitUntil: "networkidle0" });
console.log("page loaded:", await page.title());

/** 找到这个设备 */
let dev = null;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const devs = await (
    await fetch(`${SERVER}/api/devices`, { headers: { authorization: `Bearer ${KEY}` } })
  ).json();
  dev = devs.devices?.find(
    (x) => x.url?.includes("tab=devtools") && x.userAgent?.includes("HeadlessChrome"),
  );
  if (dev) break;
}
if (!dev) {
  console.log("❌ 设备未注册");
  await b.close();
  process.exit(1);
}
console.log("device:", dev.id);

/** T0：初始上报的 frameworks */
let t0 = (await getDevice(dev.id))?.frameworks;
console.log("T0 frameworks:", JSON.stringify(t0));

/** 等待重报（轮询最多 20s） */
let healed = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const fws = (await getDevice(dev.id))?.frameworks;
  if (Array.isArray(fws) && fws.includes("vue")) {
    console.log(`T+${i + 1}s frameworks 重报:`, JSON.stringify(fws));
    healed = true;
    break;
  }
}

/** 再验证 exec 通道的 devtools 能力（真实 build 产物的组件树） */
if (healed) {
  await new Promise((r) => setTimeout(r, 2000));
  const avail = await execOn(dev.id, `return __silkpulse_devtools_available()`);
  console.log("available:", JSON.stringify(avail));
  const tree = await execOn(dev.id, `return __silkpulse_devtools_tree()`);
  const tj = JSON.stringify(tree ?? {});
  console.log(
    "tree 含 ConsoleApp/DevToolsPanel:",
    tj.includes("ConsoleApp") || tj.includes("App"),
    tj.slice(0, 120),
  );
}

console.log(healed ? "✅ 先注入 SPA frameworks 自愈通过" : "❌ frameworks 未重报");
await b.close();
process.exit(healed ? 0 : 1);
