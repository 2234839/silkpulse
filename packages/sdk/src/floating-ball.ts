/**
 * 悬浮球（Floating Ball）
 *
 * 页面右下角的可拖动悬浮球，向页面使用者展示「当前页面处于 SilkPulse 远程调试状态」：
 * - 静止态：绿色圆点 + 「已接入 SilkPulse」
 * - 控制中：server 下发 exec 执行期间切换为蓝色脉冲动画（setFloatingBallBusy 驱动）
 * 左右分区交互：左半部分为光标模式（按下切入，悬浮球跟随指针移动、实时高亮元素，
 * 松开选中并联动控制台 Element 面板）；右半部分仅拖动调整悬浮球位置。
 * 右半部分未拖动的单击仍复制「接入 agent 的提示词」——含 script 接入标签 + AI 操控命令，
 */

import { getInjectInfo, scriptTag } from "./element-picker.js";
import { clearPickHighlight, inspectElement, showPickHighlight } from "./chobitsu-bridge.js";

/** 是否已激活 */
let active = false;

/** 悬浮球 DOM */
let ball: HTMLDivElement | null = null;

/** 复制结果轻提示 */
let toast: HTMLDivElement | null = null;

/** 一次性样式 */
const STYLE_ID = "__silkpulse_ball_style";
/** 悬浮球 DOM id */
const BALL_ID = "__silkpulse_ball";
/** 轻提示 DOM id */
const TOAST_ID = "__silkpulse_ball_toast";

/** 拖动判定阈值（px）：位移超过它算拖动，不算点击 */
const DRAG_THRESHOLD = 4;

/** 拖动位置的 localStorage key（跨刷新恢复位置） */
const POS_KEY = "__silkpulse_ball_pos";

/** 读取持久化位置（无存档或数据异常时返回 null，走默认右下角） */
function loadPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x: number; y: number };
    if (typeof p.x === "number" && typeof p.y === "number") return p;
  } catch {
    /** 存储不可用（隐私模式）或数据损坏，用默认位置 */
  }
  return null;
}

/** 注入样式 */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${BALL_ID}{position:fixed;right:20px;bottom:20px;z-index:2147483647;
  display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;
  background:rgba(15,23,42,.85);color:#f1f5f9;cursor:grab;user-select:none;
  touch-action:none;font:12px/1.4 -apple-system,'PingFang SC',sans-serif;
  box-shadow:0 4px 16px rgba(0,0,0,.25);opacity:.85;transition:opacity .15s}
#${BALL_ID}:hover{opacity:1}
#${BALL_ID}:active{cursor:grabbing}
#${BALL_ID} .sp-pick{display:flex;align-items:center;justify-content:center;
  width:24px;height:24px;margin:-4px 4px -4px -8px;cursor:crosshair;flex-shrink:0;
  border-right:1px dashed rgba(241,245,249,.35)}
#${BALL_ID} .sp-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0}
#${BALL_ID}.sp-busy .sp-dot{background:#3b82f6;animation:sp-ball-pulse 1s ease-in-out infinite}
#${BALL_ID}.sp-busy{background:rgba(30,58,138,.9)}
@keyframes sp-ball-pulse{0%,100%{box-shadow:0 0 0 0 rgba(59,130,246,.6)}
  50%{box-shadow:0 0 0 6px rgba(59,130,246,0)}}
#${TOAST_ID}{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);
  z-index:2147483647;background:rgba(15,23,42,.9);color:#f1f5f9;
  padding:6px 14px;border-radius:8px;font:12px/1.4 -apple-system,'PingFang SC',sans-serif;
  pointer-events:none;opacity:0;transition:opacity .2s}
