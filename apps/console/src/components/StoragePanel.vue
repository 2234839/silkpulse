<script setup lang="ts">
/**
 * StoragePanel —— 远程设备存储读写面板
 *
 * 三个子 Tab（localStorage / sessionStorage / cookie），
 * 每条记录一行（key + value + 编辑/删除），顶部"新增"按钮。
 * 编辑/新增用行内 input（不弹窗，轻快）。
 *
 * 复用 server 的 /storage 端点（GET 读 / POST set|delete）。
 */
import { ref, computed, watch } from 'vue'
import ObjectInspector from './ObjectInspector.vue'
import { apiFetch } from '../utils/api'

type StorageType = 'local' | 'session' | 'cookie' | 'indexeddb'

/**
 * IndexedDB database 结构（server /storage?type=indexeddb 返回）
 */
interface IndexedDBStore {
  name: string
  keyPath: string | string[] | null
  recordCount: number
  records: Array<{ key: string; value: string }>
}
interface IndexedDBDatabase {
  name: string
  version: number
  stores?: IndexedDBStore[]
  error?: string
}

const props = defineProps<{
  /** 当前选中设备 id */
  deviceId: string
  /**
   * storage 变化版本号（useConsoleSocket 维护）
   *
   * SDK 劫持 setItem/removeItem → 发 storage-change → server 转发 →
   * useConsoleSocket 递增此值 → 本组件 watch 后自动刷新。
   */
  storageVersion: number
  /** 最后一次 storage 变化的时间戳（面板显示用） */
  storageUpdateTime: number | null
  /**
   * 每个 storage key 的最后修改时间（运行期间 SDK 捕获）
   *
   * key = `${storageType}::${storageKey}`，值 = timestamp。
   * 只在 SDK 运行期间有效——刷新前的数据没有时间戳，列里显示为空。
   */
  storageKeyTimes: Record<string, number>
}>()

/** 当前激活的 storage 类型 */
const storageType = ref<StorageType>('local')
/** 当前 storage 数据（local/session/cookie 是 key→value） */
const storageData = ref<Record<string, string>>({})
/** IndexedDB databases（独立存储，结构与平铺 storage 不同） */
const indexedDBData = ref<IndexedDBDatabase[]>([])
/** IndexedDB 树展开状态：key = `${dbName}/${storeName}` */
const expandedStores = ref<Set<string>>(new Set())
/** 是否正在加载 */
const storageLoading = ref(false)
/** 选中的 key（底部可视化编辑面板展示） */
const selectedKey = ref<string | null>(null)
/** 编辑面板 textarea 的草稿值 */
const editDraft = ref('')
/** 新增模式的 key 草稿 */
const storageNewKey = ref('')
/** 是否处于新增模式 */
const storageAdding = ref(false)
/** 新增模式 value 草稿 */
const storageNewValue = ref('')
/** 操作反馈（"已保存" / "已删除"） */
const storageFeedback = ref('')
/**
 * 竞态保护策略
 *
 * 问题：高频 storage-change 推送（如 DeepSeek SPA 每秒多次写 localStorage）
 * 会频繁触发 loadStorage。如果上一次请求还没返回（设备端 exec 慢），
 * 新请求会和旧请求并发，设备端同时执行两个 exec → 可能返回空结果。
 *
 * 方案：「单飞 + 待重载」
 * - storageVersion 触发的刷新：如果正在加载，只标记 needsReload，等当前完成后再加载
 * - 设备/type 切换：force=true，不等当前请求，立即开始新的（旧请求结果会被忽略）
 * - 这样保证 storageVersion 的高频推送不会产生并发 exec
 */
let isLoading = false
let needsReload = false
/** 当前加载对应的设备+类型签名，用于判断旧请求是否还有效 */
let currentLoadSignature = ''
/** storageVersion 防抖定时器 */
let storageVersionTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 加载当前类型的 storage
 *
 * @param force 设备/type 切换时传 true：不等当前请求，立即开始新的。
 *              旧请求返回时签名不匹配会被忽略。
 */
