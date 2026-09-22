/**
 * Alt 点选元素（Element Picker）
 *
 * 参考 vite-plugin-pilot 的 Alt+Click Inspector：
 * - 按住 Alt 悬停：高亮当前元素（描边 + 标签提示）
 * - Alt+点击：弹出定位信息面板，可一键复制
 *
 * 复制内容不只是元素定位 + 提示词，还包含「本页面接入 SilkPulse 的具体调用方法」
 * （script 标签 + AI 侧的操控命令），用户直接发给 agent，agent 即知道如何操控
 * 这个页面以及要改哪个元素。密钥不包含（设备端本就不持有密钥）。
 */

import { ensureElementIdx } from "./snapshot.js";

/** 是否已激活 */
let active = false;

/** 高亮描边层 */
let outline: HTMLDivElement | null = null;
/** 悬停提示标签（tag#id.class） */
let tip: HTMLDivElement | null = null;
/** 点击后的信息面板 */
let panel: HTMLDivElement | null = null;

/** 注入面板所需的一次性样式（key 前缀避免冲突） */
const STYLE_ID = "__silkpulse_picker_style";

/** 注入样式 */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#__silkpulse_picker_outline{position:fixed;pointer-events:none;z-index:2147483646;
  outline:2px solid #3b82f6;outline-offset:0;background:rgba(59,130,246,.12);
  transition:all .05s ease}
#__silkpulse_picker_tip{position:fixed;pointer-events:none;z-index:2147483647;
  background:#1e293b;color:#f1f5f9;font:11px/1.4 ui-monospace,monospace;
  padding:2px 6px;border-radius:4px;white-space:nowrap}
#__silkpulse_picker_panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;
  width:420px;max-width:calc(100vw - 32px);max-height:70vh;overflow:auto;
  background:#ffffff;color:#1f2937;border:1px solid #e5e7eb;border-radius:10px;
  box-shadow:0 12px 40px rgba(0,0,0,.18);font:12px/1.6 -apple-system,sans-serif}
@media (prefers-color-scheme:dark){
  #__silkpulse_picker_panel{background:#1e293b;color:#e5e7eb;border-color:#374151}
}
#__silkpulse_picker_panel .sp-head{display:flex;align-items:center;gap:8px;
  padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.25);
  font-weight:600;font-size:13px}
#__silkpulse_picker_panel .sp-close{margin-left:auto;cursor:pointer;border:0;
  background:none;color:inherit;font-size:14px;opacity:.6;padding:2px 6px}
#__silkpulse_picker_panel .sp-close:hover{opacity:1}
#__silkpulse_picker_panel .sp-sec{padding:8px 12px;border-bottom:1px dashed rgba(128,128,128,.2)}
#__silkpulse_picker_panel .sp-sec:last-child{border-bottom:0}
#__silkpulse_picker_panel .sp-t{font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px}
#__silkpulse_picker_panel .sp-copy{margin-left:auto;cursor:pointer;border:1px solid #3b82f6;
  color:#3b82f6;background:none;border-radius:5px;font-size:10px;padding:1px 8px}
#__silkpulse_picker_panel .sp-copy:hover{background:#3b82f6;color:#fff}
#__silkpulse_picker_panel pre{background:rgba(128,128,128,.12);border-radius:6px;
  padding:8px;font:10.5px/1.5 ui-monospace,monospace;white-space:pre-wrap;
  word-break:break-all;max-height:160px;overflow:auto;margin:0}
