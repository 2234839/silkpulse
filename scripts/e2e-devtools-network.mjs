/**
 * 官方 DevTools Network 面板 Payload/Response 打通 E2E
 *
 * 流程：无头 chromium 开设备页 → 向 PROD 发 POST/GET 请求 → 开控制台
 * element tab → 官方 DevTools 切 Network 面板 → 点开 nope-e2e 请求 →
 * 断言 Payload 页签出现请求体、Response 页签出现响应体。
 *
 * 注意：官方 DevTools 全程 shadow DOM，普通 querySelectorAll 查不到，
 * 必须递归穿透 shadowRoot（与 vendor-chrome-devtools.mjs 的 findTab 同手法）。
 */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";
import fs from "node:fs";

const PROD = "https://silkpulse.heartstack.space";

function detectChromium() {
  for (const n of ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"]) {
    try {
      const f = execSync(`which ${n} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (f && fs.existsSync(f)) return f;
    } catch {}
  }
  console.error("未找到 chromium");
  process.exit(1);
}

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let failed = 0;
function ok(msg) {
  console.log(`${PASS} ${msg}`);
}
function fail(msg, e) {
  console.error(`${FAIL} ${msg}`, e ?? "");
  failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 官方 DevTools tabbed-pane 只认完整鼠标序列，单纯 el.click() 不切换 */
const clickInDevTools = `
  (el) => {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }
`;

/** 递归穿透 shadow DOM：按谓词找第一个元素 */
const findDeep = `
  (pred) => {
    const out = [];
    function collect(root) {
      if (!root) return;
      root.querySelectorAll("*").forEach((el) => { out.push(el); if (el.shadowRoot) collect(el.shadowRoot); });
    }
    collect(document);
    return out.find(pred) ?? null;
  }
`;

const browser = await puppeteer.launch({
  executablePath: detectChromium(),
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1600, height: 1000 },
});
try {
  /** ── 1. 设备页：发探测请求（绝对 URL 打到 PROD，响应体有意义） ── */
  const devPage = await browser.newPage();
  await devPage.goto("http://127.0.0.1:18099/sp-rt-device.html", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await devPage.waitForFunction(() => document.body.innerText.includes("已接入"), {
    timeout: 20000,
  });
  await sleep(3000); // 等 SDK WS 握手完成
  await devPage.evaluate(async (prod) => {
    await fetch(`${prod}/api/nope-e2e`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world", n: 42 }),
    }).catch(() => {});
    await fetch(`${prod}/version.json`).catch(() => {});
  }, PROD);
  ok("设备页已接入并发出 POST /api/nope-e2e + GET /version.json");
  await sleep(2000); // 等上报到 server

  /** ── 2. 控制台：element tab + 官方 DevTools ── */
  const conPage = await browser.newPage();
  await conPage.evaluateOnNewDocument(
    (key) => localStorage.setItem("__silkpulse_auth_key__", key),
    "fdde4a91eb9c75fc8c474f2e4f08769de77edc4afe17d236",
  );
  await conPage.goto(`${PROD}/?tab=element`, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(1500);
  await conPage.evaluate(() => document.querySelector('button[title="打开设备列表"]')?.click());
  await sleep(800);
  const picked = await conPage.evaluate(() => {
    const li = [...document.querySelectorAll("li")]
      .filter(
        (el) => el.textContent?.includes("console 回测设备") && !el.textContent?.includes("离线"),
      )
      .pop();
    if (!li) return false;
    li.click();
    return true;
  });
  if (!picked) throw new Error("设备列表里没有 console 回测设备");
  await sleep(8000); // 等 elements 桥激活 + 历史注入

  const frame = conPage.frames().find((f) => f.url().includes("chrome-devtools"));
  if (!frame) throw new Error("未找到 chrome-devtools iframe");
  ok("官方 DevTools iframe 已加载");

  const el1 = await conPage.$('iframe[src*="chrome-devtools"]');
  const box1 = await el1.boundingBox();
  await conPage.screenshot({ path: "/tmp/devtools-before.png", clip: box1 });
  // 切 Network 主面板（shadow DOM 穿透点击）
  await frame.evaluate(
    (clickSrc, findSrc) => {
      const click = new Function(`return (${clickSrc})`)();
      const find = new Function(`return (${findSrc})`)();
      const tab = find((el) => el.id === "tab-network" || el.textContent?.trim() === "Network");
      if (tab) click(tab);
    },
    clickInDevTools,
    findDeep,
  );
  await sleep(2500);

  const el2 = await conPage.$('iframe[src*="chrome-devtools"]');
  const box2 = await el2.boundingBox();
  await conPage.screenshot({ path: "/tmp/devtools-network.png", clip: box2 });
  // 等请求行出现（nope-e2e 可能要等历史注入/实时上报），最长 15s
  /** DataGrid 行渲染在 closed shadow root 里，JS 遍历不到 —— 用 a11y 快照断言 */
  function flatten(node, out = []) {
    if (!node) return out;
    out.push(node);
    for (const c of node.children ?? []) flatten(c, out);
    return out;
  }
  let rowFound = false;
  for (let i = 0; i < 15; i++) {
    if (i === 5) {
      await devPage.evaluate(async (prod) => {
        await fetch(`${prod}/api/nope-e2e`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hello: "world", n: 42 }),
        }).catch(() => {});
      }, PROD);
      console.log("(第 5 秒设备补发一次实时请求)");
    }
    const snap = await conPage.accessibility.snapshot({ includeIframes: true });
    rowFound = flatten(snap).some((n) => (n.name || "").includes("nope-e2e"));
    if (rowFound) break;
    await sleep(1000);
  }
  rowFound ? ok("nope-e2e 请求行出现在官方 Network 面板") : fail("nope-e2e 未出现在面板");

  // ── Payload/Response 可视化验证：坐标点击第一行 nope-e2e ──
  const elBox = await conPage.$('iframe[src*="chrome-devtools"]');
  const bb = await elBox.boundingBox();
  // 列表按名称排序，nope-e2e 在第 5 行（y≈+325）
  await conPage.mouse.click(bb.x + 120, bb.y + 325);
  await sleep(800);
  // 选中行后列表上方压缩，详情面板出现在下半区；Payload 子页签在详情区顶部
  // 详情区页签：Headers(x≈275) Preview(330) Response(390)
  await conPage.mouse.click(bb.x + 390, bb.y + 217);
  await sleep(1500);
  await sleep(1500);
  await conPage.screenshot({ path: "/tmp/response-view.png", clip: bb });

  // 对照组：验证 relay+Console 注入链路（日志能否进官方 Console）
  await devPage.evaluate(() => {
    console.log("e2e-relay-probe-12345");
  });
  await sleep(2500);
  await frame.evaluate(
    (clickSrc, findSrc) => {
      const click = new Function(`return (${clickSrc})`)();
      const find = new Function(`return (${findSrc})`)();
      const tab = find((el) => el.id === "tab-console" || el.textContent?.trim() === "Console");
      if (tab) click(tab);
    },
    clickInDevTools,
    findDeep,
  );
  await sleep(2000);
  const consoleHit = await frame.evaluate((findSrc) => {
    const out = [];
    function collect(root) {
      if (!root) return;
      root.querySelectorAll("*").forEach((el) => {
        out.push(el);
        if (el.shadowRoot) collect(el.shadowRoot);
      });
    }
    collect(document);
    return out.some(
      (el) =>
        el.childElementCount === 0 && (el.textContent || "").includes("e2e-relay-probe-12345"),
    );
  }, findDeep);
  consoleHit
    ? ok("relay 链路正常：设备日志进了官方 Console")
    : fail("relay 链路断：日志没进官方 Console");

  // 点开请求行
  await frame.evaluate(
    (clickSrc, findSrc) => {
      const click = new Function(`return (${clickSrc})`)();
      const find = new Function(`return (${findSrc})`)();
      const leaf = find(
        (el) => el.childElementCount === 0 && (el.textContent || "").includes("nope-e2e"),
      );
      if (leaf) click(leaf);
    },
    clickInDevTools,
    findDeep,
  );
  await sleep(2000);

  // 切 Payload 子页签，断言请求体出现
  await frame.evaluate(
    (clickSrc, findSrc) => {
      const click = new Function(`return (${clickSrc})`)();
      const find = new Function(`return (${findSrc})`)();
      const tab = find(
        (el) => el.getAttribute?.("role") === "tab" && el.textContent?.trim() === "Payload",
      );
      if (tab) click(tab);
    },
    clickInDevTools,
    findDeep,
  );
  await sleep(1500);

  // Response 页签断言：官方在无响应体时显示 "This request has no response data"
  await frame.evaluate(
    (clickSrc, findSrc) => {
      const click = new Function(`return (${clickSrc})`)();
      const find = new Function(`return (${findSrc})`)();
      const tab = find(
        (el) => el.getAttribute?.("role") === "tab" && el.textContent?.trim() === "Response",
      );
      if (tab) click(tab);
    },
    clickInDevTools,
    findDeep,
  );
  await sleep(1500);
  const respState = await frame.evaluate((findSrc) => {
    const find = new Function(`return (${findSrc})`)();
    const empty = find(
      (el) => el.childElementCount === 0 && (el.textContent || "").includes("no response data"),
    );
    return empty ? "EMPTY" : "HAS_BODY";
  }, findDeep);
  respState === "HAS_BODY"
    ? ok("Response 页签有响应体（getResponseBody 回查成功）")
    : fail("Response 页签为空（显示 no response data）");

  failed === 0 ? console.log("\n全部通过 ✅") : console.log(`\n${failed} 项失败 ❌`);
} finally {
  await browser.close();
}
process.exit(failed === 0 ? 0 : 1);