async function loadStorage(force = false) {
  if (!props.deviceId) return

  /** 如果正在加载，根据 force 决定行为 */
  if (isLoading && !force) {
    needsReload = true
    return
  }

  /** 记录本次加载的签名，旧请求返回时如果签名不匹配则忽略结果 */
  const signature = `${props.deviceId}:${storageType.value}`
  currentLoadSignature = signature
  isLoading = true
  storageLoading.value = true
  try {
    const res = await apiFetch(`/api/devices/${props.deviceId}/storage?type=${storageType.value}`)
    /** 签名不匹配说明期间发生了设备/type 切换，忽略本次结果 */
    if (currentLoadSignature !== signature) return
    if (res.ok) {
      if (storageType.value === 'indexeddb') {
        const data = await res.json()
        if (currentLoadSignature !== signature) return
        indexedDBData.value = data.databases ?? []
      } else {
        const data = await res.json()
        if (currentLoadSignature !== signature) return
        storageData.value = data
      }
    }
  } catch {
    /** 静默错误，保留已有数据 */
  } finally {
    /** 只在签名匹配（没有更新的 force 请求接手）时更新状态 */
    if (currentLoadSignature === signature) {
      isLoading = false
      storageLoading.value = false
      /** 如果在本次加载期间有新的 storageVersion 变更到达，自动再加载一次 */
      if (needsReload) {
        needsReload = false
        loadStorage()
      }
    }
  }
}

/**
 * 设备切换或组件挂载时首次加载
 *
 * immediate: true 确保面板被 v-if 渲染时就拉取
 */
watch(() => props.deviceId, () => {
  /** 切换设备时立即清空旧数据 */
  storageData.value = {}
  indexedDBData.value = []
  selectedKey.value = null
  editDraft.value = ''
  storageAdding.value = false
  loadStorage(true)
}, { immediate: true })
/**
 * storageVersion 变化时自动刷新（SDK 实时推送 storage-change → 版本号递增）
 *
 * 加 500ms 防抖：高频 SPA（如 DeepSeek）可能频繁修改 localStorage，
 * 避免每次变化都发请求导致竞态和性能问题。
 */
watch(() => props.storageVersion, () => {
  if (storageVersionTimer) clearTimeout(storageVersionTimer)
  storageVersionTimer = setTimeout(() => {
    storageVersionTimer = null
    loadStorage()
  }, 500)
})

/**
 * 切换 storage 类型
 *
 * 切换时立即清空旧数据 + 重置选中状态，
 * 让用户在 loadStorage 的 await 期间看到空表格而非上一个 type 的残留。
 */
function switchStorageType(t: StorageType) {
  if (storageType.value === t) return
  storageType.value = t
  /** 切换类型时清空旧数据（类型级别切换，不会有竞态问题） */
  storageData.value = {}
  indexedDBData.value = []
  selectedKey.value = null
  editDraft.value = ''
  storageAdding.value = false
  loadStorage(true)
}

/** 选中某条 → 底部展示可视化编辑面板 */
function selectKey(key: string) {
  selectedKey.value = key
  editDraft.value = storageData.value[key] ?? ''
  /** 每次选中时重置 JSON 树数据（避免上一项的编辑残留） */
  jsonTreeData.value = null
  storageAdding.value = false
}

/** 取消选中 */
function deselectKey() {
  selectedKey.value = null
  editDraft.value = ''
}

/** 保存选中项 */
async function saveSelected() {
  if (!props.deviceId || !selectedKey.value) return
  const res = await apiFetch(`/api/devices/${props.deviceId}/storage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'set',
      type: storageType.value,
      key: selectedKey.value,
      value: editDraft.value,
    }),
  })
  if (res.ok) {
    showStorageFeedback('✓ 已保存')
    await loadStorage()
  }
}

/** 开始新增 */
function startAddStorage() {
  storageAdding.value = true
  storageNewKey.value = ''
  storageNewValue.value = ''
  selectedKey.value = null
  editDraft.value = ''
}

/** 取消新增 */
function cancelAddStorage() {
  storageAdding.value = false
  storageNewKey.value = ''
  storageNewValue.value = ''
}

/** 保存新增 */
async function saveNewStorage() {
  if (!props.deviceId) return
  const key = storageNewKey.value.trim()
  if (!key) return
  const res = await apiFetch(`/api/devices/${props.deviceId}/storage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'set',
      type: storageType.value,
      key,
      value: storageNewValue.value,
    }),
  })
  if (res.ok) {
    showStorageFeedback('✓ 已保存')
    cancelAddStorage()
    await loadStorage()
  }
}

