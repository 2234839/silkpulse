/**
 * probe-remote-html-in-canvas.mjs —— 通过远程 SilkPulse exec 探测设备页 HTML-in-Canvas 能力
 *
 * 用法：node scripts/probe-remote-html-in-canvas.mjs <deviceId>
 */
const SERVER = "https://silkpulse.heartstack.space";
const KEY = "fdde4a91eb9c75fc8c474f2e4f08769de77edc4afe17d236";
const deviceId = process.argv[2];
if (!deviceId) {
  console.error("用法: node scripts/probe-remote-html-in-canvas.mjs <deviceId>");
  process.exit(1);
}

const code = `
const uaM = navigator.userAgent.match(/Chrome\\/[\\d.]+/);
const hasDraw = 'drawElementImage' in CanvasRenderingContext2D.prototype;
const hasCapture = 'captureElementImage' in HTMLCanvasElement.prototype;
let captureErr = '';
let captureSize = null;
if (hasCapture) {
  const c = document.createElement('canvas');
  if ('content' in HTMLCanvasElement.prototype) c.setAttribute('content','drawable');
  else c.setAttribute('layoutsubtree','');
  try {
    const img = c.captureElementImage(document.body);
    captureSize = img ? (img.width + 'x' + img.height) : String(img);
  } catch (e) { captureErr = e.message; }
}
return JSON.stringify({ ua: uaM ? uaM[0] : navigator.userAgent, hasDraw, hasCapture, captureErr, captureSize });
`;

const res = await fetch(`${SERVER}/api/agent/devices/${deviceId}/exec?snapshot=0`, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ code }),
});
const data = await res.json();
console.log(data.success ? data.result : "EXEC_FAIL: " + (data.error ?? JSON.stringify(data)));
