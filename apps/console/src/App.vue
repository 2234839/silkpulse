<script setup lang="ts">
/**
 * clarosight 控制台主组件
 *
 * 布局：左侧设备列表，右侧选中设备的 console / network / errors / snapshot 面板
 */
import { ref, computed, watch, onMounted } from 'vue'
import type { NetworkEntry } from '@clarosight/shared'
import { useConsoleSocket } from './composables/useConsoleSocket'
import { useSnapshot } from './composables/useSnapshot'
import { useAiContext } from './composables/useAiContext'

const {
  devices,
  logs,
  network,
  errors,
  selectedDeviceId,
  connected,
  connect,
  selectDevice,
} = useConsoleSocket()

const { snapshotText, loading: snapLoading, fetchSnapshot } = useSnapshot()
const {
  contextText,
  generating,
  copyState,
  generate: generateAiContext,
  copyToClipboard,
} = useAiContext()

/** 当前选中的设备对象（供 AI 上下文取 title/url） */
const selectedDevice = computed(() =>
  devices.value.find((d) => d.id === selectedDeviceId.value) ?? null
)

/** 设备类型 → emoji 图标 */
const deviceTypeIcon = (t: string): string => {
  if (t === 'mobile') return '📱'
  if (t === 'tablet') return '📲'
  return '🖥️'
}

/** network 面板：选中的请求条目（点击展开详情） */
const selectedNetwork = ref<NetworkEntry | null>(null)

/** 设备列表搜索（按标题/URL/类型 筛选） */
const deviceSearch = ref('')
const filteredDevices = computed(() => {
  const q = deviceSearch.value.trim().toLowerCase()
  if (!q) return devices.value
  return devices.value.filter((d) =>
    d.title.toLowerCase().includes(q)
    || d.url.toLowerCase().includes(q)
    || (d.deviceType ?? '').toLowerCase().includes(q)
  )
})

/** AI 诊断弹窗 */
const showAiModal = ref(false)

/** 生成 AI 诊断上下文并弹窗展示 */
async function openAiContext() {
  if (!selectedDevice.value) return
  showAiModal.value = true
  await generateAiContext({
    deviceId: selectedDevice.value.id,
    title: selectedDevice.value.title,
    url: selectedDevice.value.url,
    errors: errors.value,
    network: network.value,
    logs: logs.value,
  })
}

/** 当前激活的面板 */
const activeTab = ref<'console' | 'network' | 'errors' | 'snapshot'>('console')

/** 日志级别 → tailwind 颜色 */
const logColor = (type: string): string => {
  if (type === 'error') return 'text-red-600'
  if (type === 'warn') return 'text-amber-600'
  if (type === 'debug') return 'text-gray-400'
  return 'text-gray-700'
}

/** Console 面板：级别筛选 + 搜索 */
const logLevelFilter = ref<'all' | 'error' | 'warn' | 'info' | 'debug'>('all')
const logSearch = ref('')
/** 筛选后的日志（级别 + 关键词） */
const filteredLogs = computed(() => {
  let result = logs.value
  if (logLevelFilter.value !== 'all') {
    result = result.filter((l) => l.type === logLevelFilter.value)
  }
  const q = logSearch.value.trim().toLowerCase()
  if (q) {
    result = result.filter((l) => l.message.toLowerCase().includes(q))
  }
  return result
})

/** 选中设备变化时拉取快照 + 清空 network 详情选中 */
watch(selectedDeviceId, (id) => {
  selectedNetwork.value = null
  if (id && activeTab.value === 'snapshot') {
    fetchSnapshot(id)
  }
})

/** 切到 snapshot 面板时拉取 */
watch(activeTab, (tab) => {
  if (tab === 'snapshot' && selectedDeviceId.value) {
    fetchSnapshot(selectedDeviceId.value)
  }
})

/** 刷新快照 */
function refreshSnapshot() {
  if (selectedDeviceId.value) fetchSnapshot(selectedDeviceId.value)
}

onMounted(() => connect())
</script>

