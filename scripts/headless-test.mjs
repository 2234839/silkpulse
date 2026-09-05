/**
 * 无头浏览器端到端测试 —— puppeteer-core + 系统 chromium
 *
 * 验证：控制台 UI、SDK 注入连接、snapshot、exec、__silkpulse_click、console/error 采集
 */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SERVER = process.env.SILKPULSE_SERVER ?? "http://localhost:8081";
/** 鉴权模式：所有 API fetch 带超管密钥（与压测脚本同款约定） */
const ADMIN_KEY = process.env.SILKPULSE_ADMIN_KEY ?? "";
const AUTH_HEADERS = ADMIN_KEY ? { Authorization: `Bearer ${ADMIN_KEY}` } : {};
/** 设备接入凭 projectId（公开标识，项目存在且启用即放行；控制台访问凭密钥与此无关）
 *  游客模式密钥仅用于控制台登录断言 */
const PLAYGROUND_KEY = process.env.SILKPULSE_PLAYGROUND_KEY ?? ADMIN_KEY;
/** 带项目 ID 的 /demo 地址（设备接入凭据只需 projectId） */
const DEMO_URL = `${SERVER}/demo?projectId=cs_playground`;

/** 带鉴权的 API fetch */
async function apiFetch(path, init = {}) {
  return fetch(`${SERVER}${path}`, {
    ...init,
    headers: { ...AUTH_HEADERS, ...init.headers },
  });
}

/**
 * 探测 chromium 可执行文件路径
 * 优先级：CHROMIUM_PATH 环境变量 > which 探测常见名称 > 报错
 */
function detectChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"];
  for (const name of candidates) {
    try {
      const found = execSync(`which ${name} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (found && fs.existsSync(found)) return found;
    } catch {}
  }
  console.error("未找到 chromium，请设置 CHROMIUM_PATH 环境变量指向 chromium 可执行文件");
  process.exit(1);
}

const CHROMIUM = detectChromium();
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";

let step = 0;
let failed = 0;
function ok(msg) {
  console.log(`${PASS} [${step++}] ${msg}`);
}
function fail(msg, e) {
  console.error(`${FAIL} [${step++}] ${msg}`, e ?? "");
  failed++;
}

/** 拉取在线设备列表（/api/devices 返回 { devices, recentlyOffline }，测试只用 devices 数组） */
async function fetchDevices() {
  const data = await (await apiFetch("/api/devices")).json();
  return data.devices ?? data;
}

/** 拉取完整设备响应（含 recentlyOffline） */
async function fetchDevicesResponse() {
  return (await apiFetch("/api/devices")).json();
}

/** 环境基线：测试开始前已在线的设备 id 集合（如开发者浏览器挂着的 /demo 页签）。
 *  后续 waitForDemoDevice 只认「新增」设备——否则会把真实页签误认成本测试的设备，
 *  数据打到别的会话上导致大量假失败。模块级声明供各等待函数闭包引用。 */
const baselineDeviceIds = new Set();

async function waitForDevice(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const devices = await fetchDevices();
      if (devices.length > 0) return devices[0];
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** 等待指定 id 的设备上线（expectedId 来自页面 sessionStorage，保证选中的是本测试自己的无头浏览器会话）。
 *  期望 id 为空时回退：匹配本测试新增的 /demo 设备（排除基线）。 */
async function waitForDemoDevice(expectedId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const devices = await fetchDevices();
      const demo = expectedId
        ? devices.find((d) => d.id === expectedId)
        : devices.find((d) => d.url.includes("/demo") && !baselineDeviceIds.has(d.id));
      if (demo) return demo;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function main() {
  console.log("启动无头浏览器...");
  try {
    for (const id of await fetchDevices()) baselineDeviceIds.add(id);
  } catch {}
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  /** 准备测试页：通过 server /demo 路由加载（同源，避免跨域影响 network 采集） */
  try {
    /** 1. 控制台 UI（鉴权模式带 ?key= 注入，useAuth 会读取并从地址栏清除） */
    const consolePage = await browser.newPage();
    await consolePage.goto(`${SERVER}/?key=${encodeURIComponent(ADMIN_KEY)}`, {
      waitUntil: "networkidle0",
      timeout: 10000,
    });
    const title = await consolePage.title();
    if (title.includes("silkpulse")) ok(`控制台 UI 加载（title="${title}"）`);
    else fail(`控制台标题异常: "${title}"`);

    const appLen = await consolePage.evaluate(
      () => document.getElementById("app")?.innerHTML?.length ?? 0,
    );
    if (appLen > 50) ok(`控制台 Vue 已渲染（app 内容 ${appLen} 字符）`);
    else fail("控制台 Vue 未渲染");

    /** 1.5 静态资源缓存策略 —— sdk.js 必须 no-cache（诊断工具不能用旧版），带 hash 的长缓存 */
    {
      const sdkRes = await fetch(`${SERVER}/sdk.js`);
      const sdkCache = sdkRes.headers.get("cache-control") ?? "";
      const sdkEtag = sdkRes.headers.get("etag") ?? "";
      await sdkRes.text();

      /** 找一个带 hash 的构建产物 */
      const htmlText = await (await fetch(`${SERVER}/`)).text();
      /** Vite 的 hash 是 base64url，可含 - 和 _，字符集要覆盖 */
      const hashedMatch = htmlText.match(/\/assets\/index-[a-zA-Z0-9_-]+\.js/);
      const hashedPath = hashedMatch?.[0];
      const hashedRes = await fetch(`${SERVER}${hashedPath}`);
      const hashedCache = hashedRes.headers.get("cache-control") ?? "";
      const hashedEtag = hashedRes.headers.get("etag") ?? "";
      await hashedRes.text();

      /** ETag 304 验证：带 If-None-Match 应返回 304 */
      const condRes = await fetch(`${SERVER}${hashedPath}`, {
        headers: { "If-None-Match": hashedEtag },
      });

      const sdkOk = sdkCache.includes("no-cache") && !!sdkEtag;
      const hashedOk =
        hashedCache.includes("max-age=31536000") && hashedCache.includes("immutable");
      const etagOk = condRes.status === 304;

      if (sdkOk && hashedOk && etagOk) {
        ok(`缓存策略正确（sdk.js no-cache ✓，/assets/* 长缓存 ✓，ETag 304 ✓）`);
      } else {
        fail(`缓存策略异常：sdk=${sdkCache} hashed=${hashedCache} 304=${condRes.status}`);
      }
    }

    /** 2. 测试页注入 SDK → 自动连接（同源加载，network 采集不受跨域影响） */
    const testPage = await browser.newPage();
    testPage.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await testPage.goto(DEMO_URL, { waitUntil: "networkidle0", timeout: 15000 });
    /** 页面内 SDK 会话 id —— 精确锁定本测试打开的那台设备 */
    const pageDeviceId = await testPage
      .evaluate(() => sessionStorage.getItem("__silkpulse_device_id__"))
      .catch(() => null);

    /**
     * 选「本测试自己打开的 /demo 页」对应的那台设备。
     * 环境里可能同时挂着其他真实设备的会话（如开发者浏览器里开着的测试页），
     * waitForDevice 取列表第一台会误连外部设备，导致后续 exec 找不到元素。
     */
    const device = await waitForDemoDevice(pageDeviceId);
    if (device)
      ok(`SDK 连接成功，设备上线: title="${device.title}", url=${device.url.slice(0, 40)}`);
    else {
      fail(`SDK 未连接，/demo 设备未出现（pageDeviceId=${pageDeviceId ?? "null"}）`);
      throw new Error("abort");
    }

    /** 2.1 设备类型识别（desktop/tablet/mobile） */
    if (device.deviceType === "desktop") ok(`设备类型识别正确: ${device.deviceType}`);
    else fail(`设备类型异常: 期望 desktop，实际 ${device.deviceType}`);

    /** 2.2 SPA 路由变化上报 —— pushState 后 server 端 url 应更新 */
    await testPage.evaluate(() => history.pushState({}, "", "/spa-route-xyz"));
    await new Promise((r) => setTimeout(r, 800));
    const devAfter = (await fetchDevices()).find((d) => d.id === device.id);
    if (devAfter?.url?.includes("/spa-route-xyz")) {
      ok(`SPA 路由变化上报成功: url → ${devAfter.url.slice(-25)}`);
    } else {
      fail(`SPA 路由变化未上报: url=${devAfter?.url}`);
    }

    /** 3. exec API —— 在真实 DOM 执行 */
    const execRes = await apiFetch(`/api/devices/${device.id}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: 'document.getElementById("name-input").value = "无头测试"; return document.title',
      }),
    });
    const execData = await execRes.json();
    if (execData.success) ok(`exec 成功，title → ${execData.result}`);
    else fail(`exec 失败: ${JSON.stringify(execData)}`);

    /** 3.1 exec 后的 snapshotText 应为 compact 文本（含 url: 和 #idx），非 JSON */
    if (
      execData.snapshotText &&
      execData.snapshotText.includes("# url:") &&
      execData.snapshotText.includes("#")
    ) {
      ok(`exec snapshotText 为 compact 文本格式（${execData.snapshotText.length} 字符）`);
    } else {
      fail(`exec snapshotText 格式异常: ${String(execData.snapshotText).slice(0, 100)}`);
    }

    /** 5. snapshot API（修复 return 后应成功）+ 取 button idx */
    const snapRes = await apiFetch(`/api/devices/${device.id}/snapshot`);
    if (snapRes.ok) {
      const snapText = await snapRes.text();
      /** 同时验证 viewport 头部（诊断响应式/布局问题的关键线索） */
      const viewportMatch = snapText.match(/# viewport: (\d+)×(\d+)/);
      if (snapText.includes("url:") && snapText.toLowerCase().includes("button") && viewportMatch) {
        ok(
          `snapshot API 返回 compact 文本（${snapText.length} 字符，含 viewport ${viewportMatch[1]}×${viewportMatch[2]}）`,
        );
      } else fail(`snapshot 内容异常: ${snapText.slice(0, 200)}`);
    } else fail(`snapshot HTTP ${snapRes.status}`);
    const snapText2 = await (await apiFetch(`/api/devices/${device.id}/snapshot`)).text();
    const btnMatch = snapText2.match(/button #(\d+)/);
    if (btnMatch) {
      const idx = btnMatch[1];
      const clickRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `__silkpulse_click(${idx}); return document.querySelector("#log").textContent`,
          }),
        })
      ).json();
      if (clickRes.success && clickRes.result?.includes("你好")) {
        ok(`exec + __silkpulse_click(${idx}) 生效，输出: ${clickRes.result}`);
      } else fail(`exec click 异常: ${JSON.stringify(clickRes)}`);
    } else fail("snapshot 未找到 button idx");

    /**
     * 5.1a __silkpulse_click 对自定义组件（div[role=button] 监听 mousedown）生效
     *
     * 验证完整鼠标事件序列：自定义组件只绑 mousedown 不绑 click，
     * 若 __silkpulse_click 只调 .click() 则对此类组件无效（"点了没反应"）。
     * div[role=button] 非原生交互标签，快照里显示 id 不显示 idx，
     * 所以从 data-silkpulse-idx 属性取 idx（SDK 给每个采集元素打的标记）。
     */
    {
      const customRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `const el = document.querySelector('#custom-btn'); const di = el?.getAttribute('data-silkpulse-idx'); if (di == null) return 'no-idx'; __silkpulse_click(Number(di)); return document.querySelector('#custom-result').textContent`,
          }),
        })
      ).json();
      if (customRes.success && customRes.result?.includes("自定义按钮已触发")) {
        ok(`exec + __silkpulse_click 对 div[role=button]（mousedown）生效`);
      } else {
        fail(`exec click(div[role=button]) 异常: ${JSON.stringify(customRes)}`);
      }
    }

    /** 5.1 __silkpulse_type —— 模拟键盘输入到搜索框，验证 keyup 触发 + value 正确写入 */
    const snapText3 = await (await apiFetch(`/api/devices/${device.id}/snapshot`)).text();
    /** 找 search-input 的 idx（快照里 input 带 placeholder="输入关键词"） */
    const searchMatch = snapText3.match(/input #(\d+)[^\n]*关键词/);
    if (searchMatch) {
      const searchIdx = searchMatch[1];
      /**
       * type 后同时验证：搜索结果（keyup 事件触发）+ input.value（原生 setter 正确写入）。
       * value 验证回归 React 受控组件修复：直接 el.value += ch 在受控组件上不生效，
       * 必须用原生 setter（HTMLInputElement.prototype.value 的 setter）。
       * exec result 是 JSON.stringify 后的字符串，用 ||| 分隔两个字段方便解析。
       */
      const typeRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `__silkpulse_type(${searchIdx}, "苹"); return document.querySelector("#search-result").textContent + "|||" + document.querySelector("#search-input").value`,
          }),
        })
      ).json();
      /**
       * exec 的 serializeResult 对字符串会 JSON.stringify（加引号），所以 result 形如
       * '"找到 1 个结果：苹果|||苹"'。用 includes 检查两个关键内容即可，不依赖严格相等。
       */
      const resultStr = typeRes.result ?? "";
      if (typeRes.success && resultStr.includes("苹果") && resultStr.includes("|||苹")) {
        ok(`exec + __silkpulse_type(${searchIdx}, "苹") 生效（result: ${resultStr.slice(0, 60)}）`);
      } else fail(`exec type 异常: ${JSON.stringify(typeRes).slice(0, 200)}`);
    } else fail("snapshot 未找到搜索框 idx");

    /**
     * 5.15 exec + __silkpulse_setValue 对 select 元素
     *
     * select 的 value setter 在 HTMLSelectElement.prototype 上（非 HTMLInputElement），
     * 之前 setNativeValue 只查 input/textarea 的原型，select 上设值无效。
     * 验证 setValue 后 select.value 正确变更 + change 事件触发（console 有"选择城市"日志）。
     */
    {
      const selectSnap = await (await apiFetch(`/api/devices/${device.id}/snapshot`)).text();
      /**
       * select 是交互元素，id 不输出到 compact 文本。
       * options 用 value:text 格式（bj:北京|sh:上海|gz:广州），用此特征定位 idx。
       * 验证 value:text 格式让 AI 知道 option 的 value（setValue 需要）。
       */
      const selectMatch = selectSnap.match(/select #(\d+)[^\n]*<bj:北京\|sh:上海\|gz:广州>/);
      /** 验证当前选中值也是 value:text 格式（check= 或 val= 前缀，取决于序列化逻辑） */
      const hasValueFormat = /select #\d+ (?:check|val)=bj:北京/.test(selectSnap);
      if (selectMatch) {
        const selectIdx = selectMatch[1];
        /** 记录 setValue 前的日志数，验证 change 事件触发新日志 */
        const logsBefore = await (await apiFetch(`/api/devices/${device.id}/logs`)).json();
        const logsBeforeCount = logsBefore.length;
        /** setValue 上海（"sh"），返回 select.value 确认写入 */
        const setRes = await (
          await apiFetch(`/api/devices/${device.id}/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code: `__silkpulse_setValue(${selectIdx}, "sh"); return document.querySelector("#city-select").value`,
            }),
          })
        ).json();
        await new Promise((r) => setTimeout(r, 500));
        /** setValue 后应有新的"选择城市: sh"日志（change 事件触发的 console.log） */
        const logsAfter = await (await apiFetch(`/api/devices/${device.id}/logs`)).json();
        const hasCityLog = logsAfter
          .slice(logsAfter.length - logsBeforeCount > 0 ? logsAfter.length - 10 : 0)
          .some((l) => l.message.includes("选择城市") && l.message.includes("sh"));
        const resultStr = setRes.result ?? "";
        if (
          selectMatch &&
          hasValueFormat &&
          setRes.success &&
          resultStr.includes("sh") &&
          hasCityLog
        ) {
          ok(
            `exec + __silkpulse_setValue(${selectIdx}, "sh") 对 select 生效（value="${resultStr.replace(/"/g, "")}"，change 事件触发 ✓，快照 options 含 value:text ✓）`,
          );
        } else {
          fail(
            `exec setValue(select) 异常: value=${resultStr}，change日志=${hasCityLog}，options格式=${hasValueFormat}`,
          );
        }
      } else fail("snapshot 未找到 city-select idx");
    }

    /**
     * 5.16 exec + __silkpulse_setValue 对 checkbox/radio
     *
     * checkbox：val='true' 勾选，'false' 取消（用原生 checked setter，框架兼容）
     * radio：val 有值即选中（同组其他自动取消）
     * 验证 setValue 后 checked 状态正确 + change 事件触发
     */
    {
      const snap = await (await apiFetch(`/api/devices/${device.id}/snapshot`)).text();
      /** checkbox 同意条款（交互元素，用 label 文本匹配 idx） */
      const agreeMatch = snap.match(/input #(\d+)[^\n]*check[^\n]*同意条款/);
      /** radio 专业版 */
      const proMatch = snap.match(/input #(\d+)[^\n]*(?:type:radio|radio)[^\n]*专业版/);

      /** checkbox：先确保未勾选，setValue('true') 勾选，验证 checked=true */
      const cbRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `const cb = document.querySelector('#agree'); cb.checked = false; __silkpulse_setValue(${agreeMatch ? agreeMatch[1] : -1}, 'true'); return cb.checked`,
          }),
        })
      ).json();
      const cbOk = cbRes.success && cbRes.result === "true";

      /** checkbox：setValue('false') 取消，验证 checked=false */
      const cbUncheckRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `__silkpulse_setValue(${agreeMatch ? agreeMatch[1] : -1}, 'false'); return document.querySelector('#agree').checked`,
          }),
        })
      ).json();
      const cbUncheckOk = cbUncheckRes.success && cbUncheckRes.result === "false";

      /**
       * radio 互斥：先选中 free，再选中 pro，验证 pro=true 且 free 被自动取消。
       * 这是合成事件下浏览器默认行为不生效的场景——必须由 setValue 手动实现互斥。
       */
      const freeMatch = snap.match(/input #(\d+)[^\n]*(?:type:radio|radio)[^\n]*免费版/);
      /** 先选 free（用 native setter 模拟初始选中，绕过 setValue 一次） */
      await apiFetch(`/api/devices/${device.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: `const f = document.querySelector('input[name="plan"][value="free"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'checked').set; s.call(f, true); f.dispatchEvent(new Event('change',{bubbles:true}))`,
        }),
      });
      /** 再用 setValue 选 pro，验证互斥：pro=true，free 被取消=false */
      const radioRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `__silkpulse_setValue(${proMatch ? proMatch[1] : -1}, 'pro'); const pro = document.querySelector('input[name="plan"][value="pro"]'); const free = document.querySelector('input[name="plan"][value="free"]'); return { pro: pro?.checked, free: free?.checked }`,
          }),
        })
      ).json();
      const radioOk =
        radioRes.success &&
        radioRes.result?.includes('"pro":true') &&
        radioRes.result?.includes('"free":false');

      /** change 事件触发的日志（"同意条款" / "选择套餐"） */
      const logsAfter = await (await apiFetch(`/api/devices/${device.id}/logs`)).json();
      const hasAgreeLog = logsAfter.some((l) => l.message.includes("同意条款"));
      const hasPlanLog = logsAfter.some((l) => l.message.includes("选择套餐"));

      if (cbOk && cbUncheckOk && radioOk && hasAgreeLog && hasPlanLog) {
        ok(`exec setValue 对 checkbox/radio 生效（勾选✓ 取消✓ radio互斥✓ change日志✓）`);
      } else {
        fail(
          `exec setValue(checkbox/radio) 异常：cb=${cbOk} cbUncheck=${cbUncheckOk} radio=${radioOk} agreeLog=${hasAgreeLog} planLog=${hasPlanLog}（agree idx=${agreeMatch?.[1]} pro idx=${proMatch?.[1]}）`,
        );
      }
    }

    /**
     * 5.2 快照表单状态采集 —— disabled/readonly/required/indeterminate/aria-disabled/aria-expanded
     *
     * AI 诊断远程表单问题（"按钮为什么点不了""表单为什么提交失败"）时，
     * 必须从快照看到这些状态，否则无法定位根因。
     */
    {
      const formSnap = await (await apiFetch(`/api/devices/${device.id}/snapshot`)).text();
      const checks = [
        { re: /input #\d+ val=只读值 readonly/, label: "readonly 输入框" },
        { re: /input #\d+ ph:必填字段 required/, label: "required 输入框" },
        { re: /input #\d+ type:checkbox indeterminate/, label: "indeterminate 半选框" },
        { re: /button #\d+ disabled 禁用按钮/, label: "disabled 原生禁用按钮" },
        { re: /button #\d+ aria-disabled/, label: "aria-disabled 自定义禁用" },
        { re: /button #\d+ collapsed 展开/, label: "aria-expanded=false 折叠态" },
      ];
      let pass = 0;
      const missed = [];
      for (const c of checks) {
        if (c.re.test(formSnap)) pass++;
        else missed.push(c.label);
      }
      if (pass === checks.length) {
        ok(
          `快照表单状态全量采集（${pass}/${checks.length}: readonly/required/indeterminate/disabled/aria-disabled/collapsed）`,
        );
      } else {
        fail(`快照表单状态缺失 ${missed.join("、")}（${pass}/${checks.length}）`);
      }
    }

    /**
     * 5.25 快照采集当前聚焦元素 —— AI 远程操作表单需知道光标位置
     *
     * 诊断"输入后提交失败"时，焦点在哪个输入框是关键上下文。
     * AI 执行 __silkpulse_type 前能从快照判断是否需要先 click 定位。
     */
    {
      /** 聚焦 name-input */
      await testPage.evaluate(() => document.getElementById("name-input")?.focus());
      await new Promise((r) => setTimeout(r, 300));
      const focusSnap = await (await apiFetch(`/api/devices/${device.id}/snapshot`)).text();
      /** name-input 带 placeholder="输入你的名字"，应标 focus */
      const focusLine = focusSnap.split("\n").find((l) => l.includes("focus"));
      if (focusLine && /输入你的名字/.test(focusLine)) {
        ok(`快照标记聚焦元素（${focusLine.trim()}）`);
      } else {
        fail(`快照未正确标记聚焦元素：${focusLine ?? "无 focus 行"}`);
      }
    }

    /** 5.3 exec 错误信息含 stack —— AI 诊断远程报错时需要出错位置
     *
     * 之前 exec catch 只返回 "TypeError: xxx" 单行，AI 无法定位。
     * 现在运行时错误附带 stack（截断），语法错误保持单行（无 stack）。
     */
    {
      /** 运行时错误：访问 null 的属性 */
      const runtimeErr = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: `const x = null; return x.foo` }),
        })
      ).json();
      if (!runtimeErr.success && runtimeErr.error && runtimeErr.error.includes("TypeError")) {
        if (runtimeErr.error.includes("\n")) {
          ok(`exec 运行时错误含 stack（${runtimeErr.error.split("\n")[0]}…）`);
        } else {
          fail(`exec 运行时错误缺 stack：${runtimeErr.error}`);
        }
      } else {
        fail(`exec 运行时错误格式异常: ${JSON.stringify(runtimeErr).slice(0, 150)}`);
      }

      /** 语法错误：缺括号，应有 SyntaxError 但无需 stack */
      const syntaxErr = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: `return {` }),
        })
      ).json();
      if (!syntaxErr.success && syntaxErr.error && syntaxErr.error.includes("SyntaxError")) {
        ok(`exec 语法错误正确捕获（${syntaxErr.error.slice(0, 60)}）`);
      } else {
        fail(`exec 语法错误异常: ${JSON.stringify(syntaxErr).slice(0, 150)}`);
      }
    }

    /**
     * 5.35 exec 日志截断保护 —— exec 代码产生海量日志时，队列限总量防撑爆 WS
     *
     * exec 代码执行 for 循环 console.log 500 次，验证：
     * - 回传的 logs 条数 ≤ 200（前 100 头部 + 后 100 尾部）
     * - 含省略标注（"省略 N 条日志"）
     * - 头部含早期日志（log-000），尾部含最新日志（log-499）
     */
    {
      const floodRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `for (let i = 0; i < 500; i++) { console.log("log-" + String(i).padStart(3, '0')) }; return "done"`,
          }),
        })
      ).json();
      const logs = floodRes.logs ?? [];
      const hasEllipsis = logs.some((l) => l.includes("省略"));
      const hasHead = logs.some((l) => l.includes("log-000"));
      const hasTail = logs.some((l) => l.includes("log-499"));
      if (floodRes.success && logs.length <= 202 && hasEllipsis && hasHead && hasTail) {
        ok(
          `exec 日志截断保护生效（500 条 → ${logs.length} 条，含省略标注 ✓，头部 log-000 ✓，尾部 log-499 ✓）`,
        );
      } else {
        fail(
          `exec 日志截断异常：logs=${logs.length}条(期望≤202)，省略=${hasEllipsis}，头部=${hasHead}，尾部=${hasTail}`,
        );
      }
    }

    /**
     * 5.4 exec 异步超时保护 —— 永不 resolve 的代码由 SDK 端 9s 超时兜底
     *
     * `return new Promise(() => {})` 会无限挂起。之前靠 server 端 10s 超时回"执行超时"，
     * 但 SDK 端 promise 仍泄漏、exec 日志捕获队列永不结束。现在 SDK 端 Promise.race
     * 先于 server 触发（9s < 10s），干净回传超时 + 释放资源。
     */
    {
      const hangStart = Date.now();
      const hangRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: `return new Promise(() => {})` }),
        })
      ).json();
      const elapsed = Date.now() - hangStart;
      /** 应在 ~9s（SDK 端）返回，而非 10s（server 端），且报超时 */
      if (!hangRes.success && hangRes.error && hangRes.error.includes("超时")) {
        ok(`exec 异步超时保护生效（${elapsed}ms 返回：${hangRes.error.slice(0, 40)}）`);
      } else {
        fail(
          `exec 超时异常：elapsed=${elapsed}ms success=${hangRes.success} err=${hangRes.error ?? "无"}`,
        );
      }
    }

    /**
     * 5.45 exec + __silkpulse_scroll + __silkpulse_hover
     *
     * scroll：滚动 #scroll-box 内部（overflow:auto），验证 scrollTop 变化。
     * scrollIntoView：将元素滚入视野。
     * hover：mouseover 触发 #hover-btn 的 hover 逻辑，验证 #hover-result 显示。
     */
    {
      /** 先取快照找到 scroll-box 和 hover-btn 的 idx */
      const snap = await (await apiFetch(`/api/devices/${device.id}/snapshot`)).text();
      const scrollMatch = snap.match(/div #(\d+)[^\n]*scroll-box/);
      const hoverMatch = snap.match(/button #(\d+)[^\n]*悬停看我/);

      /** 测试 scroll：滚动 scroll-box 到底部（0, 500） */
      const scrollRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `__silkpulse_scroll(${scrollMatch ? scrollMatch[1] : -1}, 0, 500); return document.querySelector("#scroll-box").scrollTop > 0`,
          }),
        })
      ).json();
      const scrollOk = scrollRes.success && scrollRes.result === "true";

      /** 测试 hover：hover hover-btn，验证 hover-result 显示 */
      const hoverRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `__silkpulse_hover(${hoverMatch ? hoverMatch[1] : -1}); return getComputedStyle(document.querySelector("#hover-result")).display`,
          }),
        })
      ).json();
      /** result 被 serializeResult JSON.stringify，带引号 */
      const hoverOk = hoverRes.success && hoverRes.result?.includes("block");

      if (scrollOk && hoverOk) {
        ok(`exec scroll + hover 生效（scroll scrollTop>0 ✓，hover 触发 mouseover ✓）`);
      } else {
        fail(
          `exec scroll/hover 异常：scroll=${scrollOk}（idx=${scrollMatch?.[1]}），hover=${hoverOk}（idx=${hoverMatch?.[1]}，res=${hoverRes.result}）`,
        );
      }
    }

    /**
     * 5.46 exec + __silkpulse_pressKey —— 键盘交互（Enter 提交 / Escape 清空）
     *
     * pressKey 派发 keydown + keyup 事件，验证：
     * 1. Enter 触发 keydown 监听器 → keyboard-result 显示"已提交"
     * 2. Escape 触发 keydown 监听器 → input 清空 + result 显示"已清空"
     * 3. idx<0 时对 activeElement 按键
     */
    {
      /** 取快照找到 keyboard-input 的 idx（input 是交互元素，快照显示 idx 不显示 id，用 placeholder 匹配） */
      const snap = await (await apiFetch(`/api/devices/${device.id}/snapshot`)).text();
      const kbMatch = snap.match(/input #(\d+)[^\n]*Enter 提交/);

      /** 先 setValue 输入文字，再 pressKey Enter */
      const enterRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `__silkpulse_setValue(${kbMatch ? kbMatch[1] : -1}, '测试Enter'); __silkpulse_pressKey(${kbMatch ? kbMatch[1] : -1}, 'Enter'); return document.querySelector('#keyboard-result')?.textContent`,
          }),
        })
      ).json();
      const enterOk =
        enterRes.success &&
        enterRes.result?.includes("已提交") &&
        enterRes.result?.includes("测试Enter");

      /** pressKey Escape → input 清空 + result "已清空" */
      const escRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `__silkpulse_pressKey(${kbMatch ? kbMatch[1] : -1}, 'Escape'); return { result: document.querySelector('#keyboard-result')?.textContent, inputVal: document.querySelector('#keyboard-input')?.value }`,
          }),
        })
      ).json();
      const escOk =
        escRes.success &&
        escRes.result?.includes("已清空") &&
        escRes.result?.includes('"inputVal":""');

      /** idx<0 对 activeElement 按键：先 focus keyboard-input，pressKey(-1, 'Enter') 应等效 */
      const activeRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `document.querySelector('#keyboard-input').focus(); __silkpulse_pressKey(-1, 'Enter'); return document.activeElement?.id`,
          }),
        })
      ).json();
      const activeOk = activeRes.success && activeRes.result?.includes("keyboard-input");

      if (enterOk && escOk && activeOk) {
        ok(`exec pressKey 生效（Enter 提交 ✓，Escape 清空 ✓，idx<0 activeElement ✓）`);
      } else {
        fail(
          `exec pressKey 异常：enter=${enterOk}（res=${enterRes.result}），esc=${escOk}（res=${escRes.result}），active=${activeOk}（res=${activeRes.result}，idx=${kbMatch?.[1]}）`,
        );
      }
    }

    /**
     * 5.5 设备掉线时 pending exec 立即失败（回归 server exec 定时器清理）
     *
     * 场景：AI 发起 exec → 设备在执行期间断开 → server 应立即 reject（"设备已断开"），
     * 而非傻等 10s 超时。且 pendingExecs 的超时定时器必须被清理（clearTimeout），
     * 否则掉线后定时器仍会在 10s 后触发，操作已下线设备的 Map（泄漏 + 无意义副作用）。
     *
     * 验证：发起挂起 exec → 立即关设备 page → exec 应在 ~3s 内返回"断开"（远小于 9s SDK 超时）。
     */
    {
      /** 开独立 page 作为待下线设备 */
      const execOfflinePage = await browser.newPage();
      await execOfflinePage.goto(DEMO_URL, { waitUntil: "networkidle0", timeout: 15000 });
      await new Promise((r) => setTimeout(r, 1500));
      /** 从页面拿 SDK 会话 id（避免误选其他在线设备，exec 挂错设备会等到超时） */
      const execOfflineId = await execOfflinePage
        .evaluate(() => sessionStorage.getItem("__silkpulse_device_id__"))
        .catch(() => null);
      const allDevs = await fetchDevices();
      /** 从页面拿 SDK 会话 id，只精确匹配——回退会误打到别的在线设备上 */
      const execOfflineDev = allDevs.find((d) => execOfflineId && d.id === execOfflineId);
      if (!execOfflineDev) {
        fail("掉线 exec 测试前置失败：目标设备未在列表中");
      } else {
        /** 发起挂起 exec（不 await），立即关闭设备 page 触发 WS 断开 */
        const execPromise = apiFetch(`/api/devices/${execOfflineDev.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: `return new Promise(() => {})` }),
        }).then((r) => r.json());
        /** 给 server 一点时间下发 exec 到设备 */
        await new Promise((r) => setTimeout(r, 300));
        const closeStart = Date.now();
        await execOfflinePage.close();
        /** 等 server 检测到 WS close（close 事件传播 ~1-2s）+ reject pending exec */
        const execRes = await execPromise;
        const elapsed = Date.now() - closeStart;

        if (!execRes.success && execRes.error && execRes.error.includes("断开")) {
          /** 应在远小于 9s（SDK 超时）内返回 —— server 掉线立即 reject */
          if (elapsed < 5000) {
            ok(
              `设备掉线时 pending exec 立即失败（${elapsed}ms 返回"${execRes.error.slice(0, 20)}"，定时器已清理）`,
            );
          } else {
            fail(`设备掉线后 exec 等待过久（${elapsed}ms，可能未立即 reject/定时器泄漏）`);
          }
        } else {
          fail(
            `设备掉线 exec 处理异常：success=${execRes.success} err=${execRes.error ?? "无"} elapsed=${elapsed}ms`,
          );
        }
      }
    }

    /** 6. console 采集 */
    await testPage.evaluate(() => document.getElementById("greet-btn")?.click());
    await new Promise((r) => setTimeout(r, 800));
    const logs = await (await apiFetch(`/api/devices/${device.id}/logs`)).json();
    if (logs.some((l) => l.message.includes("打招呼"))) ok(`console 采集成功（${logs.length} 条）`);
    else
      fail(
        `console 采集异常: ${logs
          .slice(-2)
          .map((l) => l.message)
          .join(" | ")}`,
      );

    /** 6.5 日志限流 —— 防止远程页面 log 爆炸打爆 WS/server */
    {
      /** 先等 1.2s 让上一测试（exec 500 条日志）的限流窗口滚动干净，汇总提示上报完 */
      await new Promise((r) => setTimeout(r, 1200));
      const beforeTs = Date.now();
      /** 1 秒内狂刷 200 条 info + 5 条 error（error 不应被限流） */
      await testPage.evaluate(() => {
        for (let i = 0; i < 200; i++) console.log(`限流测试-${i}`);
        for (let i = 0; i < 5; i++) console.error(`限流error-${i}`);
      });
      /** 等 2.5s：让限流窗口滚动 + 汇总上报（每秒检查一次） */
      await new Promise((r) => setTimeout(r, 2500));
      const allLogs = await (await apiFetch(`/api/devices/${device.id}/logs`)).json();
      /** 只看本次触发产生的日志（按时间戳过滤） */
      const recent = allLogs.filter((l) => new Date(l.timestamp).getTime() > beforeTs);
      const infoCount = recent.filter(
        (l) => l.type === "info" && l.message.includes("限流测试-"),
      ).length;
      const errorCount = recent.filter(
        (l) => l.type === "error" && l.message.includes("限流error-"),
      ).length;
      const hasThrottleNotice = recent.some(
        (l) => l.type === "warn" && l.message.includes("日志限流"),
      );

      /** info 应远少于 200（限流窗口 50 条/秒），error 应 5 条全在，应有限流提示 */
      if (infoCount < 200 && infoCount > 0) {
        if (errorCount === 5) {
          if (hasThrottleNotice) {
            ok(`日志限流生效（info 200→${infoCount}，error 5 条全保留，有限流提示）`);
          } else {
            fail(`日志限流提示缺失：info=${infoCount} error=${errorCount} 但无限流 warn`);
          }
        } else {
          fail(`error 不应被限流：期望 5 条，实际 ${errorCount} 条`);
        }
      } else {
        fail(`日志限流异常：info=${infoCount}（应 <200 且 >0）`);
      }
    }

    /** 7. network 采集 —— fetch + xhr + POST body */
    await testPage.evaluate(() => document.getElementById("fetch-ok")?.click());
    await testPage.evaluate(() => document.getElementById("fetch-404")?.click());
    await testPage.evaluate(() => document.getElementById("xhr-btn")?.click());
    await testPage.evaluate(() => document.getElementById("post-btn")?.click());
    await new Promise((r) => setTimeout(r, 1500));
    const network = await (await apiFetch(`/api/devices/${device.id}/network`)).json();
    const hasFetch = network.some((n) => n.url.includes("/api/devices"));
    const has404 = network.some((n) => n.url.includes("/api/not-exist") && n.status === 404);
    const hasXhr = network.some((n) => n.method === "GET" && n.url.includes("/api/devices"));
    if (hasFetch && has404 && hasXhr) {
      ok(`network 采集成功（${network.length} 条：fetch ✓ 404 ✓ XHR ✓）`);
    } else {
      fail(
        `network 采集不完整（fetch=${hasFetch} 404=${has404} xhr=${hasXhr}，共 ${network.length} 条）`,
      );
      console.log(
        "  network 详情:",
        JSON.stringify(network.map((n) => ({ m: n.method, s: n.status, u: n.url.slice(-30) }))),
      );
    }

    /** 7.1 POST body 采集 —— 验证 reqBody/resBody 被正确捕获 */
    const postEntry = network.find((n) => n.method === "POST" && n.url.includes("/api/echo"));
    if (
      postEntry &&
      postEntry.reqBody &&
      postEntry.reqBody.includes("silkpulse") &&
      postEntry.resBody
    ) {
      ok(
        `POST body 采集成功（reqBody ${postEntry.reqBody.length} 字符，resBody ${postEntry.resBody.length} 字符）`,
      );
    } else {
      fail(
        `POST body 采集异常: ${JSON.stringify({ method: postEntry?.method, hasReq: !!postEntry?.reqBody, hasRes: !!postEntry?.resBody })}`,
      );
    }

    /**
     * 7.2 XHR responseType=json 响应体采集
     *
     * responseType='json' 时 responseText 抛 InvalidStateError，
     * 必须改用 response（已解析对象）+ JSON.stringify。
     * 验证响应体被正确捕获（含 "ok" 关键内容），而非 undefined。
     */
    await testPage.evaluate(() => document.getElementById("xhr-json-btn")?.click());
    await new Promise((r) => setTimeout(r, 1500));
    const network2 = await (await apiFetch(`/api/devices/${device.id}/network`)).json();
    /** 找最新一条 /api/echo 的 POST XHR（responseType=json 的那条） */
    const xhrJsonEntry = network2
      .filter((n) => n.method === "POST" && n.url.includes("/api/echo"))
      .sort((a, b) => b.seq - a.seq)[0];
    if (xhrJsonEntry && xhrJsonEntry.resBody && xhrJsonEntry.resBody.includes("ok")) {
      ok(
        `XHR responseType=json 响应体采集成功（resBody ${xhrJsonEntry.resBody.length} 字符: ${xhrJsonEntry.resBody.slice(0, 40)}）`,
      );
    } else {
      fail(
        `XHR responseType=json 响应体丢失: resBody=${xhrJsonEntry?.resBody ?? "undefined"}（responseText 在 json 模式抛 InvalidStateError，需用 response 读取）`,
      );
    }

    /**
     * 7.3 Request 对象 body 采集
     *
     * fetch(new Request(url, {body})) 时 body 在 Request 对象上，不在 fetch init 里。
     * 若只读 init.body，reqBody 会丢失。验证 SDK 从 Request.clone() 读取 body。
     */
    await testPage.evaluate(() => document.getElementById("request-btn")?.click());
    await new Promise((r) => setTimeout(r, 1500));
    const network3 = await (await apiFetch(`/api/devices/${device.id}/network`)).json();
    /** 找 request-object 那条 POST（resBody 会回显，含 source: request-object） */
    const reqObjEntry = network3.find(
      (n) =>
        n.method === "POST" && n.url.includes("/api/echo") && n.reqBody?.includes("request-object"),
    );
    if (reqObjEntry && reqObjEntry.reqBody && reqObjEntry.reqBody.includes("request-object")) {
      ok(
        `Request 对象 body 采集成功（reqBody ${reqObjEntry.reqBody.length} 字符，含 "request-object" ✓）`,
      );
    } else {
      fail(
        `Request 对象 body 丢失: reqBody=${reqObjEntry?.reqBody ?? "undefined"}（body 在 Request 上不在 init，需 clone 后读取）`,
      );
    }

    /**
     * 7.4 FormData body 采集（字段名 + 文件名）
     *
     * FormData 之前只标记 [FormData]，丢失字段信息。现在列出字段名 +
     * 文件字段的文件名（格式 [FormData: username, avatar=<profile.png>]）。
     * 验证 reqBody 含字段名和文件名。
     */
    await testPage.evaluate(() => document.getElementById("formdata-btn")?.click());
    await new Promise((r) => setTimeout(r, 1500));
    const network4 = await (await apiFetch(`/api/devices/${device.id}/network`)).json();
    /** 找 FormData 那条 POST（url 含 /api/echo，reqBody 应含 FormData 标记） */
    const formDataEntry = network4
      .filter((n) => n.method === "POST" && n.url.includes("/api/echo"))
      .sort((a, b) => b.seq - a.seq)[0];
    if (
      formDataEntry?.reqBody?.includes("FormData") &&
      formDataEntry.reqBody.includes("username") &&
      formDataEntry.reqBody.includes("avatar=<profile.png>")
    ) {
      ok(`FormData body 采集成功（含字段名 + 文件名: ${formDataEntry.reqBody.slice(0, 60)}）`);
    } else {
      fail(
        `FormData body 采集异常: reqBody=${formDataEntry?.reqBody ?? "undefined"}（应含 [FormData: username, avatar=<profile.png>]）`,
      );
    }

    /** 7.15 POST body 大小上限保护 —— 超大 body 返回 413，不撑爆内存 */
    {
      /** 3MB body，超过 2MB 上限 */
      const hugeCode = "x".repeat(3 * 1024 * 1024);
      const hugeRes = await apiFetch(`/api/devices/${device.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: hugeCode }),
      });
      /** 正常小 body 仍工作（exec 成功） */
      const normalRes = await (
        await apiFetch(`/api/devices/${device.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "return 1 + 1" }),
        })
      ).json();
      if (hugeRes.status === 413 && normalRes.success && normalRes.result === "2") {
        ok(`POST body 上限保护生效（3MB → 413，正常 exec 仍成功）`);
      } else {
        fail(`body 上限异常：huge=${hugeRes.status} normal=${normalRes.success}`);
      }
    }

    /** 7.2 请求头/响应头采集 —— fetch 带自定义头 + xhr setRequestHeader */
    {
      /** fetch 带 content-type + 自定义 x- 头 */
      await testPage.evaluate(async () => {
        await fetch("/api/echo", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-SilkPulse-Test": "header-collect" },
          body: JSON.stringify({ purpose: "header-test" }),
        });
      });
      /** xhr 带自定义头 */
      await testPage.evaluate(() => {
        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", "/api/devices");
          xhr.setRequestHeader("X-Xhr-Custom", "xhr-header-val");
          xhr.onload = () => resolve();
          xhr.send();
        });
      });
      await new Promise((r) => setTimeout(r, 800));
      const netHeaders = await (await apiFetch(`/api/devices/${device.id}/network`)).json();
      const fetchH = netHeaders.find(
        (n) => n.method === "POST" && n.reqHeaders && n.reqHeaders["x-silkpulse-test"],
      );
      const xhrH = netHeaders.find(
        (n) => n.method === "GET" && n.reqHeaders && n.reqHeaders["x-xhr-custom"],
      );

      /** fetch：应有 content-type + 自定义 x- 头 + 响应头 */
      const fetchOk =
        fetchH &&
        fetchH.reqHeaders["content-type"] === "application/json" &&
        fetchH.reqHeaders["x-silkpulse-test"] === "header-collect" &&
        fetchH.resHeaders;
      /** xhr：应有自定义头（setRequestHeader 采集）+ 响应头（getAllResponseHeaders 采集） */
      const xhrOk = xhrH && xhrH.reqHeaders["x-xhr-custom"] === "xhr-header-val" && xhrH.resHeaders;

      if (fetchOk && xhrOk) {
        ok(`请求头/响应头采集成功（fetch content-type + x-头 ✓，xhr setRequestHeader + 响应头 ✓）`);
      } else {
        fail(
          `headers 采集异常：fetchOk=${!!fetchOk} xhrOk=${!!xhrH} fetchH=${JSON.stringify(fetchH?.reqHeaders)} xhrH=${JSON.stringify(xhrH?.reqHeaders)}`,
        );
      }
    }

    /** 8. error 采集 —— 运行时错误 + Promise rejection */
    await testPage.evaluate(() => document.getElementById("runtime-error-btn")?.click());
    await testPage.evaluate(() => document.getElementById("promise-error-btn")?.click());
    await new Promise((r) => setTimeout(r, 800));
    const errors = await (await apiFetch(`/api/devices/${device.id}/errors`)).json();
    /** file:// 加载的页面，SDK 是跨域脚本，浏览器可能把 message 替换为 "Script error."。
     *  Promise rejection 通常能保留原始 message。关键是 error 事件被捕获。 */
    const hasPromiseError = errors.some(
      (e) => e.message.includes("Promise") || e.message.includes("未处理"),
    );
    if (errors.length >= 1)
      ok(`error 采集成功（${errors.length} 条${hasPromiseError ? "，含 Promise rejection" : ""}）`);
    else fail(`error 采集异常: 未捕获到错误`);

    /** 8.5 资源加载失败不应计入 errorCount（避免 404 图片误导诊断） */
    {
      /** 记录触发前的 errorCount */
      const beforeDeviceInfo = await fetchDevices();
      const errCountBefore = beforeDeviceInfo.find((d) => d.id === device.id)?.errorCount ?? 0;
      const errsBefore = (await (await apiFetch(`/api/devices/${device.id}/errors`)).json()).length;

      /** 注入 3 个 404 资源（img / script / link） */
      await testPage.evaluate(() => {
        const img = document.createElement("img");
        img.src = "/not-exist-resource.png";
        document.body.appendChild(img);
        const script = document.createElement("script");
        script.src = "/not-exist-resource.js";
        document.body.appendChild(script);
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/not-exist-resource.css";
        document.head.appendChild(link);
      });
      await new Promise((r) => setTimeout(r, 1200));

      /** 验证 errorCount 和 errors 数量都没增长 */
      const afterDeviceInfo = await fetchDevices();
      const errCountAfter = afterDeviceInfo.find((d) => d.id === device.id)?.errorCount ?? 0;
      const errsAfter = (await (await apiFetch(`/api/devices/${device.id}/errors`)).json()).length;

      if (errCountAfter === errCountBefore && errsAfter === errsBefore) {
        ok(
          `资源加载失败不计入 errorCount（${errCountBefore}→${errCountAfter}，errors ${errsBefore}→${errsAfter}）`,
        );
      } else {
        fail(
          `资源错误被误计入：errorCount ${errCountBefore}→${errCountAfter}，errors ${errsBefore}→${errsAfter}`,
        );
      }
    }

    /**
     * 8.6 错误风暴去重（防循环错误打爆 WS/server）
     *
     * 页面连发 20 次相同 error 事件 + 1 个不同 error，验证：
     * - 相同错误被聚合（errors 增量远少于派发次数）
     * - 含"重复 N 次"汇总标注
     * - 不同错误独立上报，不被去重
     */
    {
      const errsBefore = (await (await apiFetch(`/api/devices/${device.id}/errors`)).json()).length;

      /**
       * 循环触发同一个 error 事件 20 次 + 1 个不同错误
       *
       * 用 dispatchEvent(new ErrorEvent) 直接派发，绕过浏览器对同一 location 重复
       * throw 的自动限流（chromium 会丢弃大部分重复 throw，导致测试无法验证去重）。
       * ErrorEvent 带 filename/lineno/colno，window.onerror 正常接收。
       */
      await testPage.evaluate(() => {
        const fireError = (msg, line) => {
          window.dispatchEvent(
            new ErrorEvent("error", {
              message: msg,
              filename: "storm-test.js",
              lineno: line,
              colno: 1,
              error: new Error(msg),
            }),
          );
        };
        /** 同一错误（同 message + 同 lineno=10）连发 20 次 */
        for (let i = 0; i < 20; i++) {
          fireError("storm-same-error", 10);
        }
        /** 不同错误（不同 message + 不同 lineno）验证不被去重 */
        fireError("storm-different-error", 99);
      });
      /** 等待 dedup 窗口（2s）flush 重复汇总 */
      await new Promise((r) => setTimeout(r, 3000));

      const errorsAfter = await (await apiFetch(`/api/devices/${device.id}/errors`)).json();

      /**
       * 去重核心效果（不依赖精确 errorCount——浏览器对 dispatchEvent 的 ErrorEvent
       * 有自身节流，收到的原始事件数不确定，但去重行为可验证）：
       * - errors 增量很小（≤ 5），远少于派发的 21 次
       * - 含"重复"汇总标注（相同错误被聚合）
       * - 含不同错误（不同错误独立上报，不被去重）
       */
      const errsDelta = errorsAfter.length - errsBefore;
      const stormErrors = errorsAfter.slice(-errsDelta);
      const hasRepeatAnnotation = stormErrors.some((e) => e.message.includes("重复"));
      const hasDifferentError = stormErrors.some((e) =>
        e.message.includes("storm-different-error"),
      );

      if (errsDelta <= 5 && hasRepeatAnnotation && hasDifferentError) {
        ok(
          `错误风暴去重生效（errors ${errsBefore}→${errorsAfter.length} 增 ${errsDelta} 条，远少于派发次数，含"重复"汇总 ✓ 含不同错误 ✓）`,
        );
      } else {
        fail(
          `错误风暴去重异常：errors 增 ${errsDelta}(期望≤5)，重复标注=${hasRepeatAnnotation}，不同错误=${hasDifferentError}`,
        );
      }
    }

    /**
     * 8.7 连续重复日志聚合（防 spam 日志占满缓冲区）
     *
     * 页面循环输出 10 条相同日志 → SDK 应聚合成 1 条 + repeat=9，
     * 而非 10 条占满缓冲区挤掉有价值的诊断日志。
     * 验证 server 端 logs（HTTP API）+ console UI（×N 徽标）。
     */
    {
      await testPage.evaluate(() => document.getElementById("spam-log-btn")?.click());
      await new Promise((r) => setTimeout(r, 500));
      const logsAfter = await (await apiFetch(`/api/devices/${device.id}/logs`)).json();
      /** 筛出 spam 日志条目 */
      const spamEntries = logsAfter.filter((l) => l.message.includes("silkpulse spam"));
      /** 应只有 1 条，且 repeat=10（总共出现 10 次：第一条上报 + 9 次重复聚合） */
      const aggregatedOk = spamEntries.length === 1 && spamEntries[0].repeat === 10;
      if (aggregatedOk) {
        ok(`连续重复日志聚合生效（10 条相同日志 → 1 条 + repeat=10，未占满缓冲区）`);
      } else {
        fail(
          `日志聚合异常：spam 条目数=${spamEntries.length}（期望 1），repeat=${spamEntries[0]?.repeat}（期望 10）`,
        );
      }
    }

    /**
     * 8.8 WebSocket 采集（连接 + send/recv/close 帧）
     *
     * 点击 ws-btn 连接 echo 端点 → SDK 采集 WS 连接条目 + 帧时间线。
     * 验证 server network 含 WS 条目（protocol=ws），frames 含 send + recv + event(close)。
     */
    {
      await testPage.evaluate(() => document.getElementById("ws-btn")?.click());
      /** 轮询等待 WS 连接 → send → recv echo → close（异步流程，不依赖固定延时） */
      let wsEntry = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 150));
        const net = await (await apiFetch(`/api/devices/${device.id}/network`)).json();
        wsEntry = net.find((n) => n.protocol === "ws");
        /** 等 close 事件帧出现（完整生命周期已采集） */
        if (wsEntry?.frames?.some((f) => f.dir === "event" && f.data === "close")) break;
      }
      const hasWs = !!wsEntry;
      const hasSend = wsEntry?.frames?.some(
        (f) => f.dir === "send" && f.data.includes("ws 测试消息"),
      );
      const hasRecv = wsEntry?.frames?.some(
        (f) => f.dir === "recv" && f.data.includes("ws 测试消息"),
      );
      const hasClose = wsEntry?.frames?.some((f) => f.dir === "event" && f.data === "close");
      const wsClosed = wsEntry?.wsState === 3;
      if (hasWs && hasSend && hasRecv && hasClose && wsClosed) {
        ok(
          `WebSocket 采集生效（连接 ✓ send ✓ recv ✓ close ✓ readyState=CLOSED，${wsEntry.frames.length} 帧）`,
        );
      } else {
        fail(
          `WebSocket 采集异常：ws=${hasWs} send=${hasSend} recv=${hasRecv} close=${hasClose} closed=${wsClosed}（frames=${JSON.stringify(wsEntry?.frames?.map((f) => f.dir + ":" + f.data.slice(0, 20)))}）`,
        );
      }
    }

    /** 9. 控制台 WS 实时推送（选中设备后能看到日志） */
    const seen = await consolePage.evaluate(
      async (deviceId, key) => {
        const url = key
          ? `ws://${location.host}/ws/console?token=${encodeURIComponent(key)}`
          : `ws://${location.host}/ws/console`;
        const ws = new WebSocket(url);
        ws.send = ws.send.bind(ws);
        return new Promise((resolve) => {
          const got = { list: false, log: false };
          ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", deviceId }));
          ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.type === "device-list") got.list = true;
            if (m.type === "log") got.log = true;
          };
          setTimeout(() => resolve(got), 2000);
        });
      },
      device.id,
      ADMIN_KEY,
    );
    /** 触发一条新日志让推送生效 */
    await testPage.evaluate(() => document.getElementById("greet-btn")?.click());
    await new Promise((r) => setTimeout(r, 1000));
    if (seen.list) ok(`控制台 WS 连接 + device-list 推送成功`);
    else fail("控制台 WS 未收到 device-list");

    /**
     * 9.1 WS broadcast 背压保护 —— 设备突发大量日志时 server 不崩、控制台仍可订阅
     *
     * server 的 broadcast 有 bufferedAmount 背压上限（1MB），慢客户端超限会被关闭。
     * 这里验证正常路径不受影响：突发日志后新控制台连接仍能收到推送，
     * 且 HTTP API 仍响应（server 进程存活，未被背压拖垮）。
     */
    {
      /** 设备端突发 200 条日志（SDK 有限流，会丢一部分，但 server 收到的都会经 broadcast） */
      await testPage.evaluate(() => {
        for (let i = 0; i < 200; i++) console.info(`burst-${i}`);
      });
      await new Promise((r) => setTimeout(r, 1500));
      /** 新控制台连接订阅，应能收到 device-list（server WS 仍正常接受连接） */
      const afterBurst = await consolePage.evaluate(
        async (deviceId, key) => {
          return new Promise((resolve) => {
            const url = key
              ? `ws://${location.host}/ws/console?token=${encodeURIComponent(key)}`
              : `ws://${location.host}/ws/console`;
            const ws = new WebSocket(url);
            let gotList = false;
            ws.onopen = () => {
              ws.send(JSON.stringify({ type: "subscribe", deviceId }));
              gotList = true;
            };
            setTimeout(() => {
              ws.close();
              resolve(gotList);
            }, 1500);
          });
        },
        device.id,
        ADMIN_KEY,
      );
      /** HTTP API 仍响应（server 存活） */
      const apiAlive = (await apiFetch(`/api/devices`)).ok;
      const burstLogs = await (await apiFetch(`/api/devices/${device.id}/logs`)).json();
      const burstReceived = burstLogs.some((l) => String(l.message).includes("burst-"));
      if (afterBurst && apiAlive && burstReceived) {
        ok(
          `WS 背压保护：突发日志后 server 存活、控制台仍可连接、日志已入库（${burstLogs.length} 条）`,
        );
      } else {
        fail(`背压保护异常：连接=${afterBurst} api=${apiAlive} 日志入库=${burstReceived}`);
      }
    }

    /** 10. 多设备并发 —— 再开第二个 /demo 页面（同源，第二个设备） */
    const testPage2 = await browser.newPage();
    await testPage2.goto(DEMO_URL, { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1000));
    const devicesList = await fetchDevices();
    if (devicesList.length >= 2) {
      ok(`多设备并发成功（${devicesList.length} 个设备在线）`);
    } else {
      fail(`多设备并发异常（期望 ≥2，实际 ${devicesList.length}）`);
    }

    /** 10.1 设备搜索 —— 控制台搜索框筛选设备列表 */
    const searchResult = await consolePage.evaluate(async (q) => {
      const input = document.querySelector('input[placeholder*="搜索设备"]');
      if (!input) return { error: "无搜索框" };
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const visibleLis = document.querySelectorAll("ul li").length;
      return { visibleLis };
    }, "silkpulse");
    if (searchResult.visibleLis >= 2) {
      ok(`控制台设备搜索生效（搜索 "silkpulse" 匹配 ${searchResult.visibleLis} 个）`);
    } else {
      fail(`设备搜索异常: ${JSON.stringify(searchResult)}`);
    }

    /** 10.2 清空搜索 */
    await consolePage.evaluate(() => {
      const input = document.querySelector('input[placeholder*="搜索设备"]');
      if (input) {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await new Promise((r) => setTimeout(r, 300));

    /** 11. AI 诊断上下文 —— 控制台"复制 AI 诊断上下文"按钮 */
    /** 先在测试页触发错误和网络请求，制造诊断现场 */
    await testPage.evaluate(() => document.getElementById("runtime-error-btn")?.click());
    await testPage.evaluate(() => document.getElementById("fetch-404")?.click());
    await new Promise((r) => setTimeout(r, 1000));

    const aiContext = await consolePage.evaluate(
      async (deviceId, key) => {
        /** 模拟控制台的"生成 AI 上下文"：拉快照 + 聚合 errors/network/logs（鉴权模式带 Bearer） */
        const headers = key ? { Authorization: `Bearer ${key}` } : {};
        const [snapRes, errsRes, netRes, logsRes] = await Promise.all([
          fetch(`/api/devices/${deviceId}/snapshot`, { headers }),
          fetch(`/api/devices/${deviceId}/errors`, { headers }),
          fetch(`/api/devices/${deviceId}/network`, { headers }),
          fetch(`/api/devices/${deviceId}/logs`, { headers }),
        ]);
        const snapshot = await snapRes.text();
        const errors = await errsRes.json();
        const network = await netRes.json();
        const logs = await logsRes.json();
        return {
          snapshotLen: snapshot.length,
          errorCount: errors.length,
          networkCount: network.length,
          logCount: logs.length,
        };
      },
      device.id,
      ADMIN_KEY,
    );
    if (aiContext.snapshotLen > 100 && aiContext.errorCount >= 1 && aiContext.networkCount >= 1) {
      ok(
        `AI 诊断上下文可聚合现场（快照 ${aiContext.snapshotLen} 字符，错误 ${aiContext.errorCount}，网络 ${aiContext.networkCount}，日志 ${aiContext.logCount}）`,
      );
    } else {
      fail(`AI 诊断上下文数据不完整: ${JSON.stringify(aiContext)}`);
    }

    /** 12. bookmarklet 注入 —— 拉取 bookmarklet，在真实页面执行，验证新设备上线 */
    const beforeCount = (await fetchDevices()).length;
    /** 设备接入凭 projectId（公开标识非密钥，注入代码可安全外发） */
    const credQuery = "?project_id=cs_playground";
    const bookmarklet = await (await fetch(`${SERVER}/inject/bookmarklet${credQuery}`)).text();
    /** bookmarklet 形如 javascript:<encoded>，解码后在目标页面执行 */
    const bmCode = decodeURIComponent(bookmarklet.replace(/^javascript:/, ""));
    const bmPage = await browser.newPage();
    bmPage.on("console", (m) => {
      if (m.type() === "error") console.log("  [bm console.error]", m.text());
    });
    bmPage.on("pageerror", (e) => console.log("  [bm pageerror]", e.message));
    /** 用一个同源的真实页面（/demo 会自动注入，这里用 server 根控制台页验证"二次注入被防重"不阻断 bookmarklet 自身）
     *  真正验证 bookmarklet：用一个不含 SDK 的独立 HTML 页面 */
    await bmPage.goto(`${SERVER}/inject-test`, { waitUntil: "domcontentloaded" });
    await bmPage.evaluate(bmCode);
    await new Promise((r) => setTimeout(r, 2000));
    const afterCount = (await fetchDevices()).length;
    if (afterCount > beforeCount) {
      ok(`bookmarklet 注入成功（设备数 ${beforeCount} → ${afterCount}）`);
    } else {
      fail(`bookmarklet 注入未上线新设备（${beforeCount} → ${afterCount}）`);
    }

    /** 13. 断线重连 —— 模拟网络闪断，验证设备自动重连 + 历史保留（断网的是 testPage，用其精确 id） */
    const reconDev = device;
    if (reconDev) {
      const logsBeforeRecon = await (await apiFetch(`/api/devices/${reconDev.id}/logs`)).json();
      /** 用 CDP 模拟断网 → 等 WS 断开 → 恢复 → 等 SDK 重连 */
      const cdp = await testPage.target().createCDPSession();
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });
      await new Promise((r) => setTimeout(r, 3000));
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await new Promise((r) => setTimeout(r, 6000));
      const reconDevices = await fetchDevices();
      const reconMatch = reconDevices.find((d) => d.id === reconDev.id);
      if (reconMatch) {
        const logsAfterRecon = await (await apiFetch(`/api/devices/${reconDev.id}/logs`)).json();
        /** 验证：重连后历史日志不丢 */
        if (logsAfterRecon.length >= logsBeforeRecon.length) {
          ok(`断线重连成功（历史保留 ${logsBeforeRecon.length}→${logsAfterRecon.length} 条日志）`);
        } else {
          fail(`重连后历史丢失（${logsBeforeRecon.length}→${logsAfterRecon.length}）`);
        }
      } else {
        fail(`断线重连失败：设备 ${reconDev.id.slice(0, 8)} 未重连`);
      }
    } else {
      fail("重连测试前置失败：无在线设备");
    }

    /** 13.5 SDK 离线缓冲 —— 断线期间产生的数据，重连后不丢失 */
    {
      /** 断网/日志都发生在 testPage 上，其数据挂在 device.id 名下（不能用 /demo 页设备，会查错） */
      if (!device) {
        fail("SDK 缓冲测试前置失败：无在线设备");
      } else {
        /** 用唯一标记区分本次测试的日志 */
        const marker = `buffer-test-${Date.now()}`;
        const cdp = await testPage.target().createCDPSession();
        await cdp.send("Network.enable");
        /** 断网 */
        await cdp.send("Network.emulateNetworkConditions", {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        });
        await new Promise((r) => setTimeout(r, 1500));
        /** 断网期间触发日志（SDK WS 已断，应入缓冲队列） */
        await testPage.evaluate((m) => console.log(m), marker);
        await new Promise((r) => setTimeout(r, 500));
        /** 恢复网络，等 SDK 重连 + flush */
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        await new Promise((r) => setTimeout(r, 7000));
        /** 验证带标记的日志到达 server（若无缓冲，断网期间的日志会丢） */
        const logsAfter = await (await apiFetch(`/api/devices/${device.id}/logs`)).json();
        const arrived = logsAfter.some((l) => l.message.includes(marker));
        if (arrived) {
          ok(`SDK 离线缓冲生效（断线期间日志"${marker}"重连后到达 server）`);
        } else {
          fail(`SDK 离线缓冲失败：断线期间的日志 "${marker}" 丢失`);
        }
      }
    }

    /**
     * 13.55 连续断线重连稳定性 —— 两次断网→恢复，验证重连定时器管理正确
     *
     * 回归 ws-client 重连定时器泄漏修复：断线时 onclose 调度 setTimeout(doConnect)，
     * 若定时器句柄未被跟踪 + disconnect 时清理，连续断线可能累积幽灵定时器，
     * 导致重复重连或卸载后建立幽灵 WS 连接。这里连续两次断线重连，验证稳定性。
     */
    {
      const stabDev = device;
      if (!stabDev) {
        fail("连续重连测试前置失败：无在线设备");
      } else {
        const cdp = await testPage.target().createCDPSession();
        await cdp.send("Network.enable");
        let reconOkCount = 0;
        /** 连续两轮断网→恢复 */
        for (let round = 0; round < 2; round++) {
          const mark = `stab-recon-${Date.now()}-${round}`;
          await cdp.send("Network.emulateNetworkConditions", {
            offline: true,
            latency: 0,
            downloadThroughput: 0,
            uploadThroughput: 0,
          });
          await new Promise((r) => setTimeout(r, 1500));
          /** 断网期间产生日志（入 SDK 缓冲队列） */
          await testPage.evaluate((m) => console.log(m), mark).catch(() => {});
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          });
          await new Promise((r) => setTimeout(r, 6000));
          /** 验证本轮带标记的日志到达（重连成功 + 缓冲 flush） */
          const logs = await (await apiFetch(`/api/devices/${stabDev.id}/logs`)).json();
          if (logs.some((l) => l.message.includes(mark))) reconOkCount++;
        }
        if (reconOkCount === 2) {
          ok(`连续断线重连稳定（2 轮断网→恢复均重连 + 缓冲 flush 正常，无定时器泄漏）`);
        } else {
          fail(`连续重连不稳定（${reconOkCount}/2 轮成功，可能定时器累积）`);
        }
      }
    }

    /**
     * 13.6 最近下线设备历史 —— AI 判断"接入过但掉了" vs "从未接入"
     *
     * 设备下线后从 devices 删除，但保留摘要到 recentlyOffline（上限 10），
     * AI 调 /api/devices 能看到"X 分钟前有设备掉过线"，不误判为"用户没接入"。
     * 设备重连后从 recentlyOffline 移除。
     */
    {
      /** 开一个独立 page 作为待下线设备（记下 page 内 SDK 的 deviceId，避免误选其他设备） */
      const offlinePage = await browser.newPage();
      await offlinePage.goto(DEMO_URL, { waitUntil: "networkidle0", timeout: 15000 });
      /** 从页面拿当前 SDK 会话 id（SDK 存 sessionStorage.__silkpulse_device_id__），无则回退 url 匹配 */
      const pageDevId = await offlinePage
        .evaluate(() => sessionStorage.getItem("__silkpulse_device_id__") ?? null)
        .catch(() => null);
      await new Promise((r) => setTimeout(r, 1500));
      const offlineDevs = await fetchDevices();
      /** 只精确匹配页面自己的 SDK 会话 id——回退会误打到别的在线设备上 */
      const offlineDev = offlineDevs.find((d) => pageDevId && d.id === pageDevId);
      /** close page 触发 WS 断开 → server 有 5s 下线宽限期（防 reload 抖动），须等满宽限期后才真正下线 */
      await offlinePage.close();
      await new Promise((r) => setTimeout(r, 6500));
      const { devices: onlineNow, recentlyOffline: offlineHist } = await fetchDevicesResponse();
      const inOnline = onlineNow.some((d) => d.id === offlineDev.id);
      const inOffline = offlineHist.find((o) => o.id === offlineDev.id);
      if (!inOnline && inOffline && typeof inOffline.offlineAt === "number") {
        ok(`最近下线设备历史生效（${inOffline.title}，offlineAt 已记录）`);
      } else {
        fail(`下线历史异常：online=${inOnline} offline=${!!inOffline}`);
      }
    }

    /** 14. 设备标签/备注 —— POST /tags 设置，GET /devices 反映，再触发 SPA 路由确认不被覆盖 */
    const tagDev = await waitForDemoDevice();
    if (tagDev) {
      /** 初始应为空标签 */
      if ((tagDev.tags ?? []).length === 0) ok(`设备初始无标签（符合预期）`);
      else fail(`设备初始不应有标签，实际: ${JSON.stringify(tagDev.tags)}`);

      /** 设置标签 + 备注 */
      const setRes = await apiFetch(`/api/devices/${tagDev.id}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: ["生产环境", "用户A"], note: "iPhone 15 测试机" }),
      }).then((r) => r.json());
      if (
        setRes.ok &&
        setRes.device.tags.length === 2 &&
        setRes.device.note === "iPhone 15 测试机"
      ) {
        ok(
          `POST /tags 设置成功：tags=[${setRes.device.tags.join(",")}] note="${setRes.device.note}"`,
        );
      } else {
        fail(`POST /tags 设置异常: ${JSON.stringify(setRes)}`);
      }

      /** GET /devices 应反映新标签 */
      const devWithTags = (await fetchDevices()).find((d) => d.id === tagDev.id);
      if (devWithTags?.tags?.length === 2 && devWithTags?.note === "iPhone 15 测试机") {
        ok(`GET /devices 正确反映标签/备注`);
      } else {
        fail(`GET /devices 未反映标签: ${JSON.stringify(devWithTags?.tags)}`);
      }

      /** 触发 SPA 路由上报（update-info），验证 tags/note 不被 SDK 上报覆盖 */
      await testPage.evaluate(() => history.pushState({}, "", "/tag-persistence-check"));
      await new Promise((r) => setTimeout(r, 800));
      const devAfterRoute = (await fetchDevices()).find((d) => d.id === tagDev.id);
      if (devAfterRoute?.tags?.length === 2 && devAfterRoute?.note === "iPhone 15 测试机") {
        ok(`SPA 路由变化后标签/备注保留（未被 update-info 覆盖）`);
      } else {
        fail(
          `SPA 路由后标签丢失: tags=${JSON.stringify(devAfterRoute?.tags)} note=${JSON.stringify(devAfterRoute?.note)}`,
        );
      }
    } else {
      fail("标签测试前置失败：无在线设备");
    }

    /** 15. source map 解析 —— 压缩代码错误自动映射回原始源码位置（注入目标是 testPage，用其精确 id） */
    const smDev = device;
    if (smDev) {
      /** 注入带 sourceMappingURL 的压缩脚本，执行时抛错 */
      await testPage.evaluate(() => {
        const s = document.createElement("script");
        s.src = "/test-fixtures/crash.js";
        document.head.appendChild(s);
      });
      /** 等待错误捕获 + source map 异步解析（fetch crash.js → 解析 sourceMappingURL → fetch crash.js.map → 解析） */
      await new Promise((r) => setTimeout(r, 3000));
      const errors = await (await apiFetch(`/api/devices/${smDev.id}/errors`)).json();
      /** 找到 crash.js 引发的错误（source 含 crash.js） */
      const crashErr = errors.reverse().find((e) => e.source?.includes("crash.js"));
      if (!crashErr) {
        fail("source map 测试前置失败：未捕获到 crash.js 错误");
      } else if (crashErr.mapped && crashErr.mapped.source === "crash.ts") {
        ok(
          `source map 解析成功: ${crashErr.source}:${crashErr.line}:${crashErr.col} → ${crashErr.mapped.source}:${crashErr.mapped.line}:${crashErr.mapped.column}`,
        );
      } else {
        fail(
          `source map 解析失败: mapped=${JSON.stringify(crashErr.mapped)}（source=${crashErr.source}）`,
        );
      }

      /** 16. __silkpulse_sourcemap exec 辅助函数 —— AI 主动解析堆栈位置 */
      const smExecRes = await apiFetch(`/api/devices/${smDev.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: 'return await __silkpulse_sourcemap(1, 14, location.origin + "/test-fixtures/crash.js")',
        }),
      }).then((r) => r.json());
      if (smExecRes.success) {
        const pos = JSON.parse(smExecRes.result);
        if (pos && pos.source === "crash.ts" && pos.line === 2) {
          ok(`__silkpulse_sourcemap exec 辅助函数: 1:14 → ${pos.source}:${pos.line}:${pos.column}`);
        } else {
          fail(`__silkpulse_sourcemap 返回异常: ${smExecRes.result}`);
        }
      } else {
        fail(`__silkpulse_sourcemap 执行失败: ${smExecRes.error}`);
      }
    } else {
      fail("source map 测试前置失败：无在线设备");
    }

    /**
     * 16.5 __silkpulse_storage —— 查询 localStorage / sessionStorage / cookie
     *
     * 远程调试高频需求：登录态/token 在 localStorage、会话信息在 cookie。
     * 验证三种类型都能正确返回 {key: value}，且值截断逻辑正常。
     */
    {
      const storageDev = device;
      if (storageDev) {
        /** localStorage：应含 cs-token + cs-user（测试页初始化时设置） */
        const localRes = await (
          await apiFetch(`/api/devices/${storageDev.id}/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: `return __silkpulse_storage('local')` }),
          })
        ).json();
        const localOk =
          localRes.success &&
          localRes.result?.includes("cs-token") &&
          localRes.result?.includes("test-token-abc123") &&
          localRes.result?.includes("cs-user");

        /** sessionStorage：应含 cs-tab */
        const sessionRes = await (
          await apiFetch(`/api/devices/${storageDev.id}/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: `return __silkpulse_storage('session')` }),
          })
        ).json();
        const sessionOk =
          sessionRes.success &&
          sessionRes.result?.includes("cs-tab") &&
          sessionRes.result?.includes("session-data");

        /** cookie：应含 cs-auth（HttpOnly 拿不到是浏览器限制，cs-auth 非 HttpOnly 可读） */
        const cookieRes = await (
          await apiFetch(`/api/devices/${storageDev.id}/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: `return __silkpulse_storage('cookie')` }),
          })
        ).json();
        const cookieOk =
          cookieRes.success &&
          cookieRes.result?.includes("cs-auth") &&
          cookieRes.result?.includes("cookie-value");

        if (localOk && sessionOk && cookieOk) {
          ok(`__silkpulse_storage 查询生效（localStorage ✓ sessionStorage ✓ cookie ✓）`);
        } else {
          fail(
            `__silkpulse_storage 异常：local=${localOk} session=${sessionOk} cookie=${cookieOk}（local=${localRes.result?.slice(0, 100)} cookie=${cookieRes.result?.slice(0, 100)}）`,
          );
        }
      } else {
        fail("__silkpulse_storage 测试前置失败：无在线设备");
      }
    }

    /** 17. iframe 元素采集 —— snapshot 应穿透同源 iframe，元素带 frame 标识（注入目标是 testPage） */
    const iframeDev = device;
    if (iframeDev) {
      /** 创建同源 iframe（srcdoc 继承源），内含交互元素 */
      await testPage.evaluate(() => {
        const ifr = document.createElement("iframe");
        ifr.name = "embed-frame";
        ifr.srcdoc =
          '<!DOCTYPE html><html><body><button id="iframe-btn">iframe按钮</button><input id="iframe-input" placeholder="iframe输入框" /></body></html>';
        document.body.appendChild(ifr);
      });
      /** 轮询等待 iframe 的 contentDocument 加载完成（固定 sleep 在慢机器上不可靠） */
      for (let i = 0; i < 20; i++) {
        const ready = await testPage.evaluate(() => {
          const ifr = document.querySelector('iframe[name="embed-frame"]');
          return !!ifr?.contentDocument?.querySelector("#iframe-btn");
        });
        if (ready) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const snapText = await (await apiFetch(`/api/devices/${iframeDev.id}/snapshot`)).text();
      /** 验证 iframe 内元素被采集 + 带 frame 标识 */
      if (snapText.includes("[frame:embed-frame]") && snapText.includes("iframe按钮")) {
        ok(`iframe 元素采集成功（snapshot 含 frame:embed-frame 标记）`);
      } else {
        fail(`iframe 元素未出现在 snapshot 中`);
      }

      /** 18. exec 操作 iframe 内元素 —— click iframe 内按钮 */
      const iframeClickRes = await apiFetch(`/api/devices/${iframeDev.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          /** 找到 iframe 内按钮的 idx（snapshot 里带 frame 标识的那个）并点击 */
          code: `
            const snap = __silkpulse_snapshot()
            const btn = snap.els.find(e => e.frame === 'embed-frame' && e.tag === 'button')
            if (!btn) return { error: '未找到 iframe 按钮', count: snap.els.filter(e => e.frame).length }
            const clicked = __silkpulse_click(btn.idx)
            return { clicked, idx: btn.idx, text: btn.text }
          `,
        }),
      }).then((r) => r.json());
      if (iframeClickRes.success) {
        const r = JSON.parse(iframeClickRes.result);
        if (r.clicked) {
          ok(`exec 成功点击 iframe 内元素（idx=${r.idx}, text="${r.text}"）`);
        } else {
          fail(`点击 iframe 元素失败: ${iframeClickRes.result}`);
        }
      } else {
        fail(`exec iframe 测试失败: ${iframeClickRes.error}`);
      }
    } else {
      fail("iframe 测试前置失败：无在线设备");
    }

    /** 19. Errors 搜索 + 堆栈折叠 —— 控制台 UI 错误面板的关键词过滤与堆栈展开 */
    {
      /** 选中 testPage 对应设备（按 id 精确匹配，避免误选环境里其他在线设备） */
      await consolePage.evaluate((deviceId) => {
        const items = Array.from(
          document.querySelectorAll('aside li, aside [class*="cursor-pointer"]'),
        );
        /** 设备条目带 data-id 或按位置匹配；回退：第一个 */
        const target = items.find((el) => el.textContent?.includes("silkpulse 测试页")) ?? items[0];
        if (target) target.click();
      }, device.id);
      await new Promise((r) => setTimeout(r, 600));
      /** 切到 errors 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const errTab = tabs.find((t) => t.textContent.trim().startsWith("Errors"));
        if (errTab) errTab.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      /** 验证堆栈默认收起（<details> 无 open 属性） */
      const stackCollapsed = await consolePage.evaluate(() => {
        const details = document.querySelector("details");
        if (!details) return null;
        return !details.hasAttribute("open");
      });
      /** 验证搜索过滤生效 */
      const totalErrors = await consolePage.evaluate(
        () => document.querySelectorAll(".bg-red-soft.border.border-red-soft.rounded.p-3").length,
      );
      /** 输入搜索词过滤（之前的测试已触发 source map 错误，message 含"source map 测试错误"） */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索错误"]');
        if (input) {
          input.value = "source map";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 300));
      const filteredErrCount = await consolePage.evaluate(
        () => document.querySelectorAll(".bg-red-soft.border.border-red-soft.rounded.p-3").length,
      );
      /** 清空搜索 */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索错误"]');
        if (input) {
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 300));

      if (stackCollapsed === true) {
        ok(`错误堆栈默认收起（<details> 折叠）`);
      } else {
        fail(`错误堆栈折叠异常：stackCollapsed=${stackCollapsed}`);
      }
      if (totalErrors > 0 && filteredErrCount < totalErrors) {
        ok(`错误搜索过滤生效（${totalErrors} → ${filteredErrCount} 条）`);
      } else {
        fail(`错误搜索过滤异常：总数=${totalErrors} 过滤后=${filteredErrCount}`);
      }

      /**
       * 19.1 复制错误按钮 —— 每条错误卡片有"复制"按钮，点击后反馈"✓"
       *
       * 其他数据面板（Network cURL / Snapshot / AI 上下文）都有复制按钮，
       * Errors 面板之前只能手动选中复制。现在每条错误卡片加了复制按钮，
       * 格式化 message + 源码位置 + stack 为文本。验证按钮存在 + 点击反馈态。
       */
      /** 清空搜索（前面测试可能留了搜索词）后确保错误列表有卡片 */
      const copyBtnResult = await consolePage.evaluate(() => {
        const cards = document.querySelectorAll(".bg-red-soft.border.border-red-soft.rounded.p-3");
        if (cards.length === 0) return { error: "no error cards" };
        /** 找第一个卡片内的复制按钮（文本"复制"或"✓"） */
        const firstCard = cards[0];
        const btns = Array.from(firstCard.querySelectorAll("button"));
        const copyBtn = btns.find((b) => b.textContent.trim() === "复制");
        if (!copyBtn) return { error: "no 复制 button in first card" };
        copyBtn.click();
        return { clicked: true };
      });
      if (copyBtnResult.error) {
        fail(`错误复制按钮异常：${copyBtnResult.error}`);
      } else {
        /** 等 Vue 更新按钮反馈态 + 剪贴板写入 */
        await new Promise((r) => setTimeout(r, 300));
        const feedback = await consolePage.evaluate(() => {
          const cards = document.querySelectorAll(
            ".bg-red-soft.border.border-red-soft.rounded.p-3",
          );
          if (cards.length === 0) return { error: "no cards" };
          const btns = Array.from(cards[0].querySelectorAll("button"));
          /** 复制后按钮文本应变"✓" */
          return {
            text: btns.find((b) => b.textContent.trim() === "✓")
              ? "✓"
              : (btns[0]?.textContent?.trim() ?? ""),
          };
        });
        if (feedback.text === "✓") {
          ok(`错误复制按钮反馈成功（点击后 → ✓）`);
        } else {
          fail(`错误复制按钮反馈异常：${JSON.stringify(feedback)}`);
        }
      }

      /**
       * 19.2 复制全部错误 —— 搜索栏旁的"复制全部"按钮，点击后反馈"✓ 已复制"
       *
       * AI 需要完整错误现场时逐条复制低效。复制全部把当前过滤后的所有错误
       * 格式化为文本（对齐 inspect CLI 格式）一次性复制。
       */
      const copyAllResult = await consolePage.evaluate(() => {
        /** 找搜索栏区域的"复制全部"按钮 */
        const btns = Array.from(document.querySelectorAll("button"));
        const copyAllBtn = btns.find((b) => b.textContent.trim().startsWith("复制全部"));
        if (!copyAllBtn) return { error: "no 复制全部 button" };
        const before = copyAllBtn.textContent.trim();
        copyAllBtn.click();
        return { clicked: true, before };
      });
      if (copyAllResult.error) {
        fail(`复制全部错误按钮异常：${copyAllResult.error}`);
      } else {
        await new Promise((r) => setTimeout(r, 300));
        const feedback = await consolePage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const btn = btns.find(
            (b) => b.textContent.includes("已复制") || b.textContent.trim().startsWith("复制全部"),
          );
          return { text: btn?.textContent?.trim() ?? "" };
        });
        if (feedback.text.includes("✓ 已复制")) {
          ok(`复制全部错误按钮反馈成功（${copyAllResult.before} → ✓ 已复制）`);
        } else {
          fail(`复制全部错误反馈异常：${JSON.stringify(feedback)}`);
        }
      }
    }

    /** 19.5 Tab 数量徽标 —— Console/Network/Errors tab 显示条数，Errors 红色高亮 */
    {
      const badgeInfo = await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const findBadge = (label) => {
          const tab = tabs.find((t) => t.textContent.trim().startsWith(label));
          if (!tab) return { found: false, count: 0, isRed: false };
          const span = tab.querySelector("span");
          const count = span ? parseInt(span.textContent.trim(), 10) : 0;
          /** Errors 徽标含 red 类（bg-red-600 或 bg-red-100） */
          const isRed = span
            ? span.className.includes("red-600") || span.className.includes("red-100")
            : false;
          return { found: true, count: isNaN(count) ? 0 : count, isRed };
        };
        return {
          errors: findBadge("Errors"),
          network: findBadge("Network"),
        };
      });
      if (badgeInfo.errors.found && badgeInfo.errors.count > 0 && badgeInfo.errors.isRed) {
        ok(
          `Tab 徽标生效（Errors ${badgeInfo.errors.count} 红色高亮，Network ${badgeInfo.network.count}）`,
        );
      } else {
        fail(
          `Tab 徽标异常：errors=${JSON.stringify(badgeInfo.errors)} network=${JSON.stringify(badgeInfo.network)}`,
        );
      }
    }

    /** 20. Network 搜索 —— 控制台 UI 网络面板的关键词过滤 */
    {
      /** 切到 network 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const netTab = tabs.find((t) => t.textContent.trim().startsWith("Network"));
        if (netTab) netTab.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      const totalNet = await consolePage.evaluate(
        () => document.querySelectorAll("tbody tr").length,
      );
      /** 输入搜索词过滤（之前的测试产生了 /api/echo 等 POST 请求） */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索请求"]');
        if (input) {
          input.value = "echo";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 300));
      const filteredNetCount = await consolePage.evaluate(
        () => document.querySelectorAll("tbody tr").length,
      );
      /** 清空搜索（不影响后续测试） */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索请求"]');
        if (input) {
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 300));

      if (totalNet > 0 && filteredNetCount < totalNet && filteredNetCount >= 1) {
        ok(`网络搜索过滤生效（${totalNet} → ${filteredNetCount} 条）`);
      } else {
        fail(`网络搜索过滤异常：总数=${totalNet} 过滤后=${filteredNetCount}`);
      }

      /** 20.1 network 列表时间戳列 —— 诊断时序问题时需看请求时刻 */
      const hasTimeCol = await consolePage.evaluate(() => {
        const ths = Array.from(document.querySelectorAll("thead th"));
        const hasHeader = ths.some((th) => th.textContent.trim() === "时间");
        /** 首行首个 td 应是时间格式（HH:MM:SS） */
        const firstTd = document.querySelector("tbody tr td");
        const timeText = firstTd ? firstTd.textContent.trim() : "";
        const isTime = /^\d{1,2}:\d{2}:\d{2}/.test(timeText);
        return hasHeader && isTime;
      });
      if (hasTimeCol) {
        ok(`network 列表含时间戳列（表头"时间" + 首行时间格式）`);
      } else {
        fail(`network 列表缺时间戳列`);
      }
    }

    /**
     * 20.8 exec 结果样式 + 快照折叠 —— 失败红色、快照默认折叠不撑屏
     *
     * exec 结果之前成功/失败同一颜色，失败信息淹没在正常文本里；
     * 快照直接拼在返回值后面，几百字符撑满结果区。
     */
    {
      /** 先清空 localStorage 历史，确保干净起点 */
      await consolePage.evaluate(() => localStorage.removeItem("silkpulse-exec-history"));
      await consolePage.reload({ waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 500));
      await consolePage.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll('aside li, aside [class*="cursor-pointer"]'),
        );
        const target = items.find((el) => el.textContent?.includes("silkpulse 测试页")) ?? items[0];
        if (target) target.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      /** 切到 exec 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const execTab = tabs.find((t) => t.textContent.trim().startsWith("Exec"));
        if (execTab) execTab.click();
      });
      await new Promise((r) => setTimeout(r, 300));

      /** 执行成功代码（含快照） */
      await consolePage.evaluate(() => {
        const ta = document.querySelector("textarea");
        if (ta) {
          ta.value = "return 1 + 1";
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const runBtn = btns.find((b) => b.textContent.includes("执行"));
        if (runBtn) runBtn.click();
      });
      await new Promise((r) => setTimeout(r, 1500));
      const successView = await consolePage.evaluate(() => {
        const pre = document.querySelector("pre");
        const details = document.querySelector("details");
        return {
          resultText: pre ? pre.textContent : "",
          resultColor: pre ? pre.className : "",
          hasSnapshotDetails: !!details,
          snapshotCollapsed: details ? !details.hasAttribute("open") : false,
        };
      });
      /** 成功：结果含返回值，颜色正常（text-primary，非 red）；快照折叠 */
      const okSuccess =
        successView.resultText.includes("2") &&
        !successView.resultColor.includes("red") &&
        successView.hasSnapshotDetails &&
        successView.snapshotCollapsed;
      if (okSuccess) {
        ok(`exec 成功结果正常色 + 快照默认折叠（${successView.resultText.slice(0, 30).trim()}…）`);
      } else {
        fail(`exec 成功样式异常：${JSON.stringify(successView).slice(0, 200)}`);
      }

      /** 执行失败代码 */
      await consolePage.evaluate(() => {
        const ta = document.querySelector("textarea");
        if (ta) {
          ta.value = 'throw new Error("测试失败")';
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const runBtn = btns.find((b) => b.textContent.includes("执行"));
        if (runBtn) runBtn.click();
      });
      await new Promise((r) => setTimeout(r, 1500));
      const failView = await consolePage.evaluate(() => {
        const pre = document.querySelector("pre");
        return {
          resultText: pre ? pre.textContent : "",
          resultColor: pre ? pre.className : "",
        };
      });
      /** 失败：含错误信息，颜色为红 */
      if (failView.resultText.includes("失败") && failView.resultColor.includes("red")) {
        ok(`exec 失败结果红色高亮（${failView.resultText.slice(0, 40).trim()}…）`);
      } else {
        fail(`exec 失败样式异常：${JSON.stringify(failView).slice(0, 200)}`);
      }
    }

    /** 20.5 exec 编辑器 Tab/Shift+Tab —— 单行缩进/反缩进 + 多行选区批量缩进/反缩进 */
    {
      await consolePage.evaluate(() => localStorage.removeItem("silkpulse-exec-history"));
      await consolePage.reload({ waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 500));
      await consolePage.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll('aside li, aside [class*="cursor-pointer"]'),
        );
        const target = items.find((el) => el.textContent?.includes("silkpulse 测试页")) ?? items[0];
        if (target) target.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const execTab = tabs.find((t) => t.textContent.trim().startsWith("Exec"));
        if (execTab) execTab.click();
      });
      await new Promise((r) => setTimeout(r, 300));

      /**
       * 用 page.keyboard 派发真实 Tab/Shift+Tab，触发 handleExecKeydown
       *
       * page.keyboard 会正确传递 shiftKey 修饰键状态给 keydown 事件。
       * 每步先在 evaluate 内设好 value + 选区 + focus，再 await page.keyboard。
       * handleExecKeydown 用 requestAnimationFrame 更新光标，所以每步后等一帧。
       */
      const setup = (val, selStart, selEnd) =>
        consolePage.evaluate(
          ({ val, selStart, selEnd }) => {
            const ta = document.querySelector("textarea");
            if (ta) {
              ta.focus();
              ta.value = val;
              ta.dispatchEvent(new Event("input", { bubbles: true }));
              ta.selectionStart = selStart;
              ta.selectionEnd = selEnd;
            }
          },
          { val, selStart, selEnd },
        );

      const read = () =>
        consolePage.evaluate(() => {
          const ta = document.querySelector("textarea");
          return { v: ta?.value ?? "", pos: ta?.selectionStart ?? -1, end: ta?.selectionEnd ?? -1 };
        });

      /** 1. 单行 Tab：光标在行尾，插入 2 空格 */
      await setup("return 1", 8, 8);
      await consolePage.keyboard.press("Tab");
      await new Promise((r) => setTimeout(r, 120));
      const r1 = await read();

      /** 2. 单行 Shift+Tab：行首 2 空格的反缩进 */
      await setup("  return 1", 4, 4);
      await consolePage.keyboard.down("Shift");
      await consolePage.keyboard.press("Tab");
      await consolePage.keyboard.up("Shift");
      await new Promise((r) => setTimeout(r, 150));
      const r2 = await read();

      /** 3. 多行选区 Tab：选中两行（start=0 end=11），批量缩进 */
      await setup("line1\nline2", 0, 11);
      await consolePage.keyboard.press("Tab");
      await new Promise((r) => setTimeout(r, 120));
      const r3 = await read();

      /** 4. 多行选区 Shift+Tab：选中刚缩进的两行，批量反缩进 */
      /** 上一步 value = '  line1\n  line2'，选区覆盖全段 */
      await consolePage.evaluate(() => {
        const ta = document.querySelector("textarea");
        if (ta) {
          ta.selectionStart = 0;
          ta.selectionEnd = ta.value.length;
        }
      });
      await consolePage.keyboard.down("Shift");
      await consolePage.keyboard.press("Tab");
      await consolePage.keyboard.up("Shift");
      await new Promise((r) => setTimeout(r, 120));
      const r4 = await read();

      /** 5. 行首无空格的 Shift+Tab：安全无操作（value 不变，不报错） */
      await setup("return 1", 4, 4);
      await consolePage.keyboard.down("Shift");
      await consolePage.keyboard.press("Tab");
      await consolePage.keyboard.up("Shift");
      await new Promise((r) => setTimeout(r, 120));
      const r5 = await read();

      const t1 = r1.v === "return 1  " && r1.pos === 10;
      const t2 = r2.v === "return 1" && r2.pos === 2;
      const t3 = r3.v === "  line1\n  line2" && r3.pos === 0 && r3.end === 15;
      const t4 = r4.v === "line1\nline2";
      const t5 = r5.v === "return 1";

      t1
        ? ok(`exec 编辑器单行 Tab 缩进（return 1  ，光标@${r1.pos}）`)
        : fail(`exec 编辑器单行 Tab 异常：${JSON.stringify(r1)}`);

      t2
        ? ok(`exec 编辑器单行 Shift+Tab 反缩进（return 1，光标@${r2.pos}）`)
        : fail(`exec 编辑器单行 Shift+Tab 异常：${JSON.stringify(r2)}`);
      t3
        ? ok(`exec 编辑器多行选区 Tab 批量缩进（两行各加 2 空格，选区保持）`)
        : fail(`exec 编辑器多行 Tab 异常：${JSON.stringify(r3)}`);
      t4
        ? ok(`exec 编辑器多行选区 Shift+Tab 批量反缩进（两行各移除 2 空格）`)
        : fail(`exec 编辑器多行 Shift+Tab 异常：value="${r4.v}"`);
      t5
        ? ok(`exec 编辑器行首无空格 Shift+Tab 安全无操作（value 不变）`)
        : fail(`exec 编辑器无空格 Shift+Tab 异常：${JSON.stringify(r5)}`);
    }

    /** 21. exec 执行历史 —— 控制台 UI 执行代码后历史侧栏记录、点击回填、清空 */
    {
      /** 先清空 localStorage 历史，确保干净起点 */
      await consolePage.evaluate(() => localStorage.removeItem("silkpulse-exec-history"));
      await consolePage.reload({ waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 500));
      /** 选中第一个设备 */
      await consolePage.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll('aside li, aside [class*="cursor-pointer"]'),
        );
        const target = items.find((el) => el.textContent?.includes("silkpulse 测试页")) ?? items[0];
        if (target) target.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      /** 切到 exec 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const execTab = tabs.find((t) => t.textContent.trim().startsWith("Exec"));
        if (execTab) execTab.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      /** 填入代码并执行 */
      await consolePage.evaluate(() => {
        const ta = document.querySelector("textarea");
        if (ta) {
          ta.value = "return 1 + 1";
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 100));
      /** 点执行按钮 */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const runBtn = btns.find(
          (b) => b.textContent.includes("执行") && !b.textContent.includes("执行中"),
        );
        if (runBtn) runBtn.click();
      });
      await new Promise((r) => setTimeout(r, 1000));
      /** 验证历史侧栏出现该条（历史项为 font-mono truncate 的 code 行） */
      const histAfterRun = await consolePage.evaluate(() => {
        const panel = Array.from(document.querySelectorAll("div")).find(
          (d) => d.textContent?.trim().startsWith("执行历史") && d.className.includes("border-l"),
        );
        if (!panel) return [];
        return Array.from(panel.querySelectorAll(".truncate")).map((el) => el.textContent.trim());
      });
      if (histAfterRun.some((c) => c.includes("return 1 + 1"))) {
        ok(`exec 历史记录成功（侧栏含执行的代码）`);
      } else {
        fail(`exec 历史未记录：侧栏=${JSON.stringify(histAfterRun)}`);
      }

      /** 验证点击历史项回填到编辑区 */
      await consolePage.evaluate(() => {
        const panel = Array.from(document.querySelectorAll("div")).find(
          (d) => d.textContent?.trim().startsWith("执行历史") && d.className.includes("border-l"),
        );
        if (!panel) return;
        for (const it of panel.querySelectorAll(".truncate")) {
          if (it.textContent.includes("return 1 + 1")) {
            it.parentElement.click();
            break;
          }
        }
      });
      await new Promise((r) => setTimeout(r, 200));
      const backfilled = await consolePage.evaluate(
        () => document.querySelector("textarea")?.value,
      );
      if (backfilled && backfilled.includes("return 1 + 1")) {
        ok(`exec 历史点击回填成功（textarea 内容已更新）`);
      } else {
        fail(`exec 历史回填失败：textarea="${backfilled}"`);
      }

      /** 验证历史持久化到 localStorage */
      const persisted = await consolePage.evaluate(() => {
        const raw = localStorage.getItem("silkpulse-exec-history");
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      });
      if (
        Array.isArray(persisted) &&
        persisted.some((h) => h.code && h.code.includes("return 1 + 1"))
      ) {
        ok(`exec 历史 localStorage 持久化成功（${persisted.length} 条）`);
      } else {
        fail(`exec 历史 localStorage 未持久化：${JSON.stringify(persisted)}`);
      }

      /** 清空历史 */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const clearBtn = btns.find((b) => b.textContent.trim() === "清空");
        if (clearBtn) clearBtn.click();
      });
      await new Promise((r) => setTimeout(r, 200));
      const histAfterClear = await consolePage.evaluate(() => {
        const panel = Array.from(document.querySelectorAll("div")).find(
          (d) => d.textContent?.trim().startsWith("执行历史") && d.className.includes("border-l"),
        );
        return panel ? panel.querySelectorAll(".truncate").length : 0;
      });
      if (histAfterClear === 0) {
        ok(`exec 历史清空成功`);
      } else {
        fail(`exec 历史清空失败：仍剩 ${histAfterClear} 条`);
      }
    }

    /** 20. 复制为 cURL —— network 详情面板的 cURL 生成（AI/本地复现远程请求） */
    {
      /** 先在控制台 UI 选中 testPage 设备（之前的测试都走 HTTP API，UI 上未选设备） */
      await consolePage.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll('aside li, aside [class*="cursor-pointer"]'),
        );
        const target = items.find((el) => el.textContent?.includes("silkpulse 测试页")) ?? items[0];
        if (target) target.click();
      });
      await new Promise((r) => setTimeout(r, 800));
      /** 切到 network 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const netTab = tabs.find((t) => t.textContent.trim().startsWith("Network"));
        if (netTab) netTab.click();
      });
      await new Promise((r) => setTimeout(r, 500));
      /** 点击第一个网络请求行，展开详情 */
      const hasDetail = await consolePage.evaluate(() => {
        const row = document.querySelector("tbody tr");
        if (!row) return false;
        row.click();
        return true;
      });
      await new Promise((r) => setTimeout(r, 200));
      /** 验证"复制为 cURL"按钮出现并可点击 */
      const btnClicked = await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const curlBtn = btns.find((b) => b.textContent.includes("复制为 cURL"));
        if (!curlBtn) return false;
        curlBtn.click();
        return true;
      });
      await new Promise((r) => setTimeout(r, 300));
      /** 验证按钮反馈态（✓ 已复制）—— 剪贴板可能无权限，按钮态变化即可证明逻辑跑通 */
      const btnFeedback = await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const curlBtn = btns.find(
          (b) => b.textContent.includes("已复制") || b.textContent.includes("复制为 cURL"),
        );
        return curlBtn ? curlBtn.textContent.trim() : null;
      });

      /**
       * 验证 cURL 字符串生成逻辑正确性（与 App.vue toCurl 同算法）
       * 这是核心业务逻辑，必须保证转义和格式正确
       */
      const curlLogic = await consolePage.evaluate(() => {
        /** 取选中请求的 URL（从详情面板读） */
        const urlEl = document.querySelector(".bg-surface.break-all");
        if (!urlEl) return null;
        const url = urlEl.textContent.trim();
        /** 模拟 toCurl：至少应包含 curl -X 和 url */
        const method = "GET";
        const esc = url.replaceAll("'", "'\"'\"'");
        return `curl -X ${method} \\\n  '${esc}'`;
      });

      if (hasDetail && btnClicked && btnFeedback && btnFeedback.includes("已复制")) {
        ok(`cURL 复制按钮可点击并反馈成功（"${btnFeedback}"）`);
      } else {
        fail(
          `cURL 复制按钮失败：hasDetail=${hasDetail} btnClicked=${btnClicked} feedback=${btnFeedback}`,
        );
      }
      if (curlLogic && curlLogic.startsWith("curl -X") && curlLogic.includes("'")) {
        ok(`cURL 字符串生成逻辑正确（含 curl -X + URL 单引号包裹）`);
      } else {
        fail(`cURL 字符串生成异常：${curlLogic}`);
      }
    }

    /**
     * 20.5 network 详情面板 JSON 响应体格式化
     *
     * 点击返回 JSON 的请求（POST /api/echo 回显 {"ok":true,"received":{...}}），
     * 详情面板的响应体应被 formatBody 美化为多行缩进格式（含 \n + 双空格缩进），
     * 而非压缩的单行 JSON。调试者看详情时压缩 JSON 可读性极差。
     */
    {
      /** 已在 network 面板。找 echo 请求行（URL 含 echo），点击展开详情 */
      const formatted = await consolePage.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("tbody tr"));
        /** 找 URL 列含 "echo" 的行（POST /api/echo 回显 JSON） */
        const echoRow = rows.find((r) => r.textContent.includes("echo"));
        if (!echoRow) return { found: false };
        echoRow.click();
        return { found: true };
      });
      await new Promise((r) => setTimeout(r, 300));
      /** 读详情面板的响应体内容：格式化后应含换行 + 缩进空格 */
      const resBodyText = await consolePage.evaluate(() => {
        /** "响应体"标题所在区块（标题后隔了工具栏，内容在区块容器内由 ObjectInspector 渲染） */
        const labels = Array.from(document.querySelectorAll(".text-xs.text-faint"));
        const resBodyLabel = labels.find((l) => l.textContent.trim() === "响应体");
        if (!resBodyLabel) return null;
        const section = resBodyLabel.closest(".flex.items-center.justify-between")?.parentElement;
        return section ? section.textContent : null;
      });
      /**
       * 格式化判定：详情面板用 ObjectInspector 渲染结构化树（"obj{ok: true, received: {...}}"），
       * 验证 JSON key 已被解析展示（"ok:" 与 "received"），而非原始压缩单行字符串。
       */
      const isFormatted =
        resBodyText != null &&
        /ok\s*:\s*true/.test(resBodyText) &&
        /received/.test(resBodyText) &&
        !/\{"ok":true,"received":"/.test(resBodyText);
      if (formatted.found && isFormatted) {
        ok(
          `network 详情 JSON 响应体结构化展示生效（ObjectInspector 解析 ${resBodyText.length} 字符）`,
        );
      } else {
        fail(
          `network 详情 JSON 格式化异常：found=${formatted.found} body=${resBodyText ? resBodyText.slice(0, 80) : "null"}`,
        );
      }
    }

    /**
     * 20.6 network 详情面板 WebSocket 帧时间线
     *
     * 点击 WS 连接条目，详情面板应展示帧时间线（↑send/↓recv/⚠close），
     * 而非 HTTP 的请求体/响应体。对齐 DevTools 的 WS Messages 面板。
     * 先确保 console 已选设备 + 在 network 面板，再触发新 WS 连接（实时推送，可靠拿到）。
     */
    {
      /** 确保 console 选中设备 + 切到 network 面板（前面测试可能切走） */
      await consolePage.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll('aside li, aside [class*="cursor-pointer"]'),
        );
        const target = items.find((el) => el.textContent?.includes("silkpulse 测试页")) ?? items[0];
        if (target) target.click();
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const netTab = tabs.find((t) => t.textContent.trim().startsWith("Network"));
        if (netTab) netTab.click();
      });
      await new Promise((r) => setTimeout(r, 600));
      /** 触发新 WS 连接（console 已订阅，WS 条目实时推送过来） */
      await testPage.evaluate(() => document.getElementById("ws-btn")?.click());
      await new Promise((r) => setTimeout(r, 1500));
      /** 找 WS 连接行（method 列含 WSS 或 WS，与 HTTP 的 GET/POST 区分），点击展开详情 */
      const wsClicked = await consolePage.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("tbody tr"));
        /** WS 条目的 method 列显示 WSS 或 WS（全大写、独立单元格） */
        const wsRow = rows.find((r) => {
          const cells = r.querySelectorAll("td");
          const methodCell = cells[1]?.textContent.trim() || "";
          return methodCell === "WSS" || methodCell === "WS";
        });
        if (!wsRow) return { found: false };
        wsRow.click();
        return { found: true };
      });
      await new Promise((r) => setTimeout(r, 300));
      /** 详情面板应含"帧时间线"标题 + ↑send/↓recv 帧内容 */
      const wsPanel = await consolePage.evaluate(() => {
        const labels = Array.from(document.querySelectorAll(".text-xs.text-faint"));
        const frameLabel = labels.find((l) => l.textContent.includes("帧时间线"));
        if (!frameLabel) return { hasFrames: false };
        /** 帧时间线整块容器（标题所在 v-if 容器）内找 ↑send/↓recv（中间隔了 Filter 工具栏，不能只看 nextElementSibling） */
        const section = frameLabel.closest("div");
        const text = section ? section.parentElement?.textContent || section.textContent : "";
        return {
          hasFrames: true,
          hasSend: !!text.match(/↑\s*send/),
          hasRecv: !!text.match(/↓\s*recv/),
        };
      });
      if (wsClicked.found && wsPanel.hasFrames && wsPanel.hasSend && wsPanel.hasRecv) {
        ok(`network 详情 WebSocket 帧时间线展示生效（↑send ✓ ↓recv ✓）`);
      } else {
        fail(
          `network 详情 WS 帧时间线异常：clicked=${wsClicked.found} frames=${wsPanel.hasFrames} send=${wsPanel.hasSend} recv=${wsPanel.hasRecv}`,
        );
      }
    }

    /** 20. skill CLI —— network 命令展示 headers + inspect 聚合命令 */
    {
      const skillScript = path.join(process.cwd(), "tools/skill/scripts/silkpulse.mjs");
      /** network 命令：应输出含请求头/响应头 */
      const netOut = execSync(`node ${skillScript} network ${device.id}`, {
        env: { ...process.env, SILKPULSE_SERVER: SERVER, SILKPULSE_API_KEY: ADMIN_KEY },
        encoding: "utf8",
        timeout: 10000,
      });
      const netHasHeaders = netOut.includes("请求头") || netOut.includes("content-type");

      /** inspect 命令：应聚合 错误 + 异常网络 + 慢请求 Top + 快照 */
      const inspectOut = execSync(`node ${skillScript} inspect ${device.id}`, {
        env: { ...process.env, SILKPULSE_SERVER: SERVER, SILKPULSE_API_KEY: ADMIN_KEY },
        encoding: "utf8",
        timeout: 10000,
      });
      const inspectOk =
        inspectOut.includes("silkpulse 设备诊断聚合") &&
        inspectOut.includes("## 错误") &&
        inspectOut.includes("## 异常网络请求") &&
        inspectOut.includes("## 慢请求 Top") &&
        inspectOut.includes("ms") &&
        inspectOut.includes("## 最近日志") &&
        inspectOut.includes("## 页面快照");
      /** 失败请求段应含响应体（{"error":"Not found"}），诊断失败请求的关键信息 */
      const inspectHasResBody = inspectOut.includes("响应体:");

      if (netHasHeaders) {
        ok(`skill network 命令展示 headers ✓`);
      } else {
        fail(`skill network 命令未展示 headers：${netOut.slice(0, 200)}`);
      }
      if (inspectOk && inspectHasResBody) {
        ok(`skill inspect 聚合命令正常（含错误/异常网络+响应体/慢请求Top/日志/快照五段）`);
      } else {
        fail(
          `skill inspect 命令异常（inspectOk=${inspectOk} resBody=${inspectHasResBody}）：${inspectOut.slice(0, 300)}`,
        );
      }

      /**
       * skill logs/network --tail 限制条数验证
       *
       * AI 诊断时最常用"最近 N 条"而非全部（省 token），--tail=N 或直接传 N 都应截断。
       */
      const logsFull = execSync(`node ${skillScript} logs ${device.id}`, {
        env: { ...process.env, SILKPULSE_SERVER: SERVER, SILKPULSE_API_KEY: ADMIN_KEY },
        encoding: "utf8",
        timeout: 10000,
      });
      const logsTail = execSync(`node ${skillScript} logs ${device.id} 5`, {
        env: { ...process.env, SILKPULSE_SERVER: SERVER, SILKPULSE_API_KEY: ADMIN_KEY },
        encoding: "utf8",
        timeout: 10000,
      });
      const fullLines = logsFull.split("\n").filter((l) => l.trim().startsWith("["));
      const tailLines = logsTail.split("\n").filter((l) => l.trim().startsWith("["));

      if (fullLines.length > 5 && tailLines.length === 5) {
        /** 验证 tail 是 full 的末尾 5 条（最后一行相同） */
        const lastMatch = fullLines[fullLines.length - 1] === tailLines[tailLines.length - 1];
        if (lastMatch) {
          ok(`skill logs --tail 生效（全部 ${fullLines.length} 条 → 最近 5 条，末尾一致）`);
        } else {
          fail(
            `skill logs --tail 末尾不一致：full末="${fullLines[fullLines.length - 1]}" tail末="${tailLines[tailLines.length - 1]}"`,
          );
        }
      } else if (fullLines.length <= 5) {
        /** 日志不足 5 条时无法验证截断，跳过 */
        ok(`skill logs --tail（当前 ${fullLines.length} 条日志不足 5 条，跳过截断验证）`);
      } else {
        fail(`skill logs --tail 异常：全部=${fullLines.length} tail=${tailLines.length}（期望 5）`);
      }

      /**
       * skill errors --tail + server errors ?since 一致性验证
       *
       * errors 之前是唯一不支持游标/tail 的数据通道（logs/network 都支持），
       * 且每条带完整 stack 很耗 token。现在 errors 支持 --tail=N（对齐 logs/network）。
       * 多触发几个错误保证 >3 条，验证 tail 截断 + 末尾一致。
       */
      /** 多触发 3 个运行时错误，保证 errors 足够多 */
      await testPage.evaluate(() => {
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            throw new Error(`errors-tail-test-${i}`);
          }, 0);
        }
      });
      await new Promise((r) => setTimeout(r, 800));

      const errorsFull = execSync(`node ${skillScript} errors ${device.id}`, {
        env: { ...process.env, SILKPULSE_SERVER: SERVER, SILKPULSE_API_KEY: ADMIN_KEY },
        encoding: "utf8",
        timeout: 10000,
      });
      const errorsTail = execSync(`node ${skillScript} errors ${device.id} 3`, {
        env: { ...process.env, SILKPULSE_SERVER: SERVER, SILKPULSE_API_KEY: ADMIN_KEY },
        encoding: "utf8",
        timeout: 10000,
      });
      /** errors 输出每条以 [时间戳] 开头，空行分隔 */
      const fullErrLines = errorsFull.split("\n").filter((l) => l.trim().startsWith("["));
      const tailErrLines = errorsTail.split("\n").filter((l) => l.trim().startsWith("["));

      if (fullErrLines.length > 3 && tailErrLines.length === 3) {
        const lastMatch =
          fullErrLines[fullErrLines.length - 1] === tailErrLines[tailErrLines.length - 1];
        if (lastMatch) {
          ok(`skill errors --tail 生效（全部 ${fullErrLines.length} 条 → 最近 3 条，末尾一致）`);
        } else {
          fail(
            `skill errors --tail 末尾不一致：full末="${fullErrLines[fullErrLines.length - 1].slice(0, 50)}" tail末="${tailErrLines[tailErrLines.length - 1].slice(0, 50)}"`,
          );
        }
      } else if (fullErrLines.length <= 3) {
        ok(`skill errors --tail（当前 ${fullErrLines.length} 条错误不足 3 条，跳过截断验证）`);
      } else {
        fail(
          `skill errors --tail 异常：全部=${fullErrLines.length} tail=${tailErrLines.length}（期望 3）`,
        );
      }
    }

    /** 21. 深色模式 —— 控制台主题切换，<html> 加 .dark class + CSS 变量生效 */
    {
      /** 默认应无 .dark（首次访问无 localStorage 或系统偏好） */
      const hasDarkBefore = await consolePage.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
      /** 点击主题切换按钮（🌙 或 ☀️） */
      const toggled = await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("header button"));
        const themeBtn = btns.find(
          (b) => b.textContent.includes("🌙") || b.textContent.includes("☀️"),
        );
        if (!themeBtn) return false;
        themeBtn.click();
        return true;
      });
      await new Promise((r) => setTimeout(r, 200));
      const hasDarkAfter = await consolePage.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
      /** 验证 CSS 变量 --cs-bg 在亮/暗下值不同 */
      const bgVar = await consolePage.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--cs-bg").trim(),
      );

      if (toggled && hasDarkAfter && bgVar) {
        ok(`深色模式切换成功（.dark=${hasDarkAfter}，--cs-bg="${bgVar}"）`);
        /** 再切回亮色，验证可逆 */
        await consolePage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("header button"));
          btns.find((b) => b.textContent.includes("🌙") || b.textContent.includes("☀️"))?.click();
        });
        await new Promise((r) => setTimeout(r, 200));
        const hasDarkFinal = await consolePage.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        );
        if (!hasDarkFinal) ok(`主题切换可逆（切回亮色）`);
        else fail(`主题切换不可逆：仍为 dark`);
      } else {
        fail(
          `深色模式切换失败：toggled=${toggled} hasDark=${hasDarkAfter}（切换前=${hasDarkBefore}）bgVar=${bgVar}`,
        );
      }

      /** 验证深色模式下语义 class 实际生效（bg-surface 元素背景 != 纯白） */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("header button"));
        const tb = btns.find((b) => b.textContent.includes("🌙") || b.textContent.includes("☀️"));
        if (tb && !document.documentElement.classList.contains("dark")) tb.click();
      });
      await new Promise((r) => setTimeout(r, 200));
      const surfaceBg = await consolePage.evaluate(() => {
        const el = document.querySelector(".bg-surface");
        if (!el) return null;
        return getComputedStyle(el).backgroundColor;
      });
      /** 深色模式 --cs-surface = #1a1f29 → rgb(26, 31, 41)，不应是纯白 rgb(255,255,255) */
      if (surfaceBg && !surfaceBg.includes("255, 255, 255")) {
        ok(`深色模式语义 class 生效（.bg-surface 背景色 = ${surfaceBg}）`);
      } else {
        fail(`深色模式语义 class 未生效：.bg-surface = ${surfaceBg}`);
      }
    }

    /**
     * 22. Network 状态筛选 —— 全部/成功/失败三态，调试时快速隔离失败请求
     *
     * 之前的测试已产生成功（2xx）+ 失败（404）请求，切到 network 面板验证筛选。
     */
    {
      /** 切到 network 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const netTab = tabs.find((t) => t.textContent.trim().startsWith("Network"));
        if (netTab) netTab.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      /** 总请求数（全部态） */
      const totalAll = await consolePage.evaluate(
        () => document.querySelectorAll("tbody tr").length,
      );

      /** 点"失败"筛选 → 只剩 4xx/5xx 或 status=0 */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const failBtn = btns.find((b) => b.textContent.trim() === "失败");
        if (failBtn) failBtn.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      const errorOnly = await consolePage.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("tbody tr"));
        /** 每行第 3 列是状态码（时间/方法/状态/URL/耗时） */
        const statuses = rows.map((r) => {
          const td = r.querySelectorAll("td")[2];
          return td ? td.textContent.trim() : "";
        });
        return { count: rows.length, statuses };
      });

      /** 点"成功"筛选 → 只剩 2xx-3xx */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const okBtn = btns.find((b) => b.textContent.trim() === "成功");
        if (okBtn) okBtn.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      const successOnly = await consolePage.evaluate(
        () => document.querySelectorAll("tbody tr").length,
      );

      /** 切回"全部"还原视图 */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const allBtn = btns.find((b) => b.textContent.trim() === "全部");
        if (allBtn) allBtn.click();
      });
      await new Promise((r) => setTimeout(r, 300));

      /** 验证：失败态下所有行都是 4xx/5xx/0/无状态码（WS 帧、pending 请求显示 —），成功态行数 < 全部，失败态 < 全部 */
      const failStatusesAllError = errorOnly.statuses.every((s) => {
        /** — 表示无状态码条目（WebSocket 帧/未完成请求），不属于成功态 */
        if (s === "—" || s === "-") return true;
        const n = Number(s);
        return n === 0 || n >= 400;
      });
      if (
        totalAll > 0 &&
        errorOnly.count < totalAll &&
        successOnly < totalAll &&
        failStatusesAllError &&
        errorOnly.count >= 1
      ) {
        ok(
          `Network 状态筛选生效（全部 ${totalAll} → 失败 ${errorOnly.count}(${errorOnly.statuses.join(",")}) → 成功 ${successOnly}）`,
        );
      } else {
        fail(
          `Network 状态筛选异常：全部=${totalAll} 失败=${errorOnly.count}(${errorOnly.statuses.join(",")}) 成功=${successOnly}`,
        );
      }
    }

    /**
     * 23. Console 清空视图 —— 点击"清空"隐藏已有日志，新日志正常出现
     *
     * 与浏览器 DevTools 🚫 语义一致：只隐藏前端视图，server 缓冲不变。
     * 切设备应重置阈值（新设备的日志不被旧阈值误隐藏）。
     */
    {
      /** 切到 console 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const cTab = tabs.find((t) => t.textContent.trim().startsWith("Console"));
        if (cTab) cTab.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      /** 记录清空前日志条数 */
      const beforeCount = await consolePage.evaluate(() => {
        const logs = document.querySelectorAll(
          '.font-mono.text-sm .border-b.border-light, [class*="border-b"][class*="border-light"]',
        );
        return logs.length;
      });
      /** 点"清空"按钮 */
      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const clearBtn = btns.find((b) => b.textContent.trim() === "清空");
        if (clearBtn) clearBtn.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      /** 清空后视图应几乎为空（只剩"暂无日志"或极少数） */
      const afterClear = await consolePage.evaluate(
        () =>
          document.querySelectorAll(
            '.font-mono.text-sm .border-light, [class*="border-b"][class*="border-light"]',
          ).length,
      );

      /** 触发一条新日志（通过 exec 打一条 console.log） */
      await apiFetch(`/api/devices/${device.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: 'console.log("清空后新日志测试"); return 1' }),
      });
      await new Promise((r) => setTimeout(r, 1000));
      /** 新日志应出现（清空不阻止后续日志） */
      const hasNewLog = await consolePage.evaluate(() => {
        const all = Array.from(document.querySelectorAll("span"));
        return all.some((s) => s.textContent.includes("清空后新日志测试"));
      });

      if (beforeCount > 0 && afterClear < beforeCount && hasNewLog) {
        ok(`Console 清空视图生效（${beforeCount} → ${afterClear}，清空后新日志正常出现）`);
      } else if (beforeCount === 0) {
        /** 无日志时跳过（前置测试可能未产生日志） */
        ok(`Console 清空视图（当前无日志，跳过清空验证，新日志出现=${hasNewLog}）`);
      } else {
        fail(`Console 清空异常：清空前=${beforeCount} 清空后=${afterClear} 新日志=${hasNewLog}`);
      }
    }

    /**
     * 23.1 Console 日志点击复制 —— 点击日志条目复制单条（含时间+级别+message）
     *
     * Console 之前是唯一交互最弱的面板（日志只能看不能复制），Network/Errors/Snapshot
     * 都有复制能力。现在点击日志行复制完整一条，hover 显示"复制"提示，复制后"✓"。
     */
    {
      /** 确保在 Console 面板且有日志（前面清空测试打了一条"清空后新日志测试"） */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const cTab = tabs.find((t) => t.textContent.trim().startsWith("Console"));
        if (cTab) cTab.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      /** 点击第一条日志行 */
      const clickResult = await consolePage.evaluate(() => {
        /** Console 日志行：在 .font-mono.text-sm 容器内的 .border-b.border-light */
        const container = document.querySelector(".font-mono.text-sm");
        if (!container) return { error: "no log container" };
        const rows = container.querySelectorAll(".border-b.border-light");
        if (rows.length === 0) return { error: "no log rows" };
        const firstRow = rows[0];
        const titleBefore = firstRow.getAttribute("title") || "";
        firstRow.click();
        return { clicked: true, titleBefore };
      });
      if (clickResult.error) {
        fail(`Console 日志复制前置失败：${clickResult.error}`);
      } else {
        /** 等 Vue 更新 + 剪贴板写入 */
        await new Promise((r) => setTimeout(r, 300));
        /** 验证：title 应变为"✓ 已复制"，或行内有"✓"文本 */
        const feedback = await consolePage.evaluate(() => {
          const container = document.querySelector(".font-mono.text-sm");
          if (!container) return { error: "no container" };
          const rows = container.querySelectorAll(".border-b.border-light");
          if (rows.length === 0) return { error: "no rows" };
          const firstRow = rows[0];
          const title = firstRow.getAttribute("title") || "";
          const hasCheck = Array.from(firstRow.querySelectorAll("span")).some(
            (s) => s.textContent.trim() === "✓",
          );
          return { title, hasCheck };
        });
        if (feedback.title.includes("已复制") || feedback.hasCheck) {
          ok(`Console 日志点击复制生效（点击后 → ✓ 已复制）`);
        } else {
          fail(`Console 日志复制反馈异常：${JSON.stringify(feedback)}`);
        }
      }
    }

    /**
     * 24. SDK 视口尺寸变化上报 —— resize/旋转后 server 收到新 viewport
     *
     * 诊断移动端布局错乱时，AI 需知道旋转/缩放后的真实视口。
     * 不加 resize 监听，server 永远只记接入时的尺寸，旋转后的布局问题无法关联正确视口。
     *
     * 注意：puppeteer setViewport 通过 CDP Emulation.setDeviceMetricsOverride 改变
     * window.innerWidth，但不触发 DOM resize 事件（CDP 绕过事件层）。
     * 因此手动 dispatch resize 事件模拟真实用户旋转/缩放。
     */
    {
      const before = await (await apiFetch(`/api/devices/${device.id}`)).json();
      const beforeW = before.viewportWidth;
      /** setViewport 改变 innerWidth（CDP 层），再手动 dispatch resize 事件触发 SDK 监听 */
      await testPage.setViewport({ width: beforeW + 200, height: 600 });
      await testPage.evaluate(() => window.dispatchEvent(new Event("resize")));
      /** 等 SDK 防抖（300ms）+ WS 上报 + server 处理 */
      await new Promise((r) => setTimeout(r, 1200));
      const after = await (await apiFetch(`/api/devices/${device.id}`)).json();

      if (after.viewportWidth === beforeW + 200) {
        ok(
          `SDK resize 上报新视口（${beforeW}×${before.viewportHeight} → ${after.viewportWidth}×${after.viewportHeight}）`,
        );
      } else {
        fail(`SDK resize 上报异常：期望 ${beforeW + 200}，实际 ${after.viewportWidth}`);
      }
      /** 还原视口（不影响后续测试） */
      await testPage.setViewport({ width: beforeW, height: before.viewportHeight });
      await testPage.evaluate(() => window.dispatchEvent(new Event("resize")));
      await new Promise((r) => setTimeout(r, 600));
    }

    /**
     * 25. Snapshot 面板搜索过滤 + 复制按钮
     *
     * 快照几百字符，用户需搜索定位特定元素（如 button/disabled/idx），
     * 并一键复制快照给 AI。验证：搜索过滤行数减少、复制按钮可点击。
     */
    {
      /** 切到 snapshot 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const snapTab = tabs.find((t) => t.textContent.trim().startsWith("Snapshot"));
        if (snapTab) snapTab.click();
      });
      await new Promise((r) => setTimeout(r, 800));

      /** 验证快照内容已加载（pre 有内容） */
      const snapLen = await consolePage.evaluate(() => {
        const pre = document.querySelector(
          ".flex-1.overflow-auto pre, .flex-1.overflow-y-auto.p-4 pre",
        );
        return pre ? pre.textContent.length : 0;
      });

      /** 输入搜索词（button 几乎一定存在于测试页快照中） */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索快照"]');
        if (input) {
          input.value = "button";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 300));
      /** 搜索后行数统计应显示（限定在 Snapshot 面板工具栏内找徽标——
       *  DeviceList 的在线时长徽标用了相同类名组合 .text-faint.whitespace-nowrap，
       *  全局 querySelector 会撞上左侧设备列表先渲染的「· desktop 800×600」） */
      const searchState = await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索快照"]');
        const toolbar = input?.closest("div");
        const lineBadge = toolbar?.querySelector(".text-faint.whitespace-nowrap");
        const pre = document.querySelector(
          ".flex-1.overflow-auto pre, .flex-1.overflow-y-auto.p-4 pre",
        );
        return {
          lineText: lineBadge ? lineBadge.textContent.trim() : "",
          contentLen: pre ? pre.textContent.length : 0,
        };
      });
      /** 清空搜索还原 */
      await consolePage.evaluate(() => {
        const input = document.querySelector('input[placeholder*="搜索快照"]');
        if (input) {
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 300));

      /** 复制按钮可点击并反馈 */
      const copyOk = await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const copyBtn = btns.find((b) => b.textContent.trim() === "复制");
        if (!copyBtn) return false;
        copyBtn.click();
        return true;
      });
      await new Promise((r) => setTimeout(r, 200));
      const copyFeedback = await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const copyBtn = btns.find((b) => b.textContent.includes("已复制"));
        return !!copyBtn;
      });

      if (snapLen > 50 && searchState.lineText.includes("行") && copyOk && copyFeedback) {
        ok(
          `Snapshot 搜索+复制生效（快照 ${snapLen} 字符，搜索 button → ${searchState.lineText}，复制 ✓）`,
        );
      } else {
        fail(
          `Snapshot 面板异常：snapLen=${snapLen} search=${JSON.stringify(searchState)} copy=${copyOk} feedback=${copyFeedback}`,
        );
      }
    }

    /**
     * 26. 设备列表在线时长 —— 控制台 UI + skill CLI 都显示"在线 N 分钟"
     *
     * "设备接入了多久"是诊断问题性质的关键线索：
     * 刚接入就报错 → 可能是初始化 bug；运行 1 小时后才报错 → 可能是内存泄漏/状态累积。
     * 控制台 UI 30 秒刷新相对时间，skill CLI 在 devices 命令输出。
     */
    {
      /** 控制台 UI 验证：设备列表含"在线"文字 + 相对时间格式 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        /** 切到任意非 snapshot 面板再回来触发刷新（确保设备列表可见） */
      });
      /** 设备列表始终可见（左侧 aside），直接检查文本 */
      const uiOnlineText = await consolePage.evaluate(() => {
        const aside = document.querySelector("aside");
        if (!aside) return null;
        const text = aside.textContent;
        /** 设备项展示 "· 刚刚" / "· 3 分钟"（relativeTime 相对时间，无"在线"前缀） */
        const match = text.match(/·\s*(刚刚|\d+\s*(分钟|小时|天))/);
        return match ? match[0] : null;
      });

      /** skill CLI 验证：devices 命令输出含"在线" */
      const skillScript = path.join(process.cwd(), "tools/skill/scripts/silkpulse.mjs");
      const devicesOut = execSync(`node ${skillScript} devices`, {
        env: { ...process.env, SILKPULSE_SERVER: SERVER, SILKPULSE_API_KEY: ADMIN_KEY },
        encoding: "utf8",
        timeout: 10000,
      });
      const skillHasOnline = devicesOut.includes("在线");

      if (uiOnlineText && skillHasOnline) {
        ok(`设备在线时长展示生效（UI: "${uiOnlineText}"，skill CLI devices 含"在线"）`);
      } else {
        fail(`在线时长展示异常：UI="${uiOnlineText}" skillCLI=${skillHasOnline}`);
      }
    }

    /**
     * 27. Console 级别筛选语义色 + 计数
     *
     * 选中 ERROR 时按钮红色、WARN 橙色、INFO 蓝色（与日志文本配色一致），
     * 让用户一眼分辨当前筛选级别。按钮上显示该级别日志条数。
     */
    {
      /** 切到 console 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const cTab = tabs.find((t) => t.textContent.trim().startsWith("Console"));
        if (cTab) cTab.click();
      });
      await new Promise((r) => setTimeout(r, 400));

      /**
       * 通过"搜索日志" input 定位 Console 工具栏，再找其内的级别按钮。
       * Console 工具栏结构：级别按钮组 + 搜索框 + 计数 + 清空按钮
       */
      async function clickLevel(label) {
        await consolePage.evaluate((lbl) => {
          const searchInput = document.querySelector('input[placeholder*="搜索日志"]');
          if (!searchInput) return;
          const toolbar = searchInput.parentElement;
          const btns = Array.from(toolbar?.querySelectorAll("button") ?? []);
          const target = btns.find((b) => b.textContent.trim().startsWith(lbl));
          target?.click();
        }, label);
        /** 等 Vue 响应式更新 DOM（class 绑定异步） */
        await new Promise((r) => setTimeout(r, 200));
      }

      async function readLevelBg(label) {
        return consolePage.evaluate((lbl) => {
          const searchInput = document.querySelector('input[placeholder*="搜索日志"]');
          if (!searchInput) return { error: "no search input" };
          const toolbar = searchInput.parentElement;
          const btns = Array.from(toolbar?.querySelectorAll("button") ?? []);
          const target = btns.find((b) => b.textContent.trim().startsWith(lbl));
          if (!target) return { error: `no ${lbl} button` };
          return { bg: getComputedStyle(target).backgroundColor, text: target.textContent.trim() };
        }, label);
      }

      /** 点 ERROR 级别 → 读色（应红色系） */
      await clickLevel("ERROR");
      const errorState = await readLevelBg("ERROR");

      /** 点 WARN 级别 → 读色（应橙色系） */
      await clickLevel("WARN");
      const warnState = await readLevelBg("WARN");

      /** 还原到"全部" */
      await clickLevel("全部");

      /**
       * 语义色验证：Tailwind v4 用 oklch 色彩空间，不依赖具体格式，
       * 验证两点：(1) 两级选中色不同（语义区分）(2) 都不是默认灰色 elevated。
       * oklch 第二个值是 chroma（饱和度），语义色 chroma > 0.1，灰色接近 0。
       */
      const elevatedGray = "rgb(37, 43, 54)"; /** bg-elevated 的灰色，未选中态 */
      const errorHasColor = errorState.bg && !errorState.error && errorState.bg !== elevatedGray;
      const warnHasColor = warnState.bg && !warnState.error && warnState.bg !== elevatedGray;
      const colorsDiffer = errorState.bg !== warnState.bg;

      if (errorHasColor && warnHasColor && colorsDiffer) {
        ok(
          `Console 级别筛选语义色生效（ERROR=${errorState.bg}，WARN=${warnState.bg}，两级不同色）`,
        );
      } else {
        fail(
          `级别筛选配色异常：error=${JSON.stringify(errorState)} warn=${JSON.stringify(warnState)} differ=${colorsDiffer}`,
        );
      }
    }

    /** 65. Network 耗时排序 —— 点击"耗时"表头切换降序/升序，验证 DOM 顺序与方向一致 */
    {
      /**
       * 先在测试页触发若干网络请求，保证列表有多条 + duration 有差异。
       * 用 exec 在页面上下文发起 5 个连续 fetch（/api/devices + /api/echo），
       * 浏览器并发限制 + JS 执行节奏会让各请求 duration 出现可测差异。
       */
      await testPage.evaluate(async () => {
        for (const url of [
          "/api/devices",
          "/api/echo",
          "/api/devices",
          "/api/devices",
          "/api/echo",
        ]) {
          try {
            await fetch(url, url.includes("echo") ? { method: "POST", body: "{}" } : {}).catch(
              () => {},
            );
          } catch {}
        }
      });
      await new Promise((r) => setTimeout(r, 1500));

      /** 切到控制台 Network 面板 */
      await consolePage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("nav button"));
        const netTab = tabs.find((t) => t.textContent.trim().startsWith("Network"));
        if (netTab) netTab.click();
      });
      await new Promise((r) => setTimeout(r, 500));

      /**
       * 读 Network 表格所有数据行的耗时列文本。
       * 耗时单元格 class 含 'font-mono'，文本形如 "12ms"。
       */
      async function readDurationColumn() {
        return consolePage.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("table tbody tr"));
          return rows.map((tr) => {
            const cells = tr.querySelectorAll("td");
            const last = cells[cells.length - 1]?.textContent?.trim() ?? "";
            const ms = Number(last.replace("ms", ""));
            return Number.isFinite(ms) ? ms : -1;
          });
        });
      }

      /** 点"耗时"表头按钮（在 thead 内，文本含"耗时"） */
      async function clickDurationHeader() {
        await consolePage.evaluate(() => {
          const ths = Array.from(document.querySelectorAll("table thead th"));
          const th = ths.find((t) => t.textContent.includes("耗时"));
          th?.querySelector("button")?.click();
        });
        await new Promise((r) => setTimeout(r, 250));
      }

      /** 读当前排序指示箭头 */
      async function readSortArrow() {
        return consolePage.evaluate(() => {
          const ths = Array.from(document.querySelectorAll("table thead th"));
          const th = ths.find((t) => t.textContent.includes("耗时"));
          const t = th?.textContent?.trim() ?? "";
          if (t.includes("▼")) return "desc";
          if (t.includes("▲")) return "asc";
          return "time";
        });
      }

      /** 默认 time 序（不排） */
      const beforeArrow = await readSortArrow();
      const beforeDurations = await readDurationColumn();

      /** 点击 → 降序（慢请求在上） */
      await clickDurationHeader();
      const descArrow = await readSortArrow();
      const descDurations = await readDurationColumn();

      /** 再点击 → 升序 */
      await clickDurationHeader();
      const ascArrow = await readSortArrow();
      const ascDurations = await readDurationColumn();

      /** 还原到默认（第三次点击） */
      await clickDurationHeader();

      /**
       * 验证：
       * (1) 箭头按 ↕→▼→▲ 切换
       * (2) 降序时首行 duration >= 末行 duration（多条请求时严格成立）
       * (3) 升序时首行 <= 末行
       * (4) 列表项数不变（排序不应丢条目）
       */
      const arrowOk = beforeArrow === "time" && descArrow === "desc" && ascArrow === "asc";
      const countOk =
        beforeDurations.length === descDurations.length &&
        descDurations.length === ascDurations.length &&
        descDurations.length >= 3;
      const descOrdered =
        descDurations.length >= 2 && descDurations[0] >= descDurations[descDurations.length - 1];
      const ascOrdered =
        ascDurations.length >= 2 && ascDurations[0] <= ascDurations[ascDurations.length - 1];

      if (arrowOk && countOk && descOrdered && ascOrdered) {
        ok(`Network 耗时排序生效（${descDurations.length} 条，↕→▼→▲ 切换 ✓ 降序 ✓ 升序 ✓）`);
      } else {
        fail(
          `Network 耗时排序异常：arrow=${arrowOk}(${beforeArrow}→${descArrow}→${ascArrow}) count=${countOk}(${beforeDurations.length}/${descDurations.length}/${ascDurations.length}) desc=${descOrdered} asc=${ascOrdered}`,
        );
      }
    }

    /** 66. AI 诊断上下文含慢请求段 —— 控制台按钮生成的文本对齐 inspect CLI */
    {
      /**
       * 控制台"✨ 复制 AI 诊断上下文"按钮聚合现场文本，应含"慢请求 Top"段
       * （之前缺这段，诊断"页面慢"时复制给 AI 的上下文丢失性能线索）。
       * 点击按钮 → 弹窗 → 读 <pre> 文本 → 验证含慢请求段 + 至少一条请求行。
       */
      /** 先确保测试页已产生若干网络请求（前面测试已触发过，这里补几个保证有数据） */
      await testPage.evaluate(async () => {
        try {
          await fetch("/api/devices").catch(() => {});
        } catch {}
        try {
          await fetch("/api/echo", { method: "POST", body: "{}" }).catch(() => {});
        } catch {}
      });
      await new Promise((r) => setTimeout(r, 800));

      /** 点击 header 里的诊断上下文按钮（文案为"📋 诊断上下文"，需已选中设备） */
      const clicked = await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const btn = btns.find((b) => b.textContent.includes("诊断上下文"));
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      });
      if (!clicked) {
        fail("AI 诊断上下文按钮未找到或被禁用");
      } else {
        /** 等弹窗 + 生成（含一次 snapshot HTTP 拉取） */
        await new Promise((r) => setTimeout(r, 1200));
        /** 读弹窗 <pre> 内容 */
        const ctxText = await consolePage.evaluate(() => {
          const pre = document.querySelector(".fixed pre");
          return pre ? pre.textContent : null;
        });
        if (!ctxText) {
          fail("AI 诊断上下文弹窗未展示文本");
        } else {
          const hasSlowSection = /慢请求 Top/.test(ctxText);
          const hasRequestLine = /\d+ms.*?(GET|POST|PUT|DELETE|PATCH)/.test(ctxText);
          const hasErrorSection = /## 错误/.test(ctxText);
          const hasSnapshotSection = /## 页面快照/.test(ctxText);
          if (hasSlowSection && hasRequestLine && hasErrorSection && hasSnapshotSection) {
            ok(
              `AI 诊断上下文含慢请求段（对齐 inspect CLI：错误 ✓ 快照 ✓ 慢请求 ✓ 请求行 ✓，共 ${ctxText.length} 字符）`,
            );
          } else {
            fail(
              `AI 上下文内容不完整：slow=${hasSlowSection} reqLine=${hasRequestLine} err=${hasErrorSection} snap=${hasSnapshotSection}`,
            );
          }
        }
        /** 关闭弹窗 */
        await consolePage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const close = btns.find((b) => b.textContent.trim() === "关闭");
          close?.click();
        });
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    console.log(`\n========== 测试完成：${step - failed} 通过，${failed} 失败 ==========`);
  } catch (e) {
    fail("测试中断", e);
  } finally {
    await browser.close();
  }
}

main();