#${TOAST_ID}.sp-show{opacity:1}
`;
  document.head.appendChild(style);
}

/** 轻提示（1.6s 自动消失） */
function showToast(text: string): void {
  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("sp-show");
  setTimeout(() => toast?.classList.remove("sp-show"), 1600);
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

/** 构建「接入 agent 的提示词」：接入方式 + AI 操控命令 + 使用建议 */
function buildAgentPrompt(): string {
  const { server, projectId } = getInjectInfo();
  const lines: string[] = [];
  lines.push("# SilkPulse —— 远程页面操控");
  lines.push("");
  lines.push(`当前页面（${location.href}）已接入 SilkPulse 远程调试，请通过 SilkPulse 操控它。`);
  lines.push("");
  lines.push("## 接入方式");
  lines.push(scriptTag(server, projectId));
  lines.push("");
  lines.push("## AI 操控方式");
  lines.push("全部通过 SilkPulse server 的 HTTP API（无需任何本地脚本）：");
  lines.push("```bash");
  lines.push(`# 1. 列出在线设备，拿到本页 deviceId（id 支持前缀匹配）`);
  lines.push(`curl "${server}/api/devices"`);
  lines.push("");
  lines.push(`# 2. 取页面快照，了解页面结构与可交互元素`);
  lines.push(`curl "${server}/api/devices/<deviceId>/snapshot"`);
  lines.push("");
  lines.push(`# 3. 在该页面执行 JS（code 作为 async 函数体执行）`);
  lines.push(`curl -X POST "${server}/api/devices/<deviceId>/exec" \\`);
  lines.push(`  -H "Content-Type: application/json" \\`);
  lines.push(`  -d '{"code":"return document.title"}'`);
  lines.push("```");
  lines.push("");
  lines.push("## 使用建议");
  lines.push("先 snapshot 了解页面结构，再 exec 执行点击/填值等操作，操作后重新取快照验证效果。");
  lines.push(
    "exec 内可用辅助函数：__silkpulse_click(idx) / __silkpulse_setValue(idx, val) / __silkpulse_scrollIntoView(idx) / __silkpulse_snapshot() 等；也可直接 document.querySelector 定位。",
  );
  if (projectId) {
    lines.push("");
    lines.push(
      "注：若该 SilkPulse 部署启用了鉴权，请求需带项目密钥（?key= 或 Authorization header），向页面 owner 获取。",
    );
  }
  return lines.join("\n");
}

/** 复制提示词并轻提示结果 */
async function copyPrompt(): Promise<void> {
  const ok = await writeClipboard(buildAgentPrompt());
  showToast(ok ? "✓ 已复制接入 agent 提示词" : "复制失败");
}

/** 视口内钳位 */
function clamp(x: number, y: number): { x: number; y: number } {
  const w = ball?.offsetWidth ?? 0;
  const h = ball?.offsetHeight ?? 0;
  return {
    x: Math.min(Math.max(x, 0), window.innerWidth - w),
    y: Math.min(Math.max(y, 0), window.innerHeight - h),
  };
}

/** pointer 按住状态：pick = 左半光标选元素，move = 右半拖动位置 */
const MODE_PICK = "pick" as const;
const MODE_MOVE = "move" as const;
let dragging = false;
let mode: typeof MODE_PICK | typeof MODE_MOVE = MODE_MOVE;
/** move 模式下是否已位移超过阈值（区分拖动与单击） */
let moved = false;
let startX = 0;
let startY = 0;
let originX = 0;
let originY = 0;
/** 球体是否仍处于 right/bottom 锚点定位（未改用 left/top） */
let anchored = true;

/** 选元素模式状态：左半按下即进入，松开选中结束 */
let picking = false;
/** 当前悬停候选元素 */
let pickTarget: Element | null = null;

/** 生成选中元素提示文案（tag#id.class 截断） */
function describeEl(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  const cls = (el.className && typeof el.className === "string" ? el.className : "")
    .trim()
    .split(/\s+/)[0];
  if (cls) s += `.${cls}`;
  return s.slice(0, 60);
}

/** 高亮指定元素 + 显示提示标签（与 Alt 点选共用 chobitsu-bridge 的唯一高亮入口：
 *  Elements 桥激活时是 Chrome DevTools 原生 Overlay 高亮，未激活时回落 outline） */
function highlightPick(el: Element | null): void {
  pickTarget = el;
  if (!el) {
    clearPickHighlight();
    return;
  }
  showPickHighlight(el, describeEl(el));
}

/** event target 向上找到有效元素（文本节点/球体自身排除） */
function elementFromPoint(x: number, y: number): Element | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (el === ball || ball?.contains(el)) return null;
  return el;
}

/** 清理选元素模式状态（保留已选结果） */
function endPickMode(): void {
  picking = false;
  highlightPick(null);
  if (ball) ball.style.opacity = "";
}