/** 删除某条 */
async function deleteStorage(key: string) {
  if (!props.deviceId) return
  const res = await apiFetch(`/api/devices/${props.deviceId}/storage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'delete',
      type: storageType.value,
      key,
    }),
  })
  if (res.ok) {
    showStorageFeedback('✓ 已删除')
    await loadStorage()
  }
}

/** 显示操作反馈（1.5s 后消失） */
function showStorageFeedback(msg: string) {
  storageFeedback.value = msg
  setTimeout(() => { storageFeedback.value = '' }, 1500)
}

/** IndexedDB store 展开/收起 */
function toggleStore(dbName: string, storeName: string) {
  const key = `${dbName}/${storeName}`
  if (expandedStores.value.has(key)) {
    expandedStores.value.delete(key)
  } else {
    expandedStores.value.add(key)
  }
  /** 触发 Set 响应式更新（Set 删除/添加不自动触发 Vue 更新，重新赋值） */
  expandedStores.value = new Set(expandedStores.value)
}

/** IndexedDB store 是否展开 */
function isStoreExpanded(dbName: string, storeName: string): boolean {
  return expandedStores.value.has(`${dbName}/${storeName}`)
}

/** IndexedDB 删除单条 record（通过 exec 通道） */
async function deleteIndexedDBRecord(dbName: string, storeName: string, key: string) {
  if (!props.deviceId) return
  const res = await apiFetch(`/api/devices/${props.deviceId}/storage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'delete',
      type: 'indexeddb',
      key,
      store: storeName,
    }),
  })
  if (res.ok) {
    showStorageFeedback('✓ 已删除')
    await loadStorage()
  }
}

/** 格式化更新时间（HH:MM:SS） */
const formattedUpdateTime = computed(() => {
  if (!props.storageUpdateTime) return null
  const d = new Date(props.storageUpdateTime)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
})

/**
 * 获取某条 storage key 的修改时间（SDK 运行期间捕获）
 *
 * 返回 null 表示该 key 在 SDK 启动前就存在，没捕获到修改时间。
 */
function getKeyTime(key: string): string | null {
  const ts = props.storageKeyTimes[`${storageType.value}::${key}`]
  if (!ts) return null
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** 检测 value 的类型（用于可视化面板高亮） */
type ValueType = 'json' | 'number' | 'boolean' | 'null' | 'string'

function detectValueType(value: string): ValueType {
  const trimmed = value.trim()
  if (trimmed === 'null') return 'null'
  if (trimmed === 'true' || trimmed === 'false') return 'boolean'
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return 'number'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      return 'string'
    }
  }
  return 'string'
}

/** 选中项的类型 */
const selectedValueType = computed<ValueType | null>(() => {
  if (!selectedKey.value) return null
  return detectValueType(editDraft.value)
})

/**
 * JSON 树编辑器的数据（从 editDraft 解析）
 *
 * null 表示当前不是 JSON 类型或解析失败。
 * 用 ref 而非 computed——树编辑是交互式的，需要持有解析后的引用，
 * 不能随 editDraft 每次 re-render 都重新解析。
 */
const jsonTreeData = ref<unknown>(null)

/** editDraft 变化时同步解析 JSON 到树数据 */
watch(editDraft, (val) => {
  try {
    jsonTreeData.value = JSON.parse(val)
  } catch {
    jsonTreeData.value = null
  }
})

