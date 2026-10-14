#!/usr/bin/env node
/**
 * Vendor Chrome DevTools Elements 面板资产（chii frontend + chobitsu）
 *
 * 用法：
 *   node scripts/vendor-chrome-devtools.mjs            # 增量（version.json 完整则跳过）
 *   node scripts/vendor-chrome-devtools.mjs --force    # 强制重新拉取
 *
 * 产物 packages/server/public/plugins/chrome-devtools/：
 *   front_end/     —— chii 发布物 public/front_end（官方 devtools-frontend 构建，
 *                     entrypoints/chii_app 支持 embedded 模式 postMessage 通信）
 *   chobitsu.js    —— chobitsu UMD（目标页内应答 CDP DOM/CSS 等域）
 *   index.html     —— host 页（加载 chii_app，向 parent 发 ready 信号）
 *   version.json   —— 来源与版本记录（增量判断依据）
 *
 * 网络依赖 npm registry（https.get，无需登录），离线机器上已 vendor 过则直接跳过。
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import https from "node:https";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "packages/server/public/plugins/chrome-devtools");
const force = process.argv.includes("--force");

const CHII_VERSION = "1.15.5";
const CHOBITSU_VERSION = "1.8.6";

const isReady = () => {
  if (!existsSync(join(OUT_DIR, "version.json"))) return false;
  return (
    existsSync(join(OUT_DIR, "front_end/entrypoints/chii_app/chii_app.js")) &&
    existsSync(join(OUT_DIR, "chobitsu.js"))
  );
};

if (!force && isReady()) {
  const v = JSON.parse(readFileSync(join(OUT_DIR, "version.json"), "utf8"));
  console.log(
    `[chrome-devtools] 已 vendor（chii ${v.chii} / chobitsu ${v.chobitsu}），跳过资产拉取；host 页重写见下方`,
  );
  /** host 页照常重写：宿主增强脚本（面板切换等）迭代频繁，不应依赖 15MB 资产重拉 */
  writeHostPage();
  process.exit(0);
}

/** 下载 npm tarball 并解压到临时目录，返回解压路径 */
function fetchTarball(pkg, version) {
  const url = `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`;
  const tmpDir = join(tmpdir(), `silkpulse-${pkg}-${version}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const tgz = join(tmpDir, "pkg.tgz");
  const file = createWriteStream(tgz);
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`下载失败 ${res.statusCode}: ${url}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(tgz)));
      })
      .on("error", reject);
  }).then((tgzPath) => {
    execSync(`tar -xzf ${tgzPath} -C ${tmpDir}`);
    return join(tmpDir, "package");
  });
}

console.log(`[chrome-devtools] 下载 chii@${CHII_VERSION}（frontend 资产）…`);
const chiiDir = await fetchTarball("chii", CHII_VERSION);
const frontEndSrc = join(chiiDir, "public/front_end");
if (!existsSync(join(frontEndSrc, "entrypoints/chii_app/chii_app.js"))) {
  throw new Error("chii tarball 中找不到 front_end/entrypoints/chii_app —— 包结构可能变了，请检查");
}

console.log(`[chrome-devtools] 下载 chobitsu@${CHOBITSU_VERSION}…`);
const chobitsuDir = await fetchTarball("chobitsu", CHOBITSU_VERSION);
const chobitsuSrc = join(chobitsuDir, "dist/chobitsu.js");
if (!existsSync(chobitsuSrc)) {
  throw new Error("chobitsu tarball 中找不到 dist/chobitsu.js —— 包结构可能变了，请检查");
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
execSync(`cp -r ${frontEndSrc} ${join(OUT_DIR, "front_end")}`);
execSync(`cp ${chobitsuSrc} ${join(OUT_DIR, "chobitsu.js")}`);

/** 生成并写入 host 页（function 声明以便增量跳过分支也能调用） */
function writeHostPage() {
const hostHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<script src="https://unpkg.com/@ungap/custom-elements/es.js"></script>
</head>
<body class="undocked" id="-blink-dev-tools">
<script>
  (function () {
    var embeddedOrigin = location.ancestorOrigins && location.ancestorOrigins[0];
    if (!embeddedOrigin) {
      try { embeddedOrigin = new URL(document.referrer).origin; } catch (e) { embeddedOrigin = "*"; }
    }
    /** history.replaceState 不触发导航（location.replace 在加载中会 abort 当前文档），
     *  chii embedded 连接层在模块初始化时读 #?embedded=<origin> 作为 postMessage 目标 origin */
    history.replaceState(null, "", "#?embedded=" + encodeURIComponent(embeddedOrigin));
    window.addEventListener("load", function () {
      parent.postMessage({ event: "__silkpulse_frontend_ready__" }, "*");
    });
  })();
</script>
<script>
  /** SilkPulse 宿主增强：面板切换控制（Console 页签加载后自动切到官方面板） */
  (function () {
    /** 官方面板 tab 文案（中英双语，覆盖 frontend locale 差异） */
    var PANEL_TAB_TEXT = {
      console: ["console", "控制台"],
      elements: ["elements", "元素"],
    };
    /** 深度收集所有 tab（frontend 用 shadow DOM，普通 querySelectorAll 查不到） */
    function collectTabs(root, out) {
      if (!root) return;
      var els = root.querySelectorAll('[role="tablist"] [role="tab"]');
      for (var i = 0; i < els.length; i++) out.push(els[i]);
      var all = root.querySelectorAll("*");
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) collectTabs(all[j].shadowRoot, out);
      }
    }
    function findTab(names) {
      var out = [];
      collectTabs(document, out);
      for (var i = 0; i < out.length; i++) {
        var t = (out[i].textContent || "").trim().toLowerCase();
        if (names.indexOf(t) !== -1) return out[i];
      }
      return null;
    }
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.event !== "__silkpulse_switch_panel__") return;
      var names = PANEL_TAB_TEXT[d.panel];
      if (!names) return;
      function click() {
        var tab = findTab(names);
        if (!tab) return false;
        /** devtools tabbed-pane 只认完整鼠标序列，单纯 el.click() 不切换 */
        var r = tab.getBoundingClientRect();
        var opts = {
          bubbles: true,
          cancelable: true,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
          button: 0,
        };
        tab.dispatchEvent(new MouseEvent("mousedown", opts));
        tab.dispatchEvent(new MouseEvent("mouseup", opts));
        tab.dispatchEvent(new MouseEvent("click", opts));
        return true;
      }
      /** frontend 面板栏是异步渲染的：找不到就短轮询等它出现 */
      if (!click()) {
        var tries = 0;
        var timer = setInterval(function () {
          if (click() || ++tries > 40) clearInterval(timer);
        }, 250);
      }
    });
  })();
</script>
<script type="module" src="./front_end/entrypoints/chii_app/chii_app.js"></script>
</body>
</html>
`;
writeFileSync(join(OUT_DIR, "index.html"), hostHtml);
}
writeHostPage();

writeFileSync(
  join(OUT_DIR, "version.json"),
  JSON.stringify(
    {
      source: "chii+chobitsu",
      chii: CHII_VERSION,
      chobitsu: CHOBITSU_VERSION,
      vendoredAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(`[chrome-devtools] ✓ vendor 完成 → ${OUT_DIR}`);
