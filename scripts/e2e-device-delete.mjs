/**
 * E2E：设备列表离线设备删除按钮 + 排序验证
 *
 * 流程：注入超管 key 打开控制台 → 选中一个离线设备 → 点击 🗑️ → 接受 confirm
 * → 断言该设备从列表消失。
 */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 依次探测系统可用的 chromium 可执行文件 */
function detectChromium() {
  for (const n of ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"]) {
    try {
      const f = execSync(`which ${n} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (f) return f;
    } catch {}
  }
  console.error("未找到 chromium");
  process.exit(1);
}

const PROD = "https://silkpulse.heartstack.space";
const SUPER_KEY = "fdde4a91eb9c75fc8c474f2e4f08769de77edc4afe17d236";

const browser = await puppeteer.launch({
  executablePath: detectChromium(),
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  userDataDir: mkdtempSync(join(tmpdir(), "sp-e2e-")),
});

function ok(msg) {
  console.log("✓", msg);
}

try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(
    (key) => localStorage.setItem("__silkpulse_auth_key__", key),
    SUPER_KEY,
  );
  await page.goto(`${PROD}/`, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  /** 自动接受 confirm 弹窗（删除前必须提前注册） */
  page.on("dialog", (d) => d.accept());

  /** 小屏/移动布局下设备列表在抽屉里，先点开 */
  await page.evaluate(() =>
    document.querySelector('button[title="打开设备列表"]')?.click(),
  );
  await new Promise((r) => setTimeout(r, 1000));

  /** 读取侧栏设备列表（标题 + 是否含离线徽章） */
  const readList = () =>
    page.evaluate(() => {
      const aside = document.querySelector("aside");
      if (!aside) return null;
      return [...aside.querySelectorAll("li .text-sm.font-medium")].map((el) => ({
        title: el.textContent.trim(),
        offline: el.textContent.includes("离线"),
      }));
    });

  const before = await readList();
  if (!before || before.length === 0) throw new Error("设备列表为空或未找到 aside");
  ok(`列表共 ${before.length} 项`);

  /** 排序断言：一旦出现离线设备，其后不允许再有在线设备 */
  const firstOffline = before.findIndex((d) => d.offline);
  if (firstOffline !== -1) {
    const violation = before.slice(firstOffline).some((d) => !d.offline);
    if (violation) throw new Error("排序错误：离线设备之后仍存在在线设备");
    ok("排序断言通过：在线设备全部排在离线设备之前");
  } else {
    console.log("（无离线设备，跳过排序断言）");
  }

  if (firstOffline === -1) {
    console.log("（无离线设备可删，E2E 结束）");
  } else {
    const target = before[firstOffline];
    // 点击对应 li 内的删除按钮
    const clicked = await page.evaluate((title) => {
      const aside = document.querySelector("aside");
      for (const li of aside.querySelectorAll("li")) {
        const head = li.querySelector(".text-sm.font-medium");
        if (!head || !head.textContent.includes("离线") || !head.textContent.includes(title.split("离线")[0]))
          continue;
        const btn = [...li.querySelectorAll("button")].find((b) => b.title?.includes("删除"));
        if (btn) {
          btn.click();
          return true;
        }
      }
      return false;
    }, target.title);
    if (!clicked) throw new Error("未找到删除按钮");
    ok("已点击删除按钮");

    /** 等 server 广播 device-list 刷新后读列表，断言目标设备消失 */
    await new Promise((r) => setTimeout(r, 3000));
    const after = await readList();
    const gone = !after.some((d) => d.title === target.title);
    if (!gone) throw new Error(`删除失败：「${target.title}」仍在列表中`);
    ok(`删除成功：「${target.title}」已从列表消失`);
  }

  await page.screenshot({ path: "/tmp/devicelist-delete.png" });
} finally {
  await browser.close();
}
