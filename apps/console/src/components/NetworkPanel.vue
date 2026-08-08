<script setup lang="ts">
/**
 * NetworkPanel —— 网络请求面板
 *
 * 展示远程设备的网络请求（HTTP + WebSocket），支持关键词搜索、状态筛选（全部/成功/失败）、
 * 耗时排序（定位慢请求）。点击单条请求展开详情（URL/方法/状态/耗时/请求头/响应头/请求体/响应体/WS 帧），
 * 支持复制为 cURL 命令在本地复现。
 *
 * 数据由 App.vue 通过 useConsoleSocket() 单源传入。
 */
import { ref, computed, watch } from 'vue'
import type { NetworkEntry } from '@silkpulse/shared'
import { copyText } from '../utils/clipboard'
import ObjectInspector from './ObjectInspector.vue'

const props = defineProps<{
  /** 远程设备网络请求列表 */
  network: NetworkEntry[]
}>()

/** 选中的请求条目（点击展开详情） */
const selectedNetwork = ref<NetworkEntry | null>(null)

/** cURL 复制状态（用于按钮反馈） */
const curlCopyState = ref<'idle' | 'copied'>('idle')

/** 格式化 headers 对象为 "k: v" 多行文本 */
function formatHeaders(h: Record<string, string>): string {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n')
}

/**
 * 格式化请求体/响应体：JSON 则美化缩进，否则原样返回。
 *
 * 调试时点击网络请求看详情，压缩 JSON（如 {"code":0,"data":[...]）可读性极差。
 * 尝试 JSON.parse 成功则 2 空格缩进美化；非 JSON（FormData 文本、纯字符串）原样返回。
 * 这里设计上就需要 try-catch —— 输入"可能不是 JSON"是正常的，不是异常情况。
 */
function formatBody(body: string): string {
  try {
    const parsed = JSON.parse(body)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return body
  }
}

/**
 * 判断响应体是否为 base64 图片（可预览）
 *
 * SDK 对 image/* 响应会用 FileReader.readAsDataURL 编码为 data URL，
 * resBodyEncoding='base64' 标识。
 */
function isImagePreview(n: NetworkEntry): boolean {
  return n.resBodyEncoding === 'base64' && !!n.resBodyMime?.startsWith('image/')
}

/**
 * 判断响应体是否为二进制信息（只读类型+大小，无内容）
 *
 * 字体/wasm/大图片等用 resBodyEncoding='info' 标识。
 */
function isBinaryInfo(n: NetworkEntry): boolean {
  return n.resBodyEncoding === 'info'
}

/**
 * 响应体展示模式：'preview'（智能预览）/ 'raw'（原始文本）
 *
 * 图片默认预览，可切到 raw 看完整 base64 字符串。
 */
const resBodyViewMode = ref<'preview' | 'raw'>('preview')

/** 响应体展示模式重置：切换请求时回到默认 preview */
watch(selectedNetwork, () => {
  resBodyViewMode.value = 'preview'
})

/**
 * 把 NetworkEntry 转成 cURL 命令
 *
 * 让 AI/开发者能直接在本地复现远程设备的请求。
 * 单引号转义：shell 单引号内用 '\'' 闭合再开。
 */
function toCurl(n: NetworkEntry): string {
  const parts: string[] = [`curl -X ${n.method}`]
  if (n.reqHeaders) {
    for (const [k, v] of Object.entries(n.reqHeaders)) {
      const esc = v.replaceAll("'", "'\"'\"'")
      parts.push(`-H '${k}: ${esc}'`)
    }
  }
  if (n.reqBody) {
    const esc = n.reqBody.replaceAll("'", "'\"'\"'")
    parts.push(`--data '${esc}'`)
  }
  const urlEsc = n.url.replaceAll("'", "'\"'\"'")
  parts.push(`'${urlEsc}'`)
  return parts.join(' \\\n  ')
}

/** 复制选中请求的 cURL 命令到剪贴板 */
async function copyCurl() {
  if (!selectedNetwork.value) return
  const cmd = toCurl(selectedNetwork.value)
  await copyText(cmd)
  curlCopyState.value = 'copied'
  setTimeout(() => { curlCopyState.value = 'idle' }, 1500)
}

