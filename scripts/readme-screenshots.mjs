/**
 * readme-screenshots.mjs —— 为 README 重截三张 DevTools 面板截图（统一视口尺寸）
 *
 * 用法：node scripts/readme-screenshots.mjs
 * 产物：docs/vueDevTools.png / docs/reactDevTools.png / docs/chromeDevTools.png
 *
 * 前置：本地 server 跑在 8080（鉴权关闭即可）；三个目标页：
 *   - examples/vue-test-page.html（file:// 打开，SDK 连 localhost:8080）
 *   - examples/react-test-page.html
 *   - /demo（纯静态，用 Chrome DevTools Elements 面板）
 */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const BASE = "http://localhost:8090";
const ADMIN_KEY = process.env.SILKPULSE_ADMIN_KEY ?? "";
const VIEWPORT = { width: 1440, height: 860, deviceScaleFactor: 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrom = process.env.CHROMIUM_PATH;
if (!chrom) {
  for (const n of ["chromium-browser", "chromium", "google-chrome"]) {
    try {
      const f = execSync(`which ${n} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (f) {
        chrom = f;
        break;
      }
    } catch {
      /* continue */
    }
  }
}

/** 打开一个目标页并等 SDK 连上 */
async function openTarget(browser, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 742, height: 895 });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(3000);
  return page;
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: chrom,
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    // ── 1. 三个目标设备页 ──
    await openTarget(browser, `http://localhost:8091/vue-test-page.html`);
    await openTarget(browser, `http://localhost:8091/react-test-page.html`);
    const demo = await openTarget(browser, `${BASE}/demo`);
    // demo 页造点 DOM 变化，让 Elements 树有内容层次
    await demo.evaluate(() => {
      document.getElementById("btn-fetch-ok")?.click();
    });
    await sleep(1500);

    // ── 2. 控制台：登录 + 逐设备截 devtools 面板 ──
    const cp = await browser.newPage();
    await cp.setViewport(VIEWPORT);
    await cp.goto(`${BASE}/${ADMIN_KEY ? `?key=${ADMIN_KEY}` : ""}`, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });
    await sleep(3000);
    // 清理离线设备，侧栏只留在线目标
    await cp.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("清理离线"))
        ?.click();
    });
    await sleep(1500);

    /** 点击 nav tab（绕过徽标 pointer 拦截用 DOM click） */
    async function clickTab(label) {
      await cp.evaluate((label) => {
        [...document.querySelectorAll("nav button")]
          .find((b) => b.textContent?.trim() === label)
          ?.click();
      }, label);
    }

    /** 选中设备列表里名称含关键字且在线（URL 含 8091，排除历史离线设备）的设备 */
    async function selectDevice(keyword) {
      await cp.evaluate((kw) => {
        [...document.querySelectorAll("aside li")]
          .find(
            (li) =>
              li.textContent?.toLowerCase().includes(kw) &&
              li.textContent?.includes("8091") &&
              !li.textContent?.includes("离线"),
          )
          ?.click();
      }, keyword);
      await sleep(3000);
    }

    /** DevTools 面板内切换 dock（Elements / Vue / React chip，精确匹配避免误点） */
    async function selectDock(plugin) {
      await cp.evaluate((p) => {
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent?.trim() === p)
          ?.click();
      }, plugin);
      // devtools iframe 加载 + backend 握手较慢，等右上角「已连接」状态
      for (let i = 0; i < 8; i++) {
        await sleep(3000);
        const connected = await cp.evaluate(() => {
          const t = document.body.textContent ?? "";
          return !t.includes("连接中") && !t.includes("不支持");
        });
        if (connected) break;
        await cp.evaluate(() => {
          [...document.querySelectorAll("button")]
            .find((b) => b.textContent?.includes("刷新"))
            ?.click();
        });
      }
      await sleep(2000);
    }

    // Vue 设备 → DevTools tab → vue dock
    await selectDevice("vue");
    await clickTab("DevTools");
    await sleep(2000);
    await selectDock("Vue");
    await cp.screenshot({ path: "docs/vueDevTools.png" });
    console.log("saved docs/vueDevTools.png");

    // React 设备
    await selectDevice("react");
    await clickTab("DevTools");
    await sleep(2000);
    await selectDock("React");
    await cp.screenshot({ path: "docs/reactDevTools.png" });
    console.log("saved docs/reactDevTools.png");

    // demo 设备 → Chrome DevTools tab（elements 锁定 dock）
    await selectDevice("demo");
    await clickTab("Chrome DevTools");
    await sleep(8000);
    await cp.screenshot({ path: "docs/chromeDevTools.png" });
    console.log("saved docs/chromeDevTools.png");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
