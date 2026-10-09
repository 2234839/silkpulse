/**
 * probe-html-in-canvas.mjs —— 通过 silkpulse exec 在远程设备页探测 HTML-in-Canvas 能力边界
 *
 * 用法：node scripts/probe-html-in-canvas.mjs <deviceId>
 * 需要 server 在本地 8080 运行（dev-local-key）。
 */
const deviceId = process.argv[2] ?? "d-mv0y4v0l-jjo4si";

/** 探针代码：三连测 UA / drawElementImage / captureElementImage 捕获任意元素 */
const code = `
const uaMatch = navigator.userAgent.match(/Chrome\\/[\\d.]+/);
const hasDraw = 'drawElementImage' in CanvasRenderingContext2D.prototype;
const hasCapture = 'captureElementImage' in HTMLCanvasElement.prototype;
let captureErr = '';
if (hasCapture) {
  const canvas = document.createElement('canvas');
  if ('content' in HTMLCanvasElement.prototype) canvas.setAttribute('content','drawable');
  else canvas.setAttribute('layoutsubtree','');
  try { canvas.captureElementImage(document.body); }
  catch (e) { captureErr = e.message; }
}
return JSON.stringify({ ua: uaMatch ? uaMatch[0] : navigator.userAgent, hasDraw, hasCapture, captureErr });
`;

const res = await fetch(`http://localhost:8080/api/devices/${deviceId}/exec`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer dev-local-key" },
  body: JSON.stringify({ code }),
});
const data = await res.json();
if (!data.success) {
  console.log("EXEC_FAIL:", data.error);
  process.exit(1);
}
console.log(data.result);
