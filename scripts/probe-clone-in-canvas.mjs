/**
 * probe-clone-in-canvas.mjs —— 实测「克隆元素塞进 drawable canvas」截图路线
 *
 * 流程：创建离屏 canvas(content=drawable) → 克隆目标元素挂进去(带 drawable)
 * → 等一帧渲染 → drawElementImage 画到输出 canvas → 读像素验证
 *
 * 用法：node scripts/probe-clone-in-canvas.mjs <deviceId>
 */
const SERVER = "https://silkpulse.heartstack.space";
const KEY = "fdde4a91eb9c75fc8c474f2e4f08769de77edc4afe17d236";
const deviceId = process.argv[2];
if (!deviceId) {
  console.error("用法: node scripts/probe-clone-in-canvas.mjs <deviceId>");
  process.exit(1);
}

const code = `
if (!('drawElementImage' in CanvasRenderingContext2D.prototype)) {
  return JSON.stringify({ supported: false });
}
const t0 = performance.now();

// 输出画布（drawable 容器）
const holder = document.createElement('canvas');
holder.width = 800; holder.height = 600;
holder.style.cssText = 'position:fixed;left:-99999px;top:0';
if ('content' in HTMLCanvasElement.prototype) holder.setAttribute('content','drawable');
else holder.setAttribute('layoutsubtree','');
document.body.appendChild(holder);

// 克隆一个页面里的真实元素进去（拿标题所在容器）
const src = document.querySelector('h1, h2, [class*=title], [class*=header]') || document.body.firstElementChild;
const clone = src.cloneNode(true);
clone.setAttribute('drawable','');
holder.appendChild(clone);

// 等两帧让浏览器布局 + 生成快照（后台 tab 的 rAF 被暂停，必须用 setTimeout）
await new Promise(r => setTimeout(r, 100));

const ctx = holder.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, 800, 600);
let drawErr = '';
try {
  ctx.drawElementImage(clone, 0, 0);
} catch (e) {
  drawErr = e.message;
}
const t1 = performance.now();

// 读像素验证非空白
let nonBlank = 0;
if (!drawErr) {
  const d = ctx.getImageData(0, 0, 800, 600).data;
  for (let i = 3; i < d.length; i += 400) { if (d[i] !== 0) nonBlank++; }
}
holder.remove();
return JSON.stringify({
  supported: true,
  drawErr: drawErr || null,
  nonBlankSamples: nonBlank,
  totalMs: Math.round(t1 - t0),
  srcTag: src.tagName,
});
`;

const res = await fetch(`${SERVER}/api/agent/devices/${deviceId}/exec?snapshot=0`, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ code }),
});
const data = await res.json();
console.log(data.success ? data.result : "EXEC_FAIL: " + (data.error ?? JSON.stringify(data)));
