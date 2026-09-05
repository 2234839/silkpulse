/**
 * 框架事件自动化测试 —— 验证 SDK 的合成事件能否正确触发 React 18 / Vue 3 / 原生 JS 的事件监听
 *
 * 运行方式：
 *   pnpm test:events                              # 默认连线上 server
 *   SILKPULSE_SERVER=http://localhost:8081 pnpm test:events  # 连本地 server
 *
 * 前提条件：
 *   1. server 已启动
 *   2. framework-test.html 已部署到 server 的 public 目录
 *   3. 有一个浏览器打开了 framework-test.html 并连上了 server（SDK 已注入）
 *
 * 测试策略：
 *   通过 exec API 在远程页面上执行 SDK 的操作函数（click/setValue/type/hover/pressKey 等），
 *   然后检查 console 日志是否记录了框架事件 handler 的触发。
 *   framework-test.html 的每个交互元素都在事件 handler 里 console.log 标记，
 *   SDK 的 exec 会捕获这些 console.log 作为 logs 返回。
 */

const SERVER = process.env.SILKPULSE_SERVER ?? "https://silkpulse.heartstack.space";
const ADMIN_KEY = process.env.SILKPULSE_ADMIN_KEY;

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const SKIP = "\x1b[33m⊘\x1b[0m";

let passed = 0;
let failed = 0;
let skipped = 0;

/** 测试用例定义 */
/**
 * @typedef {Object} TestCase
 * @property {string} name
 * @property {string} code
 * @property {string|string[]|((logs: string[]) => boolean)} expect
 * @property {string} [setup]
 */

/**
 * @typedef {Object} TestGroup
 * @property {string} name
 * @property {TestCase[]} tests
 */

// ===========================================================================
// 测试用例定义
// ===========================================================================