/** 关键词搜索（按 URL / 方法 / 状态码） */
const networkSearch = ref('')
/**
 * 状态筛选：all 全部 / success 成功（2xx-3xx）/ error 失败（4xx-5xx 或未完成 status=0）
 *
 * 调试网络问题时最常用的维度 —— 失败请求和成功请求混在一起时，
 * 用户需要快速过滤出"哪些请求挂了"。status=0（请求未完成/网络中断）归入失败。
 */
const networkStatusFilter = ref<'all' | 'success' | 'error'>('all')
/**
 * 类型筛选：all 全部 / fetch / xhr / ws / resource
 *
 * 诊断时需要区分"API 请求"和"静态资源加载"——页面白屏查 resource，接口报错查 fetch/xhr。
 */
const networkKindFilter = ref<'all' | 'fetch' | 'xhr' | 'ws' | 'resource'>('all')
/**
 * 耗时排序：time（默认时间正序）/ desc（耗时降序，慢请求在最上）/ asc（耗时升序）
 *
 * 诊断"页面慢/卡"时，失败请求往往不是根因——真正的瓶颈是那些 status 200
 * 但耗时 2-3s 的慢请求。点"耗时"表头切到降序即可一眼定位，与 inspect CLI 的慢请求 Top 对齐。
 */
const networkDurationSort = ref<'time' | 'desc' | 'asc'>('time')
/** 慢请求阈值（ms），与 skill CLI inspect 的 SLOW_THRESHOLD 保持一致 */
const SLOW_THRESHOLD = 500
function toggleDurationSort() {
  if (networkDurationSort.value === 'time') networkDurationSort.value = 'desc'
  else if (networkDurationSort.value === 'desc') networkDurationSort.value = 'asc'
  else networkDurationSort.value = 'time'
}
const filteredNetwork = computed(() => {
  let result = props.network
  /** 类型筛选 */
  if (networkKindFilter.value !== 'all') {
    result = result.filter((n) => n.kind === networkKindFilter.value)
  }
  if (networkStatusFilter.value === 'success') {
    result = result.filter((n) => n.status >= 200 && n.status < 400)
  } else if (networkStatusFilter.value === 'error') {
    /** status=0 表示请求未完成（网络中断/CORS 失败），诊断时视为失败 */
    result = result.filter((n) => n.status === 0 || n.status >= 400)
  }
  const q = networkSearch.value.trim().toLowerCase()
  if (q) {
    result = result.filter((n) =>
      n.url.toLowerCase().includes(q) ||
      n.method.toLowerCase().includes(q) ||
      String(n.status).includes(q),
    )
  }
  /** 耗时排序：默认 time 不排（保持时间正序），desc/asc 按 duration 排 */
  if (networkDurationSort.value === 'desc') {
    result = [...result].sort((a, b) => b.duration - a.duration)
  } else if (networkDurationSort.value === 'asc') {
    result = [...result].sort((a, b) => a.duration - b.duration)
  }
  return result
})

/** 设备切换时清空选中（避免显示旧设备的请求详情） */
watch(() => props.network, () => {
  selectedNetwork.value = null
})
</script>

