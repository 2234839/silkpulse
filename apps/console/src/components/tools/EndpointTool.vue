<script setup lang="ts">
/**
 * EndpointTool —— 服务端测试端点速查（ToolsPanel 的「测试端点」页签）
 *
 * 展示服务端免鉴权测试端点（delay-test / sse-test / test-fixtures），
 * delay-test 支持自定义文件名与延迟秒数，一键生成 URL / 复制 / 新标签打开，
 * 方便在任意页面以 <script src> 或 fetch 方式验证慢请求与 SDK 采集行为。
 */
import { ref, computed } from "vue";

/** delay-test 自定义文件名（不含路径与扩展名，扩展名自动补 .js） */
const fileName = ref("测试js延迟加载");
/** delay-test 延迟秒数（0~300 封顶，与服务端一致） */
const delaySec = ref(30);
/** 复制成功提示（短暂显示） */
const copied = ref("");

/** 当前 origin（控制台与服务同源，直接取浏览器地址） */
const origin = window.location.origin;

/** delay-test 生成 URL：文件名做 URL 编码，秒数钳制到 0~300 */
const delayUrl = computed(() => {
  const name = (fileName.value.trim() || "test") + ".js";
  const sec = Math.min(Math.max(Number(delaySec.value) || 0, 0), 300);
  return `${origin}/delay-test/${encodeURIComponent(name)}?t=${sec}`;
});

/**
 * 复制文本到剪贴板并短暂提示
 *
 * @param text 要复制的文本
 * @param key 提示标识（哪个卡片的复制按钮）
 */
async function copy(text: string, key: string) {
  await navigator.clipboard.writeText(text);
  copied.value = key;
  setTimeout(() => (copied.value = ""), 1500);
}

/** 新标签页打开 delay-test URL（触发真实请求，可在 Network 面板观察） */
function openDelay() {
  window.open(delayUrl.value, "_blank");
}
</script>

<template>
  <div class="endpoint-tool">
    <!-- delay-test：可参数化生成 -->
    <section class="card">
      <h3>⏱️ 延迟 JS 端点</h3>
      <p class="desc">
        生成一个延迟 N 秒才返回的 JS 地址（免鉴权）。把 URL 当
        <code>&lt;script src&gt;</code> 或 fetch 目标，验证慢请求、加载占位与
        SDK 的 network 采集。服务端会打印请求到达/响应完成日志。
      </p>
      <div class="row">
        <label>文件名 <input v-model="fileName" placeholder="测试js延迟加载" /></label>
        <label>
          延迟秒数
          <input v-model.number="delaySec" type="number" min="0" max="300" step="1" />
        </label>
      </div>
      <div class="url-line">
        <code class="url">{{ delayUrl }}</code>
        <div class="btns">
          <button @click="copy(delayUrl, 'delay')">
            {{ copied === "delay" ? "✓ 已复制" : "复制" }}
          </button>
          <button class="primary" @click="openDelay">打开</button>
        </div>
      </div>
      <p class="hint">秒数 0~300；中文文件名会自动 URL 编码，服务端日志里会解码显示。</p>
    </section>

    <!-- 固定端点清单 -->
    <section class="card">
      <h3>🧪 其他固定端点</h3>
      <ul class="list">
        <li>
          <div class="head">
            <code>/sse-test</code>
            <button @click="copy(origin + '/sse-test', 'sse')">
              {{ copied === "sse" ? "✓ 已复制" : "复制" }}
            </button>
          </div>
          <p class="desc">
            SSE 流式端点：推送 5 条事件（含 event/id/data），每条间隔
            500ms，推完关闭。验证 EventSource 与 SDK 的 SSE 采集。
          </p>
        </li>
        <li>
          <div class="head">
            <code>/test-fixtures/crash.js</code>
            <button @click="copy(origin + '/test-fixtures/crash.js', 'crash')">
              {{ copied === "crash" ? "✓ 已复制" : "复制" }}
            </button>
          </div>
          <p class="desc">
            加载即抛错的压缩脚本 + source map（.map）。验证错误堆栈到
            crash.ts 源码位置的 source map 解析能力。
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.endpoint-tool {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px;
}
.card {
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 10px;
  padding: 16px;
  background: var(--panel-bg, #fff);
}
.card h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.desc {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-secondary, #888);
  line-height: 1.6;
}
.row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.row label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.row input {
  padding: 6px 10px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  background: var(--input-bg, #fafafa);
  color: inherit;
  font-size: 13px;
}
.row input[type="number"] {
  width: 90px;
}
.url-line {
  display: flex;
  gap: 8px;
  align-items: stretch;
  flex-wrap: wrap;
}
.url {
  flex: 1;
  min-width: 200px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--code-bg, #f5f5f5);
  font-size: 12px;
  word-break: break-all;
  user-select: all;
}
.btns {
  display: flex;
  gap: 8px;
}
button {
  padding: 6px 14px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  background: var(--btn-bg, #f0f0f0);
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}
button.primary {
  background: var(--primary-color, #4a7dff);
  border-color: transparent;
  color: #fff;
}
button:hover {
  filter: brightness(1.05);
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-tertiary, #aaa);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.head code {
  font-size: 13px;
  font-weight: 600;
}
.list .desc {
  margin: 4px 0 0;
}
</style>
