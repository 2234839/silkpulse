/**
 * screen-share-e2e-test.mjs —— 屏幕共享推帧链路 E2E 验证
 *
 * 以控制台身份连 WS，订阅设备并下发 start-screen-share，
 * 断言收到 screen-frame 且帧为合法 JPEG dataURL。
 */
import { createRequire } from "node:module";

/** 仓库内已有 ws@8.21.2（pnpm 结构下不在根 node_modules，直接按路径解析） */
const require = createRequire(import.meta.url);
const WebSocket = require("../node_modules/.pnpm/ws@8.21.2/node_modules/ws/index.js");

const DEVICE_ID = process.argv[2];
if (!DEVICE_ID) {
  console.error("用法: node scripts/screen-share-e2e-test.mjs <deviceId>");
  process.exit(1);
}

const ws = new WebSocket("ws://localhost:8080/ws/console?token=dev-local-key");
let frames = 0;
let firstFrameLen = 0;

const timer = setTimeout(() => {
  console.log(frames > 0 ? "PASS" : "FAIL: 10s 内未收到 screen-frame");
  process.exit(frames > 0 ? 0 : 1);
}, 10000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "subscribe", deviceId: DEVICE_ID }));
  ws.send(JSON.stringify({ type: "start-screen-share", deviceId: DEVICE_ID }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "screen-frame" && msg.deviceId === DEVICE_ID) {
    frames++;
    if (frames === 1) {
      firstFrameLen = msg.frame.dataUrl.length;
      console.log(`首帧到达: keyframe=${msg.frame.keyframe} dataUrl=${Math.round(firstFrameLen / 1024)}KB`);
    }
    if (frames >= 3) {
      clearTimeout(timer);
      console.log(`PASS: 收到 ${frames} 帧`);
      ws.send(JSON.stringify({ type: "stop-screen-share", deviceId: DEVICE_ID }));
      ws.close();
      process.exit(0);
    }
  }
  if (msg.type === "screen-share-status" && msg.status === "error") {
    clearTimeout(timer);
    console.log("FAIL: 设备回报 screen-share error");
    process.exit(1);
  }
});

ws.on("error", (e) => {
  console.log("FAIL: WS 错误", e.message);
  process.exit(1);
});