<template>
  <div class="flex-1 flex overflow-hidden bg-base">
    <!-- 请求列表 -->
    <div class="w-2/5 min-w-[180px] md:min-w-[240px] flex flex-col border-r border-base">
      <!-- 搜索 + 状态筛选栏 -->
      <div class="p-2 border-b border-light bg-surface space-y-2">
        <input
          v-model="networkSearch"
          placeholder="搜索请求（URL / 方法 / 状态码）"
          class="w-full text-xs px-2 py-1 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
        />
        <!-- 类型筛选：全部 / Fetch / XHR / WS / 资源 -->
        <div class="flex items-center gap-1">
          <button
            v-for="kf in (['all', 'fetch', 'xhr', 'ws', 'resource'] as const)"
            :key="kf"
            @click="networkKindFilter = kf"
            class="px-2 py-0.5 text-xs rounded font-medium"
            :class="networkKindFilter === kf
              ? 'bg-blue-500 text-white'
              : 'bg-elevated text-secondary bg-elevated-hover'"
          >{{ kf === 'all' ? '全部' : kf === 'resource' ? '资源' : kf === 'ws' ? 'WS' : kf.toUpperCase() }}</button>
        </div>
        <!-- 状态筛选：全部 / 成功 / 失败 -->
        <div class="flex items-center gap-1">
          <button
            v-for="sf in (['all', 'success', 'error'] as const)"
            :key="sf"
            @click="networkStatusFilter = sf"
            class="px-2 py-0.5 text-xs rounded font-medium"
            :class="networkStatusFilter === sf
              ? sf === 'error' ? 'bg-red-600 text-white' : 'bg-gray-800 text-white'
              : 'bg-elevated text-secondary bg-elevated-hover'"
          >{{ sf === 'all' ? '全部' : sf === 'success' ? '成功' : '失败' }}</button>
          <span class="ml-auto text-xs text-faint">{{ filteredNetwork.length }}/{{ props.network.length }}</span>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto">
        <table class="w-full text-sm">
          <thead class="bg-elevated text-secondary text-xs uppercase sticky top-0">
            <tr>
              <th class="text-left px-3 py-2">时间</th>
              <th class="text-left px-3 py-2">方法</th>
              <th class="text-left px-3 py-2">状态</th>
              <th class="text-left px-3 py-2">URL</th>
              <th class="text-right px-3 py-2">
                <button
                  @click="toggleDurationSort"
                  class="inline-flex items-center gap-0.5 hover:text-primary transition-colors"
                  :class="networkDurationSort !== 'time' ? 'text-primary' : ''"
                  :title="networkDurationSort === 'time' ? '点击按耗时降序' : networkDurationSort === 'desc' ? '当前：耗时降序（慢请求在上）' : '当前：耗时升序'"
                >耗时<span class="text-[10px]">{{ networkDurationSort === 'desc' ? '▼' : networkDurationSort === 'asc' ? '▲' : '↕' }}</span></button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(n, i) in filteredNetwork"
              :key="i"
              @click="selectedNetwork = n"
              class="border-b border-light cursor-pointer hover:bg-blue-soft"
              :class="selectedNetwork === n ? 'bg-blue-soft' : ''"
            >
              <td class="px-3 py-2 text-faint text-xs font-mono whitespace-nowrap">{{ new Date(n.timestamp).toLocaleTimeString() }}</td>
              <td class="px-3 py-2 text-secondary font-mono text-xs">{{ n.method }}</td>
              <td class="px-3 py-2 font-mono text-xs" :class="n.status >= 400 ? 'text-red-500' : n.status >= 200 ? 'text-green-600' : 'text-faint'">
                {{ n.status || '—' }}
              </td>
              <td class="px-3 py-2 text-primary truncate max-w-[160px] text-xs">
                <span v-if="n.sseState" class="inline-block px-1 mr-1 text-[10px] rounded bg-purple-key/20 text-purple-key align-middle">SSE</span>
                <span v-if="n.protocol === 'ws'" class="inline-block px-1 mr-1 text-[10px] rounded bg-blue-key/20 text-blue-key align-middle">WS</span>
                {{ n.url.split('/').pop() || n.url }}
              </td>
              <td
                class="px-3 py-2 text-right text-xs font-mono"
                :class="n.duration > SLOW_THRESHOLD ? 'text-amber-500 font-semibold' : 'text-muted'"
                :title="n.duration > SLOW_THRESHOLD ? `慢请求（> ${SLOW_THRESHOLD}ms）` : ''"
              >{{ n.duration }}ms</td>
            </tr>
          </tbody>
        </table>
        <div v-if="filteredNetwork.length === 0" class="text-faint text-center py-8 text-sm">{{ props.network.length === 0 ? '暂无网络请求' : '无匹配请求' }}</div>
      </div>
    </div>

    <!-- 详情面板 -->
    <div class="flex-1 overflow-y-auto p-4">
      <template v-if="selectedNetwork">
        <div class="space-y-4">
          <!-- 工具栏：复制为 cURL -->
          <div class="flex justify-end">
            <button
              @click="copyCurl"
              class="px-3 py-1.5 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary transition-colors"
            >{{ curlCopyState === 'copied' ? '✓ 已复制' : '复制为 cURL' }}</button>
          </div>
          <!-- 基本信息 -->
          <div>
            <div class="text-xs text-faint mb-1">URL</div>
            <div class="text-sm font-mono text-primary break-all bg-surface p-2 rounded border border-base">{{ selectedNetwork.url }}</div>
          </div>
          <div class="flex gap-6 text-sm">
            <div><span class="text-faint">时间：</span><span class="font-mono text-primary">{{ new Date(selectedNetwork.timestamp).toLocaleString() }}</span></div>
            <div><span class="text-faint">方法：</span><span class="font-mono text-primary">{{ selectedNetwork.method }}</span></div>
            <div>
              <span class="text-faint">状态：</span>
              <span class="font-mono" :class="selectedNetwork.status >= 400 ? 'text-red-500' : 'text-green-600'">{{ selectedNetwork.status || '—' }}</span>
            </div>
            <div><span class="text-faint">耗时：</span><span class="font-mono text-primary">{{ selectedNetwork.duration }}ms</span></div>
          </div>

          <!-- 错误 -->
          <div v-if="selectedNetwork.error" class="bg-red-soft border border-red-soft rounded p-3">
            <div class="text-xs text-red-400 mb-1">错误</div>
            <div class="text-sm text-red-key font-mono">{{ selectedNetwork.error }}</div>
          </div>

          <!-- WebSocket 帧时间线（仅 WS 连接条目，对齐 DevTools 的 Messages 面板） -->
          <div v-if="selectedNetwork.protocol === 'ws'">
            <div class="text-xs text-faint mb-1">帧时间线 <span class="ml-1">({{ selectedNetwork.frames?.length ?? 0 }} 帧)</span></div>
            <div class="bg-surface border border-base rounded p-2 space-y-0.5 max-h-80 overflow-y-auto">
              <div v-for="(f, fi) in selectedNetwork.frames" :key="fi" class="text-xs font-mono flex gap-2">
                <span class="text-faint shrink-0">{{ new Date(f.timestamp).toLocaleTimeString() }}</span>
                <span class="shrink-0" :class="f.dir === 'send' ? 'text-blue-key' : f.dir === 'recv' ? 'text-green-600' : 'text-red-500'">{{ f.dir === 'send' ? '↑ send' : f.dir === 'recv' ? '↓ recv' : '⚠ ' + f.data }}</span>
                <span v-if="f.dir !== 'event'" class="text-primary break-all">{{ f.data }}</span>
              </div>
              <div v-if="!selectedNetwork.frames?.length" class="text-faint text-center py-4 text-xs">暂无帧（连接已建立，等待收发消息）</div>
            </div>
          </div>

          <!-- SSE 事件时间线（仅 SSE 连接条目，对齐 DevTools 的 EventStream 面板） -->
          <div v-if="selectedNetwork.sseState">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs text-faint">SSE 事件流</span>
              <span class="text-xs" :class="selectedNetwork.sseState === 'open' ? 'text-green-600' : 'text-faint'">
                {{ selectedNetwork.sseState === 'open' ? '● 连接中' : '○ 已关闭' }}
              </span>
              <span class="text-xs text-faint">({{ selectedNetwork.events?.length ?? 0 }} 事件)</span>
            </div>
            <div class="bg-surface border border-base rounded p-2 space-y-0.5 max-h-80 overflow-y-auto">
              <div v-for="(e, ei) in selectedNetwork.events" :key="ei" class="text-xs font-mono">
                <div class="flex gap-2">
                  <span class="text-faint shrink-0">{{ new Date(e.timestamp).toLocaleTimeString() }}</span>
                  <span class="shrink-0 text-purple-key">{{ e.event }}</span>
                  <span v-if="e.id" class="shrink-0 text-faint">id:{{ e.id }}</span>
                </div>
                <div class="text-primary break-all pl-4">{{ e.data }}</div>
              </div>
              <div v-if="!selectedNetwork.events?.length" class="text-faint text-center py-4 text-xs">暂无事件（连接已建立，等待服务端推送）</div>
            </div>
          </div>

          <!-- 请求头 -->
          <div v-if="selectedNetwork.reqHeaders">
            <div class="text-xs text-faint mb-1">请求头</div>
            <pre class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all">{{ formatHeaders(selectedNetwork.reqHeaders) }}</pre>
          </div>

          <!-- 响应头 -->
          <div v-if="selectedNetwork.resHeaders">
            <div class="text-xs text-faint mb-1">响应头</div>
            <pre class="text-xs font-mono text-primary bg-surface p-3 rounded border border-base whitespace-pre-wrap break-all">{{ formatHeaders(selectedNetwork.resHeaders) }}</pre>
          </div>

          <!-- 请求体 -->
          <div v-if="selectedNetwork.reqBody">
            <div class="text-xs text-faint mb-1">请求体</div>
            <div class="bg-surface p-3 rounded border border-base">
              <ObjectInspector :json="selectedNetwork.reqBody" />
            </div>
          </div>

          <!-- 响应体 -->
          <div v-if="selectedNetwork.resBody">
            <div class="flex items-center justify-between mb-1">
              <div class="text-xs text-faint">响应体</div>
              <!-- 视图切换：只在 base64 图片和文本之间切换 -->
              <div v-if="isImagePreview(selectedNetwork) || isBinaryInfo(selectedNetwork)" class="flex items-center gap-1">
                <button
                  @click="resBodyViewMode = 'preview'"
                  class="px-2 py-0.5 text-xs rounded font-medium transition-colors"
                  :class="resBodyViewMode === 'preview' ? 'bg-blue-500 text-white' : 'bg-elevated text-secondary bg-elevated-hover'"
                >预览</button>
                <button
                  @click="resBodyViewMode = 'raw'"
                  class="px-2 py-0.5 text-xs rounded font-medium transition-colors"
                  :class="resBodyViewMode === 'raw' ? 'bg-blue-500 text-white' : 'bg-elevated text-secondary bg-elevated-hover'"
                >原始</button>
              </div>
            </div>
            <div class="bg-surface p-3 rounded border border-base">
              <!-- 图片预览模式 -->
              <template v-if="isImagePreview(selectedNetwork) && resBodyViewMode === 'preview'">
                <div class="space-y-2">
                  <img :src="selectedNetwork.resBody" alt="响应预览" class="max-w-full rounded border border-light" style="max-height: 300px;" />
                  <div class="text-xs text-faint font-mono">{{ selectedNetwork.resBodyMime }} · {{ selectedNetwork.resBody!.length }} chars (base64)</div>
                </div>
              </template>
              <!-- 二进制信息模式 -->
              <template v-else-if="isBinaryInfo(selectedNetwork) && resBodyViewMode === 'preview'">
                <div class="text-sm text-secondary font-mono">{{ selectedNetwork.resBody }}</div>
              </template>
              <!-- 原始文本 / JSON 文本 -->
              <template v-else-if="!isBinaryInfo(selectedNetwork)">
                <ObjectInspector :json="resBodyViewMode === 'raw' && isImagePreview(selectedNetwork) ? selectedNetwork.resBody!.substring(0, 200) + '...' : selectedNetwork.resBody" />
              </template>
              <!-- info 模式的原始视图（无内容可显示） -->
              <template v-else>
                <div class="text-xs text-faint">无原始内容（二进制未读取）</div>
              </template>
            </div>
          </div>

          <!-- 无 body 提示 -->
          <div v-if="!selectedNetwork.reqBody && !selectedNetwork.resBody && !selectedNetwork.error" class="text-xs text-faint">
            此请求无请求体/响应体（可能是 GET 请求或响应未完成）
          </div>
        </div>
      </template>
      <div v-else class="text-faint text-center py-8 text-sm">点击左侧请求查看详情</div>
    </div>
  </div>
</template>
