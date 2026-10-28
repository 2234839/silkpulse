/**
 * 服务端测试端点集合（免鉴权，供 SDK 采集验证 / 网络调试演示使用）
 *
 * 所有端点都在 index.ts 的主路由兜底（静态资源/SPA 回退）之前调用，
 * 返回 true 表示已消费该请求。后续新增测试端点统一加到本文件，
 * 避免入口文件膨胀成路由大杂烩。
 */
import type { Ctx } from "./uws/http-helpers.js";
import { writeResponse } from "./uws/http-helpers.js";

/**
 * /delay-test/*.js?t=<秒> —— 延迟响应的 JS 测试端点
 * 例：/delay-test/测试js延迟加载.js?t=30 → 30 秒后才返回 JS。
 * 文件名随意（.js 结尾即可），t 为延迟秒数（0~300 封顶，防连接被占死）。
 * 服务端打印请求到达/响应完成日志，供验证 SDK 的 network 采集对慢请求的记录。
 */
function handleDelayTest(ctx: Ctx, pathname: string): boolean {
  if (!pathname.endsWith(".js")) return false;
  const rawDelay = ctx.parsedUrl.searchParams.get("t");
  if (rawDelay === null) return false;
  const delaySec = Math.min(Math.max(Number(rawDelay) || 0, 0), 300);
  const startedAt = Date.now();
  /** pathname 是百分号编码（中文文件名），解码后再用于日志和 JS 内容 */
  const fileName = decodeURIComponent(pathname.slice(1)).replace(/[\\*`$]/g, "");
  const jsBody = `/* 延迟 ${delaySec}s 响应的测试脚本 */\nconsole.log("[delay-test] ${fileName} 加载完成，实际耗时 ${delaySec}s");\n`;
  console.log(
    `[delay-test] 收到请求 ${fileName}?t=${delaySec}（${new Date(startedAt).toLocaleString()}）`,
  );
  setTimeout(() => {
    if (ctx.aborted) {
      console.log(`[delay-test] 客户端已断开，放弃响应 ${fileName}`);
      return;
    }
    console.log(
      `[delay-test] 响应完成 ${fileName} — 实际延迟 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    writeResponse(
      ctx,
      200,
      {
        "Content-Type": "application/javascript; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
      jsBody,
    );
  }, delaySec * 1000);
  return true;
}

/**
 * /sse-test —— SSE 测试端点（text/event-stream）
 * 推送 5 条事件（含 event/id/data 字段），每条间隔 500ms，推完关闭连接。
 * 注意：路径不能以 /api/ 开头，否则会被 handleApiRoute 的 404 兜底拦截。
 */
function handleSseTest(ctx: Ctx): boolean {
  if (ctx.responded || ctx.aborted) return true;
  /** SSE 头先写，进入流式模式（writeStatus 后用 write 连续推送） */
  ctx.res.cork(() => {
    ctx.res.writeStatus("200 OK");
    ctx.res.writeHeader("Content-Type", "text/event-stream");
    ctx.res.writeHeader("Cache-Control", "no-cache");
    ctx.res.writeHeader("Access-Control-Allow-Origin", "*");
  });
  const events = [
    { event: "message", data: "SSE 连接已建立" },
    { event: "update", id: "1", data: JSON.stringify({ count: 1, msg: "第一条更新" }) },
    { event: "update", id: "2", data: JSON.stringify({ count: 2, msg: "第二条更新" }) },
    { event: "ping", data: "heartbeat" },
    { event: "done", id: "3", data: "SSE 流结束" },
  ];
  let idx = 0;
  const timer = setInterval(() => {
    if (ctx.aborted) {
      clearInterval(timer);
      return;
    }
    if (idx >= events.length) {
      clearInterval(timer);
      ctx.res.end();
      return;
    }
    const { event, id, data } = events[idx++];
    let chunk = "";
    if (id) chunk += `id: ${id}\n`;
    chunk += `event: ${event}\n`;
    chunk += `data: ${data}\n\n`;
    ctx.res.write(chunk);
  }, 500);
  /** 客户端断开时清理定时器 */
  ctx.res.onAborted(() => {
    ctx.aborted = true;
    clearInterval(timer);
  });
  return true;
}

/**
 * source map 解析测试用的压缩脚本 + map（加载即抛错）
 * minified: function n(r){throw new Error(r)}n("source map 测试错误")
 * throw @ 1:14 → crash.ts:2:2，new Error @ 1:20 → crash.ts:2:8
 */
function handleCrashFixture(ctx: Ctx, pathname: string): boolean {
  if (pathname === "/test-fixtures/crash.js") {
    writeResponse(
      ctx,
      200,
      { "Content-Type": "application/javascript; charset=utf-8" },
      'function n(r){throw new Error(r)}n("source map 测试错误")\n//# sourceMappingURL=crash.js.map',
    );
    return true;
  }
  if (pathname === "/test-fixtures/crash.js.map") {
    writeResponse(
      ctx,
      200,
      { "Content-Type": "application/json; charset=utf-8" },
      JSON.stringify({
        version: 3,
        sources: ["crash.ts"],
        mappings: "AAAA,SAASA,EAAeC,EAAoB,CAC1C,MAAM,IAAI,MAAMA,CAAG,CACrB,CACAD,EAAe,qCAAiB",
        names: ["crashOnPurpose", "msg"],
      }),
    );
    return true;
  }
  return false;
}

/**
 * 测试端点总入口：按路径分发到各测试端点，命中并消费请求返回 true
 */
export function handleTestEndpointRoute(ctx: Ctx, pathname: string): boolean {
  if (handleDelayTest(ctx, pathname)) return true;
  if (pathname === "/sse-test") return handleSseTest(ctx);
  if (pathname.startsWith("/test-fixtures/")) return handleCrashFixture(ctx, pathname);
  return false;
}