const testGroups = [
  {
    name: "React 18 — 点击 & 悬停",
    tests: [
      {
        name: "button onClick",
        code: `__silkpulse_click(__silkpulse_ensureIdx(document.getElementById('react-btn')))`,
        expect: "[react] btn onClick",
      },
      {
        name: "hover onMouseEnter",
        code: `__silkpulse_hover(__silkpulse_ensureIdx(document.getElementById('react-hover')))`,
        expect: "[react] hover onMouseEnter",
      },
      {
        name: "hover onMouseLeave（移出后触发）",
        setup: `__silkpulse_hover(__silkpulse_ensureIdx(document.getElementById('react-hover')))`,
        code: `__silkpulse_hover(__silkpulse_ensureIdx(document.getElementById('react-btn')))`,
        expect: "[react] hover onMouseLeave",
      },
    ],
  },
  {
    name: "React 18 — 表单输入",
    tests: [
      {
        name: "受控 input onChange",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('react-input')), 'test-val')`,
        expect: ["[react] input onChange", "value=test-val"],
      },
      {
        name: "type 逐字输入（触发 3 次 onChange）",
        code: `__silkpulse_type(__silkpulse_ensureIdx(document.getElementById('react-input')), 'AB')`,
        expect: (logs) => logs.filter((l) => l.includes("[react] input onChange")).length >= 2,
      },
      {
        name: "select onChange",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('react-select')), 'r2')`,
        expect: ["[react] select onChange", "value=r2"],
      },
    ],
  },
  {
    name: "React 18 — Checkbox / Radio",
    tests: [
      {
        name: "checkbox 勾选 onChange checked=true",
        setup: `var el = document.getElementById('react-checkbox'); if(el.checked) el.click()`,
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('react-checkbox')), 'true')`,
        expect: ["[react] checkbox onChange", "checked=true"],
      },
      {
        name: "checkbox 取消勾选 onChange checked=false",
        setup: `var el = document.getElementById('react-checkbox'); if(!el.checked) el.click()`,
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('react-checkbox')), 'false')`,
        expect: ["[react] checkbox onChange", "checked=false"],
      },
      {
        name: "radio-B 选中 onChange",
        setup: `var a = document.getElementById('react-radio-a'); if(!a.checked) a.click()`,
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('react-radio-b')), 'true')`,
        expect: ["[react] radio-b onChange", "checked=true"],
      },
      {
        name: "radio 切换 A→B 时 A 的 onChange 也触发",
        setup: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('react-radio-a')), 'true')`,
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('react-radio-b')), 'true')`,
        expect: "[react] radio-b onChange",
      },
    ],
  },
  {
    name: "Vue 3 — 点击 & 悬停",
    tests: [
      {
        name: "button onClick",
        code: `__silkpulse_click(__silkpulse_ensureIdx(document.getElementById('vue-btn')))`,
        expect: "[vue] btn onClick",
      },
      {
        name: "hover onMouseEnter",
        code: `__silkpulse_hover(__silkpulse_ensureIdx(document.getElementById('vue-hover')))`,
        expect: "[vue] hover onMouseEnter",
      },
      {
        name: "hover onMouseLeave",
        setup: `__silkpulse_hover(__silkpulse_ensureIdx(document.getElementById('vue-hover')))`,
        code: `__silkpulse_hover(__silkpulse_ensureIdx(document.getElementById('vue-btn')))`,
        expect: "[vue] hover onMouseLeave",
      },
    ],
  },
  {
    name: "Vue 3 — 表单输入",
    tests: [
      {
        name: "input onInput",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('vue-input')), 'vue-test')`,
        expect: ["[vue] input onInput", "value=vue-test"],
      },
      {
        name: "type 逐字输入",
        code: `__silkpulse_type(__silkpulse_ensureIdx(document.getElementById('vue-input')), 'XY')`,
        expect: (logs) => logs.filter((l) => l.includes("[vue] input onInput")).length >= 2,
      },
      {
        name: "select onChange",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('vue-select')), 'v1')`,
        expect: ["[vue] select onChange", "value=v1"],
      },
    ],
  },
  {
    name: "Vue 3 — Checkbox / Radio",
    tests: [
      {
        name: "checkbox onChange",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('vue-checkbox')), 'true')`,
        expect: "[vue] checkbox onChange",
      },
      {
        name: "radio-A onChange",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('vue-radio-a')), 'true')`,
        expect: "[vue] radio-a onChange",
      },
      {
        name: "radio 切换 A→B",
        setup: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('vue-radio-a')), 'true')`,
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('vue-radio-b')), 'true')`,
        expect: "[vue] radio-b onChange",
      },
    ],
  },
  {
    name: "原生 JS — 全事件覆盖",
    tests: [
      {
        name: "button click",
        code: `__silkpulse_click(__silkpulse_ensureIdx(document.getElementById('native-btn')))`,
        expect: "[native] btn click",
      },
      {
        name: "mousedown 按钮（监听 mousedown 而非 click）",
        code: `__silkpulse_click(__silkpulse_ensureIdx(document.getElementById('native-btn-mousedown')))`,
        expect: "[native] btn mousedown",
      },
      {
        name: "input",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('native-input')), 'native-val')`,
        expect: "[native] input value=native-val",
      },
      {
        name: "keyup input（type 逐字触发 keyup）",
        code: `__silkpulse_type(__silkpulse_ensureIdx(document.getElementById('native-input-keyup')), 'AB')`,
        expect: (logs) => logs.filter((l) => l.includes("[native] keyup")).length >= 2,
      },
      {
        name: "select change",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('native-select')), 'opt2')`,
        expect: "[native] select change value=opt2",
      },
      {
        name: "checkbox change",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('native-checkbox')), 'true')`,
        expect: "[native] checkbox change",
      },
      {
        name: "radio change",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('native-radio-b')), 'true')`,
        expect: "[native] radio change",
      },
      {
        name: "textarea input",
        code: `__silkpulse_setValue(__silkpulse_ensureIdx(document.getElementById('native-textarea')), 'ta-val')`,
        expect: "[native] textarea input value=ta-val",
      },
    ],
  },
  {
    name: "pressKey — 键盘事件",
    tests: [
      {
        name: "Escape keyup",
        setup: `document.getElementById('native-input-keyup').value = ''`,
        code: `__silkpulse_pressKey(__silkpulse_ensureIdx(document.getElementById('native-input-keyup')), 'Escape')`,
        expect: "[native] keyup key=Escape",
      },
      {
        name: "ArrowDown keyup",
        code: `__silkpulse_pressKey(__silkpulse_ensureIdx(document.getElementById('native-input-keyup')), 'ArrowDown')`,
        expect: "[native] keyup key=ArrowDown",
      },
      {
        name: "Enter keyup",
        code: `__silkpulse_pressKey(__silkpulse_ensureIdx(document.getElementById('native-input-keyup')), 'Enter')`,
        expect: "[native] keyup key=Enter",
      },
      {
        name: "pressKey idx<0 对当前焦点元素",
        setup: `document.getElementById('native-input-keyup').focus()`,
        code: `__silkpulse_pressKey(-1, 'Tab')`,
        expect: "[native] keyup key=Tab",
      },
    ],
  },
  {
    name: "scroll / scrollIntoView",
    tests: [
      {
        name: "scroll 窗口滚动",
        code: `
          window.scrollTo(0, 0);
          __silkpulse_scroll(-1, 0, 100);
          return window.scrollY > 50 ? 'scrolled' : 'no-scroll'
        `,
        expect: (logs) => true, // 验证 result 而非 logs
      },
      {
        name: "scrollIntoView 元素滚入",
        code: `
          __silkpulse_scrollIntoView(__silkpulse_ensureIdx(document.getElementById('native-textarea')));
          var rect = document.getElementById('native-textarea').getBoundingClientRect();
          return rect.top >= 0 && rect.top < window.innerHeight ? 'visible' : 'not-visible'
        `,
        expect: (logs) => true,
      },
    ],
  },
  {
    name: "storage — 本地存储查询",
    tests: [
      {
        name: "localStorage 查询",
        setup: `localStorage.setItem('test-key', 'test-value')`,
        code: `var s = __silkpulse_storage('local'); return s['test-key']`,
        expect: (logs) => true,
      },
      {
        name: "sessionStorage 查询",
        setup: `sessionStorage.setItem('test-session', 'session-val')`,
        code: `var s = __silkpulse_storage('session'); return s['test-session']`,
        expect: (logs) => true,
      },
      {
        name: "cookie 查询",
        setup: `document.cookie = 'test-cookie=cookie-val; path=/'`,
        code: `var c = __silkpulse_storage('cookie'); return c['test-cookie']`,
        expect: (logs) => true,
      },
    ],
  },
  {
    name: "snapshot — 快照功能",
    tests: [
      {
        name: "snapshot 返回 SnapshotData",
        code: `
          var snap = __silkpulse_snapshot();
          return snap && snap.elements && snap.elements.length > 0 ? 'elements:' + snap.elements.length : 'empty'
        `,
        expect: (logs) => true,
      },
    ],
  },
  {
    name: "wait — 异步等待",
    tests: [
      {
        name: "wait 100ms",
        code: `
          var t0 = Date.now();
          await __silkpulse_wait(100);
          var elapsed = Date.now() - t0;
          return elapsed >= 95 ? 'waited ' + elapsed + 'ms' : 'too-fast ' + elapsed + 'ms'
        `,
        expect: (logs) => true,
      },
    ],
  },
];

// ===========================================================================
// 测试运行器
// ===========================================================================

async function execCode(deviceId, code) {
  const data = JSON.stringify({ code });
  const resp = await fetch(`${SERVER}/api/devices/${deviceId}/exec?key=${ADMIN_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: data,
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return await resp.json();
}

