/** React 后注入诊断：逐步打印 recoverReactRoots 链路的实际状态 */
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";

let chrom = process.env.CHROMIUM_PATH;
if (!chrom) {
  for (const n of ["chromium-browser", "chromium", "google-chrome"]) {
    try {
      const f = execSync(`which ${n} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (f) {
        chrom = f;
        break;
      }
    } catch {}
  }
}
const b = await puppeteer.launch({ executablePath: chrom, headless: true, args: ["--no-sandbox"] });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
await p.goto("http://localhost:8080/post-inject-react-test.html", { waitUntil: "networkidle0" });

/** 注入前：确认 react 容器锚点 */
const before = await p.evaluate(() => {
  const el = document.getElementById("root");
  return {
    ready: window.__TEST_PAGE_READY__,
    containerKey: el
      ? Object.getOwnPropertyNames(el).find((k) => k.startsWith("__reactContainer$"))
      : null,
    reactVersion: window.React?.version,
  };
});
console.log("注入前:", JSON.stringify(before));

/** 后注入 SDK */
await p.evaluate((origin) => {
  const s = document.createElement("script");
  s.src = `${origin}/sdk.js`;
  s.dataset.server = origin;
  document.head.appendChild(s);
}, "http://localhost:8080");
await new Promise((r) => setTimeout(r, 2000));

/** 注入后立即看 stub 状态 */
const after = await p.evaluate(() => {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  return {
    hookExists: !!hook,
    isStub: hook?._isSilkPulseStub,
    renderersSize: hook?.renderers?.size,
    /** 检查每个 renderer 的关键字段 */
    renderersDetail: [...(hook?.renderers?.values() ?? [])].map((r) => ({
      version: r.version,
      reconcilerVersion: r.reconcilerVersion,
      bundleType: r.bundleType,
      hasFindFiber: typeof r.findFiberByHostInstance === "function",
    })),
  };
});
console.log("注入后 stub:", JSON.stringify(after));

/** 手动触发 tree 读取（会走 ensureReactBackendActive → activateBackend） */
const tree = await p.evaluate(async () => {
  try {
    const t = await window.__silkpulse_devtools_tree();
    return { treeNames: JSON.stringify(t).slice(0, 600) };
  } catch (e) {
    return { error: e.message };
  }
});
console.log("tree():", JSON.stringify(tree, null, 2));

/** 激活后看真 hook 状态 */
const activated = await p.evaluate(() => {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  return {
    isStub: hook?._isSilkPulseStub,
    renderersSize: hook?.renderers?.size,
    rendererInterfacesSize: hook?.rendererInterfaces?.size,
    fiberRootsCount:
      hook?.renderers?.size > 0
        ? [...hook.renderers.keys()].map((id) => hook.getFiberRoots(id).size)
        : [],
    backendGlobal: typeof window.ReactDevToolsBackend,
  };
});
console.log("激活后:", JSON.stringify(activated));
await b.close();