`;
  document.head.appendChild(style);
}

/** 生成元素描述：tag#id.class1.class2 */
function describeEl(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  for (const c of el.classList) s += `.${c}`;
  return s;
}

/** 生成稳定 CSS 选择器（body 起始的路径，带 nth-of-type 兜底） */
function buildSelector(el: Element): string {
  /** 优先唯一 id */
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    let part = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter(
        (c) => c.tagName === cur!.tagName,
      );
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
    if (parts.length >= 6) break;
  }
  return `body ${parts.join(" > ")}`;
}

/** 读取本页接入配置（server / projectId），用于生成「接入调用方法」 */
function getInjectInfo(): { server: string; projectId?: string } {
  const server =
    (window as unknown as Record<string, unknown>).__SILKPULSE_SERVER__ as
      | string
      | undefined ?? "";
  /** 从本页 SDK script 标签回读 projectId（autoInit 注入的场景） */
  const script = document.querySelector("script[data-project-id]");
  const projectId = script?.getAttribute("data-project-id") ?? undefined;
  return { server, projectId };
}

/** 拼 script 标签字符串（避免在模板里直接写尖括号被解析） */
function scriptTag(server: string, projectId?: string): string {
  const lt = String.fromCharCode(60);
  const gt = String.fromCharCode(62);
  let s = `${lt}script src="${server}/sdk.js" data-server="${server}"`;
  if (projectId) s += ` data-project-id="${projectId}"`;
  return `${s}${gt}${lt}/script${gt}`;
}

/** 构建完整可复制的「AI 指令」文本：定位信息 + 提示词 + 接入调用方法 */
function buildCopyText(el: Element): string {
  const idx = ensureElementIdx(el);
  const rect = el.getBoundingClientRect();
  const text = (el.textContent ?? "").trim().slice(0, 80);
  const { server, projectId } = getInjectInfo();

  const lines: string[] = [];
  lines.push("## 目标元素（SilkPulse Alt 点选）");
  lines.push(`- 页面: ${location.href}`);
  lines.push(`- 元素: ${describeEl(el)}`);
  lines.push(`- CSS 选择器: \`${buildSelector(el)}\``);
  if (text) lines.push(`- 文案: ${JSON.stringify(text)}`);
  lines.push(
    `- 位置/尺寸: x=${Math.round(rect.x)}, y=${Math.round(rect.y)}, ${Math.round(rect.width)}×${Math.round(rect.height)}`,
  );
  if (idx >= 0) lines.push(`- SilkPulse snapshot idx: ${idx}`);
  lines.push("");
  lines.push("## 提示词");
  lines.push(
    `请帮我定位并修改页面中的这个元素（${describeEl(el)}${text ? `，文案 "${text}"` : ""}）。修改前先用 SilkPulse 确认目标元素，改动后验证效果。`,
  );
  lines.push("");
  lines.push("## 接入与操控方法（SilkPulse）");
  lines.push("该页面已接入 SilkPulse 远程调试，接入方式：");
  lines.push(scriptTag(server, projectId));
  lines.push("");
  lines.push("AI 操控方式 —— 全部通过 SilkPulse server 的 HTTP API（无需任何本地脚本）：");
  lines.push("```bash");
  if (idx >= 0) {
    lines.push(
      `# 1. 列出在线设备，拿到本页 deviceId（id 支持前缀匹配）`,
      `curl "${server}/api/devices"`,
      "",
      `# 2. 在该页面执行 JS（code 作为 async 函数体执行；idx 即上面的 snapshot idx）`,
      `curl -X POST "${server}/api/devices/<deviceId>/exec" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"code":"return __silkpulse_click(${idx})"}'`,
      "",
      `# 3. 改动后取页面快照验证效果`,
      `curl "${server}/api/devices/<deviceId>/snapshot"`,
    );
    lines.push("```");
    lines.push("");
    lines.push(
      "exec 内可用辅助函数：__silkpulse_click(idx) / __silkpulse_setValue(idx, val) / __silkpulse_scrollIntoView(idx) / __silkpulse_snapshot() 等；也可直接 document.querySelector 定位。",
    );
  } else {
    lines.push(
      "```bash",
      `curl "${server}/api/devices"   # 列出在线设备`,
      `curl -X POST "${server}/api/devices/<deviceId>/exec" -H "Content-Type: application/json" \\`,
      `  -d '{"code":"return document.querySelector('${buildSelector(el)}")?.textContent"}'`,
      "```",
    );
  }
  /** 启用鉴权的部署会要求密钥——提示一句，密钥本身不出现在设备端 */
  if (projectId) {
    lines.push("");
    lines.push(
      "注：若该 SilkPulse 部署启用了鉴权，请求需带项目密钥（?key= 或 Authorization header），向页面 owner 获取。",
    );
  }
  return lines.join("\n");
}

/** 剪贴板写入（clipboard API 不可用时降级 execCommand） */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** 关闭信息面板 */
function closePanel(): void {
  panel?.remove();
  panel = null;
}

/** 弹出信息面板 */
function showPanel(el: Element): void {
  closePanel();
  const panelText = buildCopyText(el);

  const p = document.createElement("div");
  p.id = "__silkpulse_picker_panel";

  /** 头部 */
  const head = document.createElement("div");
  head.className = "sp-head";
  head.textContent = "🎯 已选中元素";
  const close = document.createElement("button");
  close.className = "sp-close";
  close.textContent = "✕";
  close.title = "关闭（Esc）";
  close.addEventListener("click", closePanel);
  head.appendChild(close);
  p.appendChild(head);

  /** 定位信息段 */
  const sec1 = document.createElement("div");
  sec1.className = "sp-sec";
  const t1 = document.createElement("div");
  t1.className = "sp-t";
  t1.textContent = "定位信息";
  const c1 = document.createElement("button");
  c1.className = "sp-copy";
  c1.textContent = "复制";
  c1.addEventListener("click", async () => {
    c1.textContent = (await writeClipboard(panelText)) ? "✓ 已复制" : "复制失败";
    setTimeout(() => (c1.textContent = "复制"), 1500);
  });
  t1.appendChild(c1);
  sec1.appendChild(t1);
  const pre = document.createElement("pre");
  const infoOnly = panelText.split("## 提示词")[0].trim();
  pre.textContent = infoOnly;
  sec1.appendChild(pre);
  p.appendChild(sec1);

  /** 一键复制全部（提示词 + 接入方法） */
  const sec2 = document.createElement("div");
  sec2.className = "sp-sec";
  const t2 = document.createElement("div");
  t2.className = "sp-t";
  t2.textContent = "发给 AI 的完整指令";
  const c2 = document.createElement("button");
  c2.className = "sp-copy";
  c2.textContent = "复制全部";
  c2.addEventListener("click", async () => {
    c2.textContent = (await writeClipboard(panelText)) ? "✓ 已复制" : "复制失败";
    setTimeout(() => (c2.textContent = "复制全部"), 1500);
  });
  t2.appendChild(c2);
  const hint = document.createElement("div");
  hint.style.opacity = "0.65";
  hint.textContent =
    "含元素定位 + 提示词 + 本页接入调用方法（script 标签与 AI 操控命令），发给 agent 后它就知道如何操控这个页面、要改哪个元素。";
  sec2.appendChild(t2);
  sec2.appendChild(hint);
  p.appendChild(sec2);

  document.body.appendChild(p);
  panel = p;
}

