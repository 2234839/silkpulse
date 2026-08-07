<script setup lang="ts">
/**
 * clarosight 控制台主组件
 *
 * 布局：左侧设备列表，右侧选中设备的 console / network / errors / snapshot 面板
 *
 * 子组件拆分：
 * - AuthPage：登录页
 * - DeviceList：左侧设备列表
 * - InjectPanel：接入代码面板（空状态 + Modal 共用）
 * - ProjectModal：项目管理（仅超管）
 * - AiContextModal：AI 诊断上下文
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useConsoleSocket } from './composables/useConsoleSocket'
import { useAuth } from './composables/useAuth'
import { useTheme } from './composables/useTheme'
import AuthPage from './components/AuthPage.vue'
import DeviceList from './components/DeviceList.vue'
import InjectPanel from './components/InjectPanel.vue'
import ProjectModal from './components/ProjectModal.vue'
import AiContextModal from './components/AiContextModal.vue'
import AgentPromptModal from './components/AgentPromptModal.vue'
import SnapshotPanel from './components/SnapshotPanel.vue'
import FeaturePanel from './components/FeaturePanel.vue'
import ErrorsPanel from './components/ErrorsPanel.vue'
import ConsolePanel from './components/ConsolePanel.vue'
import NetworkPanel from './components/NetworkPanel.vue'
import ExecPanel from './components/ExecPanel.vue'
import ElementPanel from './components/ElementPanel.vue'
import StoragePanel from './components/StoragePanel.vue'

const { theme, toggleTheme } = useTheme()

const {
  devices,
  logs,
  network,
  errors,
  storageVersion,
  storageUpdateTime,
  storageKeyTimes,
  domChangeVersion,
  domChangeData,
  selectedDeviceId,
  connected,
  connect,
  selectDevice,
  setWatchers,
} = useConsoleSocket()

/** ─── 鉴权 ─── */
const {
  apiKey,
  authStatus,
  userRole,
  isPlayground,
  saveKey,
  clearKey,
  checkAuthStatus,
  verifyKey,
  guestLogin,
  isAuthenticated,
} = useAuth()

/** 是否超管 */
const isAdmin = computed(() => userRole.value === 'admin')

/** 当前页面 origin（供 AgentPromptModal 使用，避免模板里直接访问 location） */
const serverOrigin = typeof location !== 'undefined' ? location.origin : ''

/** 是否需要显示鉴权页面 */
const needAuth = computed(() => {
  if (!authStatus.value) return false
  if (!authStatus.value.authEnabled) return false
  return !isAuthenticated()
})

/** ProjectModal 引用（用于读取项目列表做设备列表映射） */
const projectModalRef = ref<InstanceType<typeof ProjectModal> | null>(null)
/** projectId → 项目名映射 */
const projectNameMap = computed(() => {
  const m: Record<string, string> = {}
  const projects = projectModalRef.value?.projects ?? []
  for (const p of projects) m[p.id] = p.name
  return m
})

/** 当前选中设备对象 */
const selectedDevice = computed(() =>
  devices.value.find((d) => d.id === selectedDeviceId.value) ?? null
)

/** ─── 弹窗状态 ─── */
const showInjectModal = ref(false)
const showProjectModal = ref(false)
const showAiModal = ref(false)
const showAgentModal = ref(false)

/** 当前激活的面板 */
const activeTab = ref<'console' | 'element' | 'network' | 'storage' | 'errors' | 'feature' | 'snapshot' | 'exec'>('console')

/** 面板切换时按需启停远程采集器 */
watch([activeTab, selectedDeviceId], () => {
  const id = selectedDeviceId.value
  if (!id) return
  const watchers: string[] = []
  if (activeTab.value === 'storage') watchers.push('storage')
  if (activeTab.value === 'element') watchers.push('dom')
  setWatchers(id, watchers)
})

/** 打开 AI 诊断上下文弹窗 */
function openAiContext() {
  showAiModal.value = true
}

/** 打开接入 Agent 弹窗 */
function openAgent() {
  showAgentModal.value = true
}

/** AuthPage 的验证回调：保存密钥 -> verify -> 返回结果 */
async function verifyAuthKey(key: string): Promise<boolean> {
  saveKey(key)
  const ok = await verifyKey()
  if (!ok) {
    clearKey()
    return false
  }
  /** 超管自动加载项目列表 */
  if (userRole.value === 'admin' && projectModalRef.value) {
    await projectModalRef.value.loadProjects()
  }
  connect()
  return true
}

/** 游客一键登录 */
async function handleGuestLogin(): Promise<boolean> {
  const ok = await guestLogin()
  if (!ok) return false
  connect()
  return true
}

/** 退出登录 */
function logout() {
  clearKey()
  checkAuthStatus()
}

onMounted(async () => {
  await checkAuthStatus()
  /** 已有保存的密钥时，验证角色信息 */
  if (apiKey.value && authStatus.value?.authEnabled) {
    const ok = await verifyKey()
    if (!ok) {
      clearKey()
    } else if (userRole.value === 'admin' && projectModalRef.value) {
      await projectModalRef.value.loadProjects()
    }
  }
  if (!needAuth.value) connect()
})
</script>