<template>
  <div class="h-screen flex flex-col">
    <!-- 顶部栏 -->
    <header class="bg-gray-900 text-white px-6 py-3 flex items-center gap-4">
      <h1 class="text-lg font-semibold">clarosight</h1>
      <span class="text-xs text-gray-400">远程设备调试控制台</span>
      <span
        class="ml-auto flex items-center gap-2 text-xs"
        :class="connected ? 'text-green-400' : 'text-red-400'"
      >
        <span
          class="w-2 h-2 rounded-full"
          :class="connected ? 'bg-green-400' : 'bg-red-400'"
        />
        {{ connected ? '已连接' : '断开中' }}
      </span>
      <button
        v-if="selectedDevice"
        @click="openAiContext"
        :disabled="generating"
        class="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
      >
        <span v-if="generating">生成中...</span>
        <span v-else>✨ 复制 AI 诊断上下文</span>
      </button>
    </header>

    <div class="flex-1 flex overflow-hidden">
      <!-- 左侧：设备列表 -->
      <aside class="w-72 border-r border-gray-200 bg-white overflow-y-auto flex flex-col">
        <div class="px-4 py-3 border-b border-gray-200">
          <h2 class="text-sm font-semibold text-gray-700">
            在线设备
            <span class="text-gray-400 font-normal">({{ devices.length }})</span>
          </h2>
          <input
            v-model="deviceSearch"
            placeholder="搜索设备（标题/URL/类型）..."
            class="mt-2 w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400"
          />
        </div>
        <ul>
          <li
            v-for="d in filteredDevices"
            :key="d.id"
            @click="selectDevice(d.id)"
            class="px-4 py-3 border-b border-gray-100 cursor-pointer hover:bg-gray-50 relative"
            :class="selectedDeviceId === d.id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''"
          >
            <!-- 有错误时左侧红条 -->
            <span
              v-if="d.errorCount > 0"
              class="absolute left-0 top-0 bottom-0 w-1 bg-red-400"
            />
            <div class="text-sm font-medium text-gray-800 truncate">
              <span class="mr-1">{{ deviceTypeIcon(d.deviceType) }}</span>{{ d.title }}
            </div>
            <div class="text-xs text-gray-500 truncate">{{ d.url }}</div>
            <div class="flex items-center gap-2 mt-1">
              <span class="text-xs text-gray-400">{{ d.deviceType }} · {{ d.viewportWidth }}×{{ d.viewportHeight }}</span>
              <span v-if="d.errorCount > 0" class="text-xs text-red-500 font-medium">{{ d.errorCount }} 错误</span>
            </div>
          </li>
          <li v-if="devices.length === 0" class="px-4 py-8 text-center text-sm text-gray-400">
            暂无在线设备
          </li>
          <li v-else-if="filteredDevices.length === 0" class="px-4 py-8 text-center text-sm text-gray-400">
            无匹配设备
          </li>
        </ul>
      </aside>

      <!-- 右侧：面板 -->
      <main class="flex-1 flex flex-col overflow-hidden">
        <template v-if="selectedDeviceId">
          <!-- Tab 栏 -->
          <nav class="flex border-b border-gray-200 bg-white">
            <button
              v-for="tab in (['console', 'network', 'errors', 'snapshot'] as const)"
              :key="tab"
              @click="activeTab = tab"
              class="px-4 py-2 text-sm font-medium border-b-2"
              :class="activeTab === tab
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'"
            >
              {{ tab === 'console' ? 'Console' : tab === 'network' ? 'Network' : tab === 'errors' ? 'Errors' : 'Snapshot' }}
            </button>
            <button
              v-if="activeTab === 'snapshot'"
              @click="refreshSnapshot"
              class="ml-auto px-4 py-2 text-xs text-gray-500 hover:text-gray-700"
            >
              刷新
            </button>
          </nav>

          <!-- Console 面板（含级别筛选 + 搜索） -->
          <div v-if="activeTab === 'console'" class="flex-1 flex flex-col overflow-hidden bg-gray-50">
            <!-- 工具栏 -->
            <div class="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-white">
              <div class="flex gap-1">
                <button
                  v-for="lvl in (['all', 'error', 'warn', 'info', 'debug'] as const)"
                  :key="lvl"
                  @click="logLevelFilter = lvl"
                  class="px-2 py-0.5 text-xs rounded font-medium"
                  :class="logLevelFilter === lvl
                    ? 'bg-gray-800 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
                >
                  {{ lvl === 'all' ? '全部' : lvl.toUpperCase() }}
                </button>
              </div>
              <input
                v-model="logSearch"
                placeholder="搜索日志..."
                class="ml-auto px-2 py-0.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400 w-48"
              />
              <span class="text-xs text-gray-400">{{ filteredLogs.length }}/{{ logs.length }}</span>
            </div>
            <!-- 日志列表 -->
            <div class="flex-1 overflow-y-auto p-4 font-mono text-sm">
              <div v-for="(log, i) in filteredLogs" :key="i" class="py-0.5 border-b border-gray-100">
                <span class="text-gray-400 text-xs mr-2">{{ new Date(log.timestamp).toLocaleTimeString() }}</span>
                <span class="text-gray-400 text-xs mr-2 uppercase">{{ log.type }}</span>
                <span :class="logColor(log.type)">{{ log.message }}</span>
              </div>
              <div v-if="filteredLogs.length === 0" class="text-gray-400 text-center py-8">
                {{ logs.length === 0 ? '暂无日志' : '无匹配日志' }}
              </div>
            </div>
          </div>

          <!-- Network 面板（主从布局：请求列表 + 详情） -->
          <div v-else-if="activeTab === 'network'" class="flex-1 flex overflow-hidden bg-gray-50">
            <!-- 请求列表 -->
            <div class="w-2/5 overflow-y-auto border-r border-gray-200">
              <table class="w-full text-sm">
                <thead class="bg-gray-100 text-gray-600 text-xs uppercase sticky top-0">
                  <tr>
                    <th class="text-left px-3 py-2">方法</th>
                    <th class="text-left px-3 py-2">状态</th>
                    <th class="text-left px-3 py-2">URL</th>
                    <th class="text-right px-3 py-2">耗时</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(n, i) in network"
                    :key="i"
                    @click="selectedNetwork = n"
                    class="border-b border-gray-100 cursor-pointer hover:bg-blue-50"
                    :class="selectedNetwork === n ? 'bg-blue-50' : ''"
                  >
                    <td class="px-3 py-2 text-gray-600 font-mono text-xs">{{ n.method }}</td>
                    <td class="px-3 py-2 font-mono text-xs" :class="n.status >= 400 ? 'text-red-500' : n.status >= 200 ? 'text-green-600' : 'text-gray-400'">
                      {{ n.status || '—' }}
                    </td>
                    <td class="px-3 py-2 text-gray-700 truncate max-w-[160px] text-xs">{{ n.url.split('/').pop() || n.url }}</td>
                    <td class="px-3 py-2 text-right text-gray-500 text-xs font-mono">{{ n.duration }}ms</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="network.length === 0" class="text-gray-400 text-center py-8 text-sm">暂无网络请求</div>
            </div>

            <!-- 详情面板 -->
            <div class="flex-1 overflow-y-auto p-4">
              <template v-if="selectedNetwork">
                <div class="space-y-4">
                  <!-- 基本信息 -->
                  <div>
                    <div class="text-xs text-gray-400 mb-1">URL</div>
                    <div class="text-sm font-mono text-gray-800 break-all bg-white p-2 rounded border border-gray-200">{{ selectedNetwork.url }}</div>
                  </div>
                  <div class="flex gap-6 text-sm">
                    <div><span class="text-gray-400">方法：</span><span class="font-mono text-gray-800">{{ selectedNetwork.method }}</span></div>
                    <div>
                      <span class="text-gray-400">状态：</span>
                      <span class="font-mono" :class="selectedNetwork.status >= 400 ? 'text-red-500' : 'text-green-600'">{{ selectedNetwork.status || '—' }}</span>
                    </div>
                    <div><span class="text-gray-400">耗时：</span><span class="font-mono text-gray-800">{{ selectedNetwork.duration }}ms</span></div>
                  </div>

                  <!-- 错误 -->
                  <div v-if="selectedNetwork.error" class="bg-red-50 border border-red-200 rounded p-3">
                    <div class="text-xs text-red-400 mb-1">错误</div>
                    <div class="text-sm text-red-700 font-mono">{{ selectedNetwork.error }}</div>
                  </div>

                  <!-- 请求体 -->
                  <div v-if="selectedNetwork.reqBody">
                    <div class="text-xs text-gray-400 mb-1">请求体</div>
                    <pre class="text-xs font-mono text-gray-700 bg-white p-3 rounded border border-gray-200 whitespace-pre-wrap break-all">{{ selectedNetwork.reqBody }}</pre>
                  </div>

                  <!-- 响应体 -->
                  <div v-if="selectedNetwork.resBody">
                    <div class="text-xs text-gray-400 mb-1">响应体</div>
                    <pre class="text-xs font-mono text-gray-700 bg-white p-3 rounded border border-gray-200 whitespace-pre-wrap break-all">{{ selectedNetwork.resBody }}</pre>
                  </div>

                  <!-- 无 body 提示 -->
                  <div v-if="!selectedNetwork.reqBody && !selectedNetwork.resBody && !selectedNetwork.error" class="text-xs text-gray-400">
                    此请求无请求体/响应体（可能是 GET 请求或响应未完成）
                  </div>
                </div>
              </template>
              <div v-else class="text-gray-400 text-center py-8 text-sm">点击左侧请求查看详情</div>
            </div>
          </div>

          <!-- Errors 面板 -->
          <div v-else-if="activeTab === 'errors'" class="flex-1 overflow-y-auto p-4 bg-gray-50 space-y-3">
            <div v-for="(e, i) in errors" :key="i" class="bg-red-50 border border-red-200 rounded p-3">
              <div class="text-sm text-red-800 font-medium">{{ e.message }}</div>
              <div class="text-xs text-gray-400 mt-1">{{ new Date(e.timestamp).toLocaleTimeString() }}</div>
              <pre v-if="e.stack" class="text-xs text-red-600 mt-2 whitespace-pre-wrap">{{ e.stack }}</pre>
            </div>
            <div v-if="errors.length === 0" class="text-gray-400 text-center py-8">暂无错误</div>
          </div>

          <!-- Snapshot 面板 -->
          <div v-else class="flex-1 overflow-y-auto p-4 bg-gray-50">
            <div v-if="snapLoading" class="text-gray-400 text-center py-8">加载中...</div>
            <pre v-else class="text-xs font-mono text-gray-700 whitespace-pre-wrap">{{ snapshotText }}</pre>
          </div>
        </template>

        <!-- 未选中设备时的占位 -->
        <div v-else class="flex-1 flex items-center justify-center text-gray-400">
          <div class="text-center">
            <p class="text-sm">从左侧选择一个设备查看详情</p>
            <p class="text-xs mt-2">接入新设备：在目标页面注入 <code class="bg-gray-100 px-1 rounded">&lt;script src="/sdk.js"&gt;&lt;/script&gt;</code></p>
          </div>
        </div>
      </main>
    </div>

    <!-- AI 诊断上下文弹窗 -->
    <div
      v-if="showAiModal"
      class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      @click.self="showAiModal = false"
    >
      <div class="bg-white rounded-lg shadow-xl w-[720px] max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h3 class="text-sm font-semibold text-gray-800">AI 诊断上下文</h3>
          <div class="flex items-center gap-2">
            <button
              @click="copyToClipboard"
              class="px-3 py-1 text-xs rounded font-medium"
              :class="copyState === 'copied'
                ? 'bg-green-100 text-green-700'
                : copyState === 'error'
                ? 'bg-red-100 text-red-700'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'"
            >
              {{ copyState === 'copied' ? '✓ 已复制' : copyState === 'error' ? '复制失败' : '复制全部' }}
            </button>
            <button
              @click="showAiModal = false"
              class="px-3 py-1 text-xs rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              关闭
            </button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto p-5">
          <pre v-if="generating" class="text-sm text-gray-400">正在拉取设备快照...</pre>
          <pre v-else class="text-xs font-mono text-gray-700 whitespace-pre-wrap">{{ contextText }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