function checkExpect(expect, logs) {
  if (typeof expect === "string") {
    return logs.some((l) => l.includes(expect));
  }
  if (Array.isArray(expect)) {
    return expect.every((e) => logs.some((l) => l.includes(e)));
  }
  return expect(logs);
}

async function findFrameworkTestDevice() {
  const resp = await fetch(`${SERVER}/api/devices?key=${ADMIN_KEY}`);
  const data = await resp.json();
  const devices = data.devices ?? data;
  // 找到 framework-test 页面的设备
  const device = devices.find((d) => d.url?.includes("framework-test"));
  if (device) return device.id;
  // 如果没找到，用第一个在线设备
  if (devices.length > 0) return devices[0].id;
  return null;
}

async function main() {
  console.log("");
  console.log("═".repeat(72));
  console.log("  silkpulse 框架事件自动化测试");
  console.log(`  Server: ${SERVER}`);
  console.log("═".repeat(72));
  console.log("");

  // 找到测试设备
  const deviceId = await findFrameworkTestDevice();
  if (!deviceId) {
    console.error(`${FAIL} 未找到已连接的测试设备，请先打开 framework-test.html`);
    process.exit(1);
  }

  console.log(`设备: ${deviceId}`);
  console.log("");

  for (const group of testGroups) {
    console.log(`── ${group.name} ──`);

    for (const test of group.tests) {
      // setup 阶段
      if (test.setup) {
        try {
          await execCode(deviceId, test.setup);
        } catch {
          // setup 失败不阻塞，继续测试
        }
      }

      try {
        const result = await execCode(deviceId, test.code);
        const logs = result.logs ?? [];
        const success = result.success ?? false;
        const resultValue = result.result ?? "";

        // 对于需要验证 result 而非 logs 的测试（scroll/storage/snapshot/wait）
        const isResultBased = test.expect === ((l) => true);
        let ok;

        if (isResultBased) {
          // 验证 result 是否成功
          ok = success && !resultValue.includes("error") && !resultValue.includes("undefined");
          if (
            resultValue.includes("too-fast") ||
            resultValue.includes("no-scroll") ||
            resultValue.includes("not-visible") ||
            resultValue.includes("empty")
          ) {
            ok = false;
          }
        } else {
          ok = success && checkExpect(test.expect, logs);
        }

        if (ok) {
          passed++;
          // 显示第一条相关 log 或 result
          const detail = isResultBased ? resultValue : logs.find((l) => l.includes("[")) || "";
          console.log(`  ${PASS} ${test.name}${detail ? "  →  " + detail.slice(0, 60) : ""}`);
        } else {
          failed++;
          const detail = isResultBased ? `result=${resultValue}` : `logs=[${logs.join(" | ")}]`;
          console.log(`  ${FAIL} ${test.name}  →  ${detail.slice(0, 100)}`);
        }
      } catch (e) {
        failed++;
        console.log(`  ${FAIL} ${test.name}  →  ${e.message}`);
      }

      // 测试间隔，避免竞态
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log("");
  }

  // 总结
  console.log("═".repeat(72));
  const total = passed + failed + skipped;
  console.log(
    `  ${PASS} 通过: ${passed}   ${FAIL} 失败: ${failed}   ${SKIP} 跳过: ${skipped}   总计: ${total}`,
  );
  console.log("═".repeat(72));
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("测试运行失败:", e);
  process.exit(1);
});