<template>
  <!-- 鉴权页面 -->
  <AuthPage
    v-if="needAuth"
    :on-verify="verifyAuthKey"
    :on-guest-login="handleGuestLogin"
    :playground-enabled="authStatus?.playgroundEnabled"
  />

  <!-- 主界面 -->
  <div v-else class="h-screen flex flex-col">
    <!-- 顶部栏 -->
    <header class="bg-gray-900 text-white px-6 py-3 flex items-center gap-4">
      <h1 class="text-lg font-semibold">clarosight</h1>
      <span class="text-xs text-gray-400">远程设备调试控制台</span>
      <!-- 游客模式标识 -->
      <span
        v-if="isPlayground"
        class="px-2 py-0.5 text-xs rounded-full bg-yellow-900/40 text-yellow-400 border border-yellow-700/40"
        title="游客模式 · 数据在公网共享，建议私有化部署"
      >🎮 游客模式 · 建议私有化部署</span>
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
        @click="toggleTheme"
        class="px-2 py-1 text-xs rounded text-gray-300 hover:text-white hover:bg-white/10"
        :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'"
      >{{ theme === 'dark' ? '☀️' : '🌙' }}</button>
      <button
        @click="showInjectModal = true"
        class="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 flex items-center gap-1"
        title="查看三种方式把设备接入到本控制台"
      >➕ 接入新设备</button>
      <button
        v-if="isAdmin"
        @click="showProjectModal = true"
        class="px-3 py-1.5 text-xs font-medium rounded bg-purple-600 text-white hover:bg-purple-700 flex items-center gap-1"
        title="管理项目和密钥"
      >📁 项目管理</button>
      <button
        v-if="authStatus?.authEnabled && apiKey"
        @click="logout"
        class="px-2 py-1 text-xs rounded text-gray-300 hover:text-white hover:bg-white/10"
        title="退出登录"
      >🚪 退出</button>
      <button
        v-if="selectedDevice"
        @click="openAiContext"
        :disabled="showAiModal"
        class="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
      >
        <span v-if="showAiModal">生成中...</span>
        <span v-else>📋 复制诊断上下文</span>
      </button>
      <button
        @click="openAgent"
        class="px-3 py-1.5 text-xs font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 flex items-center gap-1.5"
        title="复制提示词，交给 AI agent 远程调试"
      >🤖 接入 Agent</button>
    </header>

    <div class="flex-1 flex overflow-hidden">
      <DeviceList
        :devices="devices"
        :selected-device-id="selectedDeviceId"
        :is-admin="isAdmin"
        :project-name-map="projectNameMap"
        @select="selectDevice"
      />

      <main class="flex-1 flex flex-col overflow-hidden">
        <template v-if="selectedDeviceId">
          <nav class="flex border-b border-base bg-surface">
            <button
              v-for="tab in (['console', 'element', 'network', 'storage', 'errors', 'feature', 'snapshot', 'exec'] as const)"
              :key="tab"
              @click="activeTab = tab"
              class="px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5"
              :class="activeTab === tab
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-muted hover:text-primary'"
            >
              {{ tab === 'console' ? 'Console' : tab === 'network' ? 'Network' : tab === 'errors' ? 'Errors' : tab === 'snapshot' ? 'Snapshot' : tab === 'exec' ? 'Exec' : tab === 'element' ? 'Element' : tab === 'feature' ? 'Feature' : 'Storage' }}
              <span
                v-if="tab === 'console' && logs.length > 0"
                class="text-xs px-1.5 py-0.5 rounded bg-blue-soft text-secondary"
              >{{ logs.length }}</span>
              <span
                v-else-if="tab === 'network' && network.length > 0"
                class="text-xs px-1.5 py-0.5 rounded bg-blue-soft text-secondary"
              >{{ network.length }}</span>
              <span
                v-else-if="tab === 'errors' && errors.length > 0"
                class="text-xs px-1.5 py-0.5 rounded font-medium"
                :class="activeTab === 'errors' ? 'bg-red-600 text-white' : 'bg-red-100 text-red-600'"
              >{{ errors.length }}</span>
            </button>
          </nav>

          <ConsolePanel v-if="activeTab === 'console'" :logs="logs" :device-id="selectedDeviceId" />
          <NetworkPanel v-else-if="activeTab === 'network'" :network="network" />
          <ErrorsPanel v-else-if="activeTab === 'errors'" :errors="errors" />
          <FeaturePanel v-else-if="activeTab === 'feature'" :device-id="selectedDeviceId" />
          <SnapshotPanel v-else-if="activeTab === 'snapshot'" :device-id="selectedDeviceId" />
          <ElementPanel
            v-else-if="activeTab === 'element'"
            :device-id="selectedDeviceId"
            :dom-change-version="domChangeVersion"
            :dom-change-data="domChangeData"
          />
          <StoragePanel
            v-else-if="activeTab === 'storage'"
            :device-id="selectedDeviceId"
            :storage-version="storageVersion"
            :storage-update-time="storageUpdateTime"
            :storage-key-times="storageKeyTimes"
          />
          <ExecPanel v-else-if="activeTab === 'exec'" :device-id="selectedDeviceId" />
        </template>

        <div v-else class="flex-1 flex items-center justify-center text-faint overflow-y-auto">
          <div class="text-center max-w-lg w-full px-6 py-8">
            <p class="text-sm mb-6">从左侧选择一个设备查看详情</p>
            <div class="bg-surface border border-base rounded-lg p-4 text-left">
              <h3 class="text-sm font-semibold text-primary mb-3">接入新设备</h3>
              <InjectPanel />
            </div>
          </div>
        </div>
      </main>
    </div>

    <div
      v-if="showInjectModal"
      class="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      @click.self="showInjectModal = false"
    >
      <div class="bg-surface rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col">
        <InjectPanel closable @close="showInjectModal = false" />
      </div>
    </div>

    <ProjectModal ref="projectModalRef" v-model="showProjectModal" />

    <AiContextModal
      v-if="selectedDevice"
      v-model="showAiModal"
      :device-id="selectedDevice.id"
      :title="selectedDevice.title"
      :url="selectedDevice.url"
      :errors="errors"
      :network="network"
      :logs="logs"
    />

    <AgentPromptModal
      v-model="showAgentModal"
      :server-url="serverOrigin"
      :api-key="apiKey || ''"
    />
  </div>
</template>