/** JSON 树编辑后的新值同步回 editDraft（ObjectInspector json 模式 emit 字符串） */
function onJsonTreeUpdate(newValue: unknown) {
  /** ObjectInspector json 模式直接 emit JSON.stringify 后的字符串 */
  editDraft.value = typeof newValue === 'string' ? newValue : JSON.stringify(newValue, null, 2)
  /** 同步 jsonTreeData（用于 v-if 判断） */
  try {
    jsonTreeData.value = JSON.parse(editDraft.value)
  } catch {
    jsonTreeData.value = null
  }
}

/** 新增 value 是否是合法 JSON（用于决定是否展示树编辑器） */
const isNewValueJson = computed(() => {
  const trimmed = storageNewValue.value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
})
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden bg-base">
    <!-- 子 Tab 栏 + 新增按钮 + 更新时间 -->
    <div class="flex items-center gap-2 px-4 py-2 border-b border-base bg-surface">
      <div class="flex gap-1">
        <button
          v-for="t in (['local', 'session', 'cookie', 'indexeddb'] as const)"
          :key="t"
          @click="switchStorageType(t)"
          class="px-3 py-1 text-xs rounded font-medium transition-colors"
          :class="storageType === t
            ? 'bg-blue-600 text-white'
            : 'bg-elevated text-secondary hover:bg-elevated-hover'"
        >{{ t === 'local' ? 'localStorage' : t === 'session' ? 'sessionStorage' : t === 'cookie' ? 'Cookie' : 'IndexedDB' }}</button>
      </div>

      <!-- 更新时间（收到过 storage-change 才显示） -->
      <div class="ml-auto flex items-center gap-2">
        <span v-if="formattedUpdateTime" class="text-[10px] text-faint flex items-center gap-1">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
          实时 · {{ formattedUpdateTime }}
        </span>
        <button
          v-if="!storageAdding && storageType !== 'indexeddb'"
          @click="startAddStorage"
          class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary"
        >+ 新增</button>
        <button
          v-if="storageType === 'indexeddb'"
          @click="loadStorage"
          :disabled="storageLoading"
          class="px-2 py-1 text-xs rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary disabled:opacity-50"
        >{{ storageLoading ? '...' : '刷新' }}</button>
        <span v-if="storageFeedback" class="text-xs text-green-600">{{ storageFeedback }}</span>
      </div>
    </div>

    <!-- ==================== IndexedDB 树状视图 ==================== -->
    <div v-if="storageType === 'indexeddb'" class="flex-1 overflow-y-auto p-4 font-mono text-xs">
      <div v-if="storageLoading && indexedDBData.length === 0" class="text-faint text-center py-8">加载中...</div>
      <div v-else-if="indexedDBData.length === 0" class="text-faint text-center py-8">
        暂无 IndexedDB 数据库<br>
        <span class="text-[10px]">（IndexedDB 需要浏览器支持 indexedDB.databases() API）</span>
      </div>
      <template v-else>
        <div v-for="db in indexedDBData" :key="db.name" class="mb-4">
          <!-- database 标题行 -->
          <div class="flex items-center gap-1 text-primary font-semibold pb-1 border-b border-light">
            <span>🗃️ {{ db.name }}</span>
            <span class="text-faint text-[10px]">v{{ db.version }}</span>
            <span v-if="db.error" class="text-red-500 text-[10px]">{{ db.error }}</span>
          </div>
          <!-- stores -->
          <div v-if="db.stores && db.stores.length > 0">
            <div v-for="store in db.stores" :key="store.name" class="ml-4 mt-1">
              <!-- store 标题行（可折叠） -->
              <button
                @click="toggleStore(db.name, store.name)"
                class="flex items-center gap-1 text-secondary hover:text-primary w-full text-left py-0.5"
              >
                <span class="text-[10px] text-faint">{{ isStoreExpanded(db.name, store.name) ? '▼' : '▶' }}</span>
                <span>📦 {{ store.name }}</span>
                <span class="text-faint text-[10px]">({{ store.recordCount }} 条)</span>
                <span v-if="store.keyPath" class="text-faint text-[10px]">keyPath: {{ Array.isArray(store.keyPath) ? store.keyPath.join('.') : store.keyPath }}</span>
              </button>
              <!-- records（展开时） -->
              <div v-if="isStoreExpanded(db.name, store.name)" class="ml-6 mt-0.5 space-y-0.5">
                <div
                  v-for="record in store.records"
                  :key="record.key"
                  class="flex items-start gap-2 group hover:bg-blue-soft px-1 -mx-1 rounded"
                >
                  <span class="text-blue-key shrink-0">{{ record.key }}:</span>
                  <div class="flex-1 min-w-0">
                    <ObjectInspector :json="record.value" />
                  </div>
                  <button
                    @click="deleteIndexedDBRecord(db.name, store.name, record.key)"
                    class="text-[10px] text-faint hover:text-red-500 opacity-0 group-hover:opacity-100 shrink-0"
                    title="删除此条"
                  >✕</button>
                </div>
                <div v-if="store.records.length === 0" class="text-faint italic ml-2">空 store</div>
              </div>
            </div>
          </div>
          <div v-else class="ml-4 text-faint italic text-[10px] mt-1">无 objectStore</div>
        </div>
      </template>
    </div>

    <!-- ==================== 平铺表格视图（local/session/cookie） ==================== -->
    <template v-else>
      <!-- 表格（可滚动区域） -->
      <div class="flex-1 overflow-y-auto">
        <div v-if="storageLoading" class="text-faint text-center py-8">加载中...</div>
        <table v-else class="w-full text-sm">
          <thead class="bg-surface text-secondary text-xs uppercase sticky top-0 z-10 shadow-[0_1px_0_0_var(--cs-border)]">
            <tr>
              <th class="text-left px-3 py-2 w-1/4">Key</th>
              <th class="text-left px-3 py-2">Value</th>
              <th class="text-left px-3 py-2 w-28">更新时间</th>
              <th class="text-right px-3 py-2 w-16">操作</th>
            </tr>
          </thead>
          <tbody>
            <!-- 已有数据行 -->
            <template v-if="Object.keys(storageData).length > 0">
              <tr
                v-for="(value, key) in storageData"
                :key="key"
                class="border-b border-light hover:bg-blue-soft"
                :class="{ 'bg-blue-soft': selectedKey === String(key) }"
              >
                <td class="px-3 py-2 text-xs font-mono text-primary break-all">{{ key }}</td>
                <td
                  class="px-3 py-2 text-xs font-mono break-all max-w-md cursor-pointer"
                  :class="selectedKey === String(key) ? 'text-primary' : 'text-muted'"
                  @click="selectKey(String(key))"
                >
                  <div v-if="value.length > 200" class="max-h-24 overflow-y-auto">{{ value }}</div>
                  <template v-else>{{ value }}</template>
                </td>
                <td class="px-3 py-2 text-xs text-faint whitespace-nowrap">{{ getKeyTime(String(key)) ?? '' }}</td>
                <td class="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    @click="deleteStorage(String(key))"
                    class="text-xs px-2 py-0.5 rounded border border-red-soft text-red-500 hover:bg-red-soft"
                  >删除</button>
                </td>
              </tr>
            </template>
            <!-- 空状态 -->
            <tr v-else-if="!storageAdding">
              <td colspan="4" class="text-faint text-center py-8 text-sm">
                {{ storageType === 'cookie' ? '暂无 Cookie' : `暂无 ${storageType === 'local' ? 'localStorage' : 'sessionStorage'} 数据` }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ==================== 底部：编辑/新增面板 ==================== -->
      <div
        v-if="selectedKey || storageAdding"
        class="border-t border-base bg-surface shrink-0"
      >
        <!-- 新增模式 -->
        <div v-if="storageAdding" class="p-4 space-y-3">
          <div class="flex items-center gap-2">
            <span class="text-xs text-faint">新增 key:</span>
            <input
              v-model="storageNewKey"
              placeholder="key"
              class="flex-1 text-xs font-mono px-2 py-1.5 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400"
              @keydown.esc="cancelAddStorage"
            />
            <button
              @click="saveNewStorage"
              class="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 shrink-0"
            >保存</button>
            <button
              @click="cancelAddStorage"
              class="text-xs px-3 py-1.5 rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary shrink-0"
            >取消</button>
          </div>
          <div>
            <div class="text-[10px] text-faint mb-1">value（支持 JSON 自动格式化）</div>
            <textarea
              v-model="storageNewValue"
              rows="4"
              placeholder='value（如 {"key":"val"} 或 plain string）'
              class="w-full text-xs font-mono px-2 py-1.5 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400 resize-y"
              @keydown.esc="cancelAddStorage"
            />
            <!-- JSON 树编辑器（原地编辑 + 折叠展开） -->
            <template v-if="isNewValueJson">
              <div class="mt-1 rounded border border-light bg-elevated p-2 overflow-x-auto max-h-64 overflow-y-auto">
                <div class="text-[10px] text-faint mb-1">JSON 树编辑</div>
                <ObjectInspector
                  :json="storageNewValue"
                  :editable="true"
                  @update:model-value="storageNewValue = String($event)"
                />
              </div>
            </template>
          </div>
        </div>

        <!-- 选中编辑模式 -->
        <div v-else-if="selectedKey" class="p-4 space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-xs font-mono text-primary font-semibold">{{ selectedKey }}</span>
              <!-- 类型标签 -->
              <span
                v-if="selectedValueType"
                class="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                :class="{
                  'bg-purple-100 text-purple-700': selectedValueType === 'json',
                  'bg-blue-100 text-blue-700': selectedValueType === 'number',
                  'bg-orange-100 text-orange-700': selectedValueType === 'boolean',
                  'bg-gray-100 text-gray-600': selectedValueType === 'null',
                  'bg-green-100 text-green-700': selectedValueType === 'string',
                }"
              >{{ selectedValueType }}</span>
              <!-- 更新时间 -->
              <span v-if="getKeyTime(selectedKey)" class="text-[10px] text-faint">
                {{ getKeyTime(selectedKey) }} 更新
              </span>
            </div>
            <div class="flex items-center gap-1">
              <button
                @click="saveSelected"
                class="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700"
              >保存</button>
              <button
                @click="deselectKey"
                class="text-xs px-3 py-1.5 rounded border border-base bg-elevated hover:bg-elevated-hover text-secondary"
              >关闭</button>
            </div>
          </div>

          <!-- 编辑区 -->
          <div>
            <!-- JSON 树编辑器（原地编辑 + 折叠展开） -->
            <div v-if="selectedValueType === 'json' && jsonTreeData !== null" class="rounded border border-light bg-elevated p-2 overflow-x-auto max-h-64 overflow-y-auto">
              <div class="text-[10px] text-faint mb-1">JSON 树编辑（点击值直接修改，点击 ▶ 展开/折叠）</div>
              <ObjectInspector
                :json="editDraft"
                :editable="true"
                @update:model-value="onJsonTreeUpdate"
              />
            </div>
            <!-- 纯文本编辑（JSON 类型可折叠收起；非 JSON 类型直接显示） -->
            <details v-if="selectedValueType === 'json'" class="mt-2">
              <summary class="text-[10px] text-faint cursor-pointer hover:text-secondary">纯文本编辑</summary>
              <textarea
                v-model="editDraft"
                rows="4"
                class="w-full mt-1 text-xs font-mono px-2 py-1.5 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400 resize-y"
                @keydown.meta.enter="saveSelected"
                @keydown.ctrl.enter="saveSelected"
                @keydown.esc="deselectKey"
              />
            </details>
            <textarea
              v-else
              v-model="editDraft"
              rows="4"
              class="w-full text-xs font-mono px-2 py-1.5 border border-input rounded bg-input text-primary focus:outline-none focus:border-blue-400 resize-y"
              @keydown.meta.enter="saveSelected"
              @keydown.ctrl.enter="saveSelected"
              @keydown.esc="deselectKey"
            />
            <!-- 操作提示 -->
            <div class="mt-1 text-[10px] text-faint">
              ⌘/Ctrl+Enter 保存 · Esc 关闭
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