function onPointerDown(e: PointerEvent): void {
  if (!ball || e.button !== 0) return;
  dragging = true;
  moved = false;
  startX = e.clientX;
  startY = e.clientY;
  const rect = ball.getBoundingClientRect();
  originX = rect.left;
  originY = rect.top;
  /** 按下位置在圆点区（.sp-pick）→ 光标选元素模式；文本区 → 拖动模式 */
  mode = e.target instanceof Element && e.target.closest(".sp-pick") ? MODE_PICK : MODE_MOVE;
  if (mode === MODE_PICK) {
    picking = true;
    ball.style.opacity = "0.3";
    document.body.style.cursor = "crosshair";
  }
  ball.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging || !ball) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;

  if (mode === MODE_PICK) {
    /** 光标模式：球体作为光标跟随指针（挂在指针右下角），
     *  实时高亮指针下的元素（移动端 touchmove 同样走这里） */
    const { x, y } = clamp(e.clientX + 14, e.clientY + 16);
    ball.style.right = "auto";
    ball.style.bottom = "auto";
    ball.style.left = `${x}px`;
    ball.style.top = `${y}px`;
    highlightPick(elementFromPoint(e.clientX, e.clientY));
    return;
  }
  if (!moved) return;

  const { x, y } = clamp(originX + dx, originY + dy);
  /** 拖动后脱离 right/bottom 锚点，改用 left/top 定位 */
  ball.style.right = "auto";
  ball.style.bottom = "auto";
  ball.style.left = `${x}px`;
  ball.style.top = `${y}px`;
}

/** 选元素结束后把球体放回按下前的位置（跟随指针期间被临时移动过） */
function restoreBallPos(): void {
  if (!ball) return;
  if (anchored) {
    ball.style.left = "";
    ball.style.top = "";
    ball.style.right = "";
    ball.style.bottom = "";
  } else {
    ball.style.right = "auto";
    ball.style.bottom = "auto";
    ball.style.left = `${originX}px`;
    ball.style.top = `${originY}px`;
  }
}

function onPointerUp(): void {
  if (!dragging) return;
  dragging = false;
  if (picking) {
    /** 选元素模式松开：选中当前高亮元素，联动控制台 Element 面板展开定位。
     *  原生高亮保留片刻后清除——瞬间消失看不出选中过哪个 */
    document.body.style.cursor = "";
    const target = pickTarget;
    setTimeout(() => clearPickHighlight(), 600);
    endPickMode();
    restoreBallPos();
    if (target) {
      inspectElement(target);
      void writeClipboard(`已选中元素: ${describeEl(target)}（控制台 Element 面板已展开定位）`);
      showToast(`✓ 已选中 ${describeEl(target)}`);
    }
    return;
  }
  if (moved) {
    /** 拖动结束：脱离锚点并持久化当前位置，刷新后原地恢复 */
    anchored = false;
    if (ball?.style.left) {
      try {
        localStorage.setItem(
          POS_KEY,
          JSON.stringify({ x: parseFloat(ball.style.left), y: parseFloat(ball.style.top) }),
        );
      } catch {
        /** 存储不可用则不持久化，不影响功能 */
      }
    }
  } else {
    /** 未发生拖动 = 单击 → 复制提示词 */
    void copyPrompt();
  }
}

/** 启动悬浮球 */
export function startFloatingBall(): void {
  if (active) return;
  active = true;
  ensureStyle();
  ball = document.createElement("div");
  ball.id = BALL_ID;
  ball.title =
    "本页面处于 SilkPulse 远程调试状态\n左半：按下进入光标选元素（松开选中，控制台 Element 面板同步定位） · 右半：拖动调整位置 · 单击复制接入 agent 的提示词";
  const pick = document.createElement("span");
  pick.className = "sp-pick";
  const dot = document.createElement("span");
  dot.className = "sp-dot";
  pick.appendChild(dot);
  const label = document.createTextNode("已接入 SilkPulse");
  ball.appendChild(pick);
  ball.appendChild(label);
  ball.addEventListener("pointerdown", onPointerDown);
  ball.addEventListener("pointermove", onPointerMove);
  ball.addEventListener("pointerup", onPointerUp);
  document.body.appendChild(ball);
  /** 恢复上次拖动的位置（钳位防窗口缩小后跑出视口） */
  const saved = loadPos();
  if (saved) {
    anchored = false;
    const { x, y } = clamp(saved.x, saved.y);
    ball.style.right = "auto";
    ball.style.bottom = "auto";
    ball.style.left = `${x}px`;
    ball.style.top = `${y}px`;
  }
}

/** 停止悬浮球 */
export function stopFloatingBall(): void {
  if (!active) return;
  active = false;
  dragging = false;
  picking = false;
  anchored = true;
  ball?.remove();
  ball = null;
  toast?.remove();
  toast = null;
}

/**
 * 切换「控制中」状态：server 下发 exec 执行期间为 true
 * 悬浮球未开启时为安全空操作
 */
export function setFloatingBallBusy(busy: boolean): void {
  ball?.classList.toggle("sp-busy", busy);
}
