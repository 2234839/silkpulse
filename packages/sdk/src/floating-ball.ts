/**
 * 悬浮球（Floating Ball）
 *
 * 页面右下角的可拖动悬浮球，向页面使用者展示「当前页面处于 SilkPulse 远程控制状态」：
 * - 静止态：绿色圆点 + 「已接入 SilkPulse」
 * - 控制中：server 下发 exec 执行期间切换为蓝色脉冲动画（setFloatingBallBusy 驱动）
 * - 单击（未拖动）：复制「接入 agent 的提示词」——含 script 接入标签 + AI 操控命令，
 *   粘贴给 AI agent 后它就知道如何操控这个页面。密钥不包含（设备端本就不持有密钥）。
 *
 * 拖动与点击的区分：pointerdown 后位移超过阈值视为拖动，抬起时不再触发复制。
 */

import { getInjectInfo, scriptTag } from "./element-picker.js";

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

/** pointer 拖动状态 */
let dragging = false;
let moved = false;
let startX = 0;
let startY = 0;
let originX = 0;
let originY = 0;

function onPointerDown(e: PointerEvent): void {
  if (!ball || e.button !== 0) return;
  dragging = true;
  moved = false;
  startX = e.clientX;
  startY = e.clientY;
  const rect = ball.getBoundingClientRect();
  originX = rect.left;
  originY = rect.top;
  ball.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging || !ball) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
  if (!moved) return;
  const { x, y } = clamp(originX + dx, originY + dy);
  /** 拖动后脱离 right/bottom 锚点，改用 left/top 定位 */
  ball.style.right = "auto";
  ball.style.bottom = "auto";
  ball.style.left = `${x}px`;
  ball.style.top = `${y}px`;
}

function onPointerUp(): void {
  if (!dragging) return;
  dragging = false;
  if (moved) {
    /** 拖动结束：持久化当前位置，刷新后原地恢复 */
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
  ball.title = "本页面处于 SilkPulse 远程控制状态\n拖动调整位置，单击复制接入 agent 的提示词";
  const dot = document.createElement("span");
  dot.className = "sp-dot";
  const label = document.createTextNode("已接入 SilkPulse");
  ball.appendChild(dot);
  ball.appendChild(label);
  ball.addEventListener("pointerdown", onPointerDown);
  ball.addEventListener("pointermove", onPointerMove);
  ball.addEventListener("pointerup", onPointerUp);
  document.body.appendChild(ball);
  /** 恢复上次拖动的位置（钳位防窗口缩小后跑出视口） */
  const saved = loadPos();
  if (saved) {
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