/** 悬停高亮更新 */
function highlight(el: Element): void {
  ensureStyle();
  if (!outline) {
    outline = document.createElement("div");
    outline.id = "__silkpulse_picker_outline";
    document.body.appendChild(outline);
    tip = document.createElement("div");
    tip.id = "__silkpulse_picker_tip";
    document.body.appendChild(tip);
  }
  const r = el.getBoundingClientRect();
  outline.style.display = "block";
  outline.style.left = `${r.x}px`;
  outline.style.top = `${r.y}px`;
  outline.style.width = `${r.width}px`;
  outline.style.height = `${r.height}px`;
  if (tip) {
    tip.style.display = "block";
    tip.textContent =
      hoverDepth > 0
        ? `${describeEl(el)}  ↑${hoverDepth}  (Alt+滚轮↑父级 ↓子级，Alt+点击选中)`
        : `${describeEl(el)}  (Alt+滚轮↑父级 ↓子级，Alt+点击选中)`;
    tip.style.left = `${r.x}px`;
    tip.style.top = `${Math.max(r.y - 20, 2)}px`;
  }
}

/** 清除高亮 */
function clearHighlight(): void {
  outline?.remove();
  tip?.remove();
  outline = null;
  tip = null;
}

/** 当前悬停的元素（Alt+滚轮父子切换的基准） */
let hoverEl: Element | null = null;

/** Alt+滚轮当前定位到的层级（0 = 鼠标下最内层元素，正数向上取父级） */
let hoverDepth = 0;

/** 按深度取目标元素：从基准元素向上 hoverDepth 层，越界时钳在 document.documentElement */
function elAtDepth(): Element | null {
  if (!hoverEl || !hoverEl.isConnected) return null;
  let el: Element = hoverEl;
  for (let i = 0; i < hoverDepth; i++) {
    const parent = el.parentElement;
    if (!parent) break;
    el = parent;
  }
  return el;
}

/** 悬停事件（记录 Alt 状态） */
function onMouseOver(e: MouseEvent): void {
  if (!active || !e.altKey) return;
  const el = e.target;
  if (el instanceof Element && !panel?.contains(el)) {
    hoverEl = el;
    hoverDepth = 0;
    highlight(el);
  }
}

/**
 * Alt+滚轮：向上滚定位父级元素，向下滚回到子级
 *
 * 参考 vite-plugin-pilot 的父子切换：Alt+点击只能选到最内层元素，
 * 很多场景要选的是容器/列表项本身——滚轮在父子链上微调，定位准了再点击。
 */
function onWheel(e: WheelEvent): void {
  if (!active || !e.altKey || !hoverEl) return;
  e.preventDefault();
  e.stopPropagation();
  hoverDepth = Math.max(0, hoverDepth + (e.deltaY < 0 ? 1 : -1));
  const el = elAtDepth();
  if (el) highlight(el);
}

/** 点击事件：Alt+点击选中（选中的是当前滚轮定位到的层级） */
function onClick(e: MouseEvent): void {
  if (!active || !e.altKey) return;
  if (!(e.target instanceof Element)) return;
  if (panel?.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  const el = elAtDepth() ?? e.target;
  clearHighlight();
  showPanel(el);
}

/** Esc 关闭面板；Alt 松开清除高亮 */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    closePanel();
    clearHighlight();
  }
}
function onKeyUp(e: KeyboardEvent): void {
  if (e.key === "Alt") clearHighlight();
}

/** 启动 Alt 点选元素 */
export function startElementPicker(): void {
  if (active) return;
  active = true;
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("click", onClick, true);
  /** wheel 必须非 passive 才能 preventDefault 阻止页面滚动 */
  document.addEventListener("wheel", onWheel, { capture: true, passive: false });
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
}

/** 停止 Alt 点选元素 */
export function stopElementPicker(): void {
  if (!active) return;
  active = false;
  document.removeEventListener("mouseover", onMouseOver, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("wheel", onWheel, { capture: true });
  document.removeEventListener("keydown", onKeyDown, true);
  document.removeEventListener("keyup", onKeyUp, true);
  hoverEl = null;
  hoverDepth = 0;
  clearHighlight();
  closePanel();
}
