/**
 * UI 审查会话脚本：headless chromium 双页会话
 *   页面 A：打开 server /demo 作为被调试设备
 *   页面 B：打开 console dev（5174），点击设备后逐面板截图
 *
 * 用法：node scripts/ui-audit-session.mjs <outdir>
 * 可选环境变量：CONSOLE_URL（默认 http://localhost:5174）、SERVER（默认 http://localhost:8080）
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const SERVER = process.env.SERVER ?? "http://localhost:8080";
const CONSOLE = process.env.CONSOLE_URL ?? SERVER;
const OUT = process.argv[2] ?? "/tmp/ui";
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const devicePage = await browser.newPage();
await devicePage.setViewport({ width: 500, height: 800 });
await devicePage.goto(`${SERVER}/demo`, { waitUntil: "networkidle2", timeout: 20000 });

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text());
});
await page.goto(CONSOLE, { waitUntil: "networkidle2", timeout: 20000 });

/** 等待 /demo 设备出现在列表并点击选中 */
async function selectDemoDevice(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = await (await fetch(`${SERVER}/api/devices`)).json();
      const demo = (data.devices ?? data).find((d) => d.url?.includes("/demo"));
      if (demo) {
        await new Promise((r) => setTimeout(r, 800));
        const clicked = await page.evaluate(() => {
          const els = [...document.querySelectorAll("*")];
          const el = els.find(
            (e) => e.textContent?.includes("/demo") && e.children.length === 0 && e.offsetParent,
          );
          if (el) {
            el.click();
            return true;
          }
          return false;
        });
        if (clicked) return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 点击包含指定文本的可见元素 */
async function clickText(t) {
  return page.evaluate((t) => {
    const els = [...document.querySelectorAll("button,a,[role=tab],span,div,li")];
    const el = els.find((e) => e.textContent?.trim() === t && e.offsetParent !== null);
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, t);
}

/** 截图并打印 */
async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
}

const mode = process.argv[3] ?? "full";
if (mode === "full") {
  const okDevice = await selectDemoDevice();
  if (!okDevice) console.log("[warn] 15s 内未找到 /demo 设备");
  await new Promise((r) => setTimeout(r, 1500));
  await shot("10-device-selected");
}

// 导出给外部逐步驱动：保持进程由 --idle 模式驻留
if (mode === "idle") {
  const okDevice = await selectDemoDevice();
  console.log("device selected:", okDevice);
  // 简易 REPL：stdin 每行一条命令 JSON {click?, shot?, eval?}
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const cmd = JSON.parse(line);
      if (cmd.deviceClick) {
        await devicePage.evaluate((t) => {
          const els = [...document.querySelectorAll("button,a,[role=button]")];
          const el = els.find((e) => e.textContent?.includes(t));
          if (el) el.click();
          return !!el;
        }, cmd.deviceClick);
      }
      if (cmd.deviceEval) await devicePage.evaluate(cmd.deviceEval);
      if (cmd.click) await clickText(cmd.click);
      if (cmd.sel) await page.click(cmd.sel);
      if (cmd.eval) console.log("eval:", JSON.stringify(await page.evaluate(cmd.eval)));
      if (cmd.wait) await new Promise((r) => setTimeout(r, cmd.wait));
      if (cmd.shot) await shot(cmd.shot);
      if (cmd.exit) process.exit(0);
    } catch (e) {
      console.log("[cmd-error]", e.message);
    }
  }
} else {
  await browser.close();
}
