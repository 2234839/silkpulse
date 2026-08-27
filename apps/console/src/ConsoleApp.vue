<script setup lang="ts">
/**
 * silkpulse 控制台主组件
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
import { ref, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useConsoleSocket } from "./composables/useConsoleSocket";
import { useAuth } from "./composables/useAuth";
import { useTheme } from "./composables/useTheme";
import AuthPage from "./components/AuthPage.vue";
import DeviceList from "./components/DeviceList.vue";
import InjectPanel from "./components/InjectPanel.vue";
import ProjectModal from "./components/ProjectModal.vue";
import AiContextModal from "./components/AiContextModal.vue";
import AgentPromptModal from "./components/AgentPromptModal.vue";
import SnapshotPanel from "./components/SnapshotPanel.vue";
import FeaturePanel from "./components/FeaturePanel.vue";
import ErrorsPanel from "./components/ErrorsPanel.vue";
import ConsolePanel from "./components/ConsolePanel.vue";
import NetworkPanel from "./components/NetworkPanel.vue";
import ExecPanel from "./components/ExecPanel.vue";
import ElementPanel from "./components/ElementPanel.vue";
import StoragePanel from "./components/StoragePanel.vue";
import DevToolsPanel from "./components/DevToolsPanel.vue";
import { useResizable } from "./composables/useResizable";

const { theme, toggleTheme } = useTheme();

/** 设备列表宽度可拖拽 */
const { width: sidebarWidth, onDragStart: onSidebarResize } = useResizable({
  initial: 288,
  min: 200,
  max: 500,
  direction: "right",
  storageKey: "silkpulse.sidebar-width",
});

const {
  devices,
  logs,
  network,
  errors,
  droppedCounts,
  storageVersion,
  storageUpdateTime,
  storageKeyTimes,
  domChangeVersion,
  domChangeData,
  screenFrame,
  screenShareStatus,
  deviceMouse,
  sendConsoleMessage,
  requestNetworkBody,
  onDevtoolsRelay,
  sendDevtoolsRelay,
  onDeviceReconnect,
  selectedDeviceId,
  connected,
  connect,
  selectDevice,
  setWatchers,
} = useConsoleSocket();

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
} = useAuth();

/** 是否超管 */
const isAdmin = computed(() => userRole.value === "admin");

/** 当前页面 origin（供 AgentPromptModal 使用，避免模板里直接访问 location） */
const serverOrigin = typeof location !== "undefined" ? location.origin : "";

/** 是否需要显示鉴权页面 */
const needAuth = computed(() => {
  if (!authStatus.value) return false;
  if (!authStatus.value.authEnabled) return false;
  return !isAuthenticated();
});

/** ProjectModal 引用（用于读取项目列表做设备列表映射） */
const projectModalRef = ref<InstanceType<typeof ProjectModal> | null>(null);
/** projectId → 项目名映射 */
const projectNameMap = computed(() => {
  const m: Record<string, string> = {};
  const projects = projectModalRef.value?.projects ?? [];
  for (const p of projects) m[p.id] = p.name;
  return m;
});

/** 当前选中设备对象 */
const selectedDevice = computed(
  () => devices.value.find((d) => d.id === selectedDeviceId.value) ?? null,
);

/** ─── 弹窗状态 ─── */
const showInjectModal = ref(false);
const showProjectModal = ref(false);
const showAiModal = ref(false);
const showAgentModal = ref(false);

/**
 * 弹窗互斥：任意一个弹窗打开时关闭其余弹窗
 *
 * 避免双重遮罩叠开（如 AI 上下文开着时再点 Agent，两个模态叠在一起）。
 */
watch([showInjectModal, showProjectModal, showAiModal, showAgentModal], (vals) => {
  const flags = [showInjectModal, showProjectModal, showAiModal, showAgentModal];
  /** 找到刚变为 true 的那个（最多一个），关闭其余 */
  const idx = vals.lastIndexOf(true);
  if (idx === -1) return;
  for (const [i, f] of flags.entries()) {
    if (i !== idx && f.value) f.value = false;
  }
});

/** 移动端 sidebar drawer 开关（窄屏下设备列表以抽屉式展开） */
const sidebarOpen = ref(false);

/** 移动端 header 更多菜单开关 */
const headerMenuOpen = ref(false);

/** 选中设备时自动关闭 sidebar drawer（移动端） */
watch(selectedDeviceId, () => {
  sidebarOpen.value = false;
});

const route = useRoute();
const router = useRouter();

/** 所有合法的 tab id，用于校验 URL query */
const validTabs = [
  "console",
  "element",
  "network",
  "storage",
  "errors",
  "feature",
  "snapshot",
  "exec",
  "devtools",
] as const;

/** 当前激活的面板 —— 初始值从 URL ?tab= 读取，支持复制链接直达 */
const activeTab = ref<(typeof validTabs)[number]>(
  (validTabs as readonly string[]).includes(route.query.tab as string)
    ? (route.query.tab as (typeof validTabs)[number])
    : "console",
);

/** URL → activeTab：外部导航（前进/后退/粘贴链接）时同步 */
watch(
  () => route.query.tab,
  (val) => {
    if (typeof val === "string" && (validTabs as readonly string[]).includes(val)) {
      activeTab.value = val as (typeof validTabs)[number];
    } else if (!val) {
      activeTab.value = "console";
    }
  },
);

/** activeTab → URL：点击切换时用 replace 不污染历史栈 */
watch(activeTab, (val) => {
  if (route.query.tab !== val) {
    router.replace({ query: { ...route.query, tab: val } });
  }
});

/** 面板切换时按需启停远程采集器 */
watch([activeTab, selectedDeviceId], () => {
  const id = selectedDeviceId.value;
  if (!id) return;
  const watchers: string[] = [];
  if (activeTab.value === "storage") watchers.push("storage");
  if (activeTab.value === "element") watchers.push("dom");
  setWatchers(id, watchers);
});

/** 打开 AI 诊断上下文弹窗 */
function openAiContext() {
  showAiModal.value = true;
}

/** 打开接入 Agent 弹窗 */
function openAgent() {
  showAgentModal.value = true;
}

/** AuthPage 的验证回调：先 verify 后保存——验证期间不动 apiKey，避免 needAuth 抖动导致 AuthPage 重挂（错误提示丢失） */
async function verifyAuthKey(key: string): Promise<boolean> {
  const ok = await verifyKey(key);
  if (!ok) return false;
  saveKey(key);
  /** 超管自动加载项目列表 */
  if (userRole.value === "admin" && projectModalRef.value) {
    await projectModalRef.value.loadProjects();
  }
  connect();
  return true;
}

/** 游客一键登录 */
async function handleGuestLogin(): Promise<boolean> {
  const ok = await guestLogin();
  if (!ok) return false;
  connect();
  return true;
}

/** 退出登录 */
function logout() {
  clearKey();
  checkAuthStatus();
}

onMounted(async () => {
  await checkAuthStatus();
  /** 已有保存的密钥时，验证角色信息 */
  if (apiKey.value && authStatus.value?.authEnabled) {
    const ok = await verifyKey();
    if (!ok) {
      clearKey();
    } else if (userRole.value === "admin" && projectModalRef.value) {
      await projectModalRef.value.loadProjects();
    }
  }
  if (!needAuth.value) connect();
});
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
    <header
      class="bg-gray-900 text-white px-3 sm:px-6 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-4 flex-wrap border-b border-white/10 shadow-sm"
    >
      <!-- 移动端：汉堡菜单按钮（打开设备列表 drawer） -->
      <button
        class="md:hidden p-1.5 rounded text-gray-300 hover:text-white hover:bg-white/10 flex-shrink-0"
        @click="sidebarOpen = true"
        title="打开设备列表"
      >
        ☰
      </button>
      <h1 class="text-base sm:text-lg font-semibold flex-shrink-0">silkpulse</h1>
      <!-- 副标题：窄屏隐藏 -->
      <span class="hidden lg:inline text-xs text-gray-400">远程设备调试控制台</span>
      <!-- 游客模式标识 -->
      <span
        v-if="isPlayground"
        class="px-2 py-0.5 text-xs rounded-full bg-yellow-900/40 text-yellow-400 border border-yellow-700/40"
        title="游客模式 · 数据在公网共享，建议私有化部署"
        >🎮 游客</span
      >
      <span
        class="ml-auto flex items-center gap-1.5 text-xs flex-shrink-0"
        :class="connected ? 'text-green-400' : 'text-red-400'"
      >
        <span
          class="w-2 h-2 rounded-full flex-shrink-0"
          :class="connected ? 'bg-green-400' : 'bg-red-400'"
        />
        <span class="hidden sm:inline">{{ connected ? "已连接" : "断开中" }}</span>
      </span>

      <!-- 桌面端：所有按钮平铺 -->
      <div class="hidden md:flex items-center gap-2">
        <button
          @click="toggleTheme"
          class="px-2 py-1 text-xs rounded text-gray-300 hover:text-white hover:bg-white/10"
          :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'"
        >
          {{ theme === "dark" ? "☀️" : "🌙" }}
        </button>
        <button
          @click="showInjectModal = true"
          class="px-3 py-1.5 text-xs font-medium rounded-lg bg-green-600 text-white hover:bg-green-500 shadow-sm shadow-green-900/40 transition-colors flex items-center gap-1"
          title="查看三种方式把设备接入到本控制台"
        >
          ➕ 接入新设备
        </button>
        <button
          v-if="isAdmin"
          @click="showProjectModal = true"
          class="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/10 text-gray-100 hover:bg-white/20 transition-colors flex items-center gap-1"
          title="管理项目和密钥"
        >
          📁 项目管理
        </button>
        <button
          v-if="selectedDevice"
          @click="openAiContext"
          :disabled="showAiModal"
          class="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/10 text-gray-100 hover:bg-white/20 disabled:opacity-50 transition-colors flex items-center gap-1.5"
        >
          <span v-if="showAiModal">生成中...</span>
          <span v-else>📋 诊断上下文</span>
        </button>
        <router-link
          to="/tools"
          class="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/10 text-gray-100 hover:bg-white/20 transition-colors flex items-center gap-1.5"
          title="Web Debug 工具箱（不需要选中设备）"
          >🔧 工具箱</router-link
        >
        <router-link
          to="/blog"
          class="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/10 text-gray-100 hover:bg-white/20 transition-colors flex items-center gap-1.5"
          title="silkpulse blog —— 项目动态与技术文章"
          >📝 Blog</router-link
        >
        <button
          @click="openAgent"
          class="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-900/40 transition-colors flex items-center gap-1.5"
          title="复制提示词，交给 AI agent 远程调试"
        >
          🤖 Agent
        </button>
        <button
          v-if="authStatus?.authEnabled && apiKey"
          @click="logout"
          class="px-2 py-1 text-xs rounded text-gray-300 hover:text-white hover:bg-white/10"
          title="退出登录"
        >
          🚪
        </button>
      </div>

      <!-- 移动端：折叠菜单 -->
      <div class="md:hidden relative flex-shrink-0">
        <button
          @click="headerMenuOpen = !headerMenuOpen"
          class="p-1.5 rounded text-gray-300 hover:text-white hover:bg-white/10"
        >
          ⚙️
        </button>
        <!-- 外部点击关闭遮罩 -->
        <div v-if="headerMenuOpen" class="fixed inset-0 z-40" @click="headerMenuOpen = false" />
        <div
          v-if="headerMenuOpen"
          class="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px] z-50"
          @click="headerMenuOpen = false"
        >
          <button
            @click="toggleTheme"
            class="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 rounded-md transition-colors"
          >
            {{ theme === "dark" ? "☀️ 亮色" : "🌙 暗色" }}
          </button>
          <button
            @click="showInjectModal = true"
            class="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 rounded-md transition-colors"
          >
            ➕ 接入新设备
          </button>
          <button
            v-if="isAdmin"
            @click="showProjectModal = true"
            class="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 rounded-md transition-colors"
          >
            📁 项目管理
          </button>
          <button
            v-if="selectedDevice"
            @click="openAiContext"
            :disabled="showAiModal"
            class="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 rounded-md transition-colors disabled:opacity-50"
          >
            📋 诊断上下文
          </button>
          <router-link
            to="/tools"
            @click="headerMenuOpen = false"
            class="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 rounded-md transition-colors block"
            >🔧 工具箱</router-link
          >
          <router-link
            to="/blog"
            @click="headerMenuOpen = false"
            class="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 rounded-md transition-colors block"
            >📝 Blog</router-link
          >
          <button
            @click="openAgent"
            class="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 rounded-md transition-colors"
          >
            🤖 接入 Agent
          </button>
          <button
            v-if="authStatus?.authEnabled && apiKey"
            @click="logout"
            class="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 rounded-md transition-colors"
          >
            🚪 退出
          </button>
        </div>
      </div>
    </header>

    <div class="flex-1 flex overflow-hidden relative">
      <!-- 移动端 sidebar 遮罩（不覆盖 header） -->
      <div
        v-if="sidebarOpen"
        class="md:hidden absolute inset-0 bg-black/50 z-30"
        @click="sidebarOpen = false"
      />
      <!-- DeviceList：桌面端固定显示，移动端 drawer -->
      <div
        class="flex-shrink-0 md:flex static md:relative z-40 h-full"
        :class="sidebarOpen ? 'flex' : 'hidden md:flex'"
        :style="{ width: sidebarOpen ? undefined : sidebarWidth + 'px' }"
      >
        <DeviceList
          :devices="devices"
          :selected-device-id="selectedDeviceId"
          :is-admin="isAdmin"
          :project-name-map="projectNameMap"
          :class="sidebarOpen ? 'fixed md:static inset-y-0 left-0 shadow-2xl' : ''"
          @select="selectDevice"
        />
      </div>
      <!-- 拖拽手柄：桌面端显示 -->
      <div
        class="hidden md:flex w-1 cursor-col-resize bg-base hover:bg-blue-400/40 active:bg-blue-500 transition-colors flex-shrink-0"
        @mousedown="onSidebarResize"
      />

      <main class="flex-1 flex flex-col overflow-hidden">
        <template v-if="selectedDeviceId">
          <nav class="flex border-b border-base bg-surface overflow-x-auto no-scrollbar">
            <button
              v-for="tab in [
                'console',
                'element',
                'network',
                'storage',
                'errors',
                'feature',
                'snapshot',
                'exec',
                'devtools',
              ] as const"
              :key="tab"
              @click="activeTab = tab"
              class="px-4 py-2.5 text-sm font-medium border-b-2 flex items-center gap-1.5 transition-colors"
              :class="
                activeTab === tab
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-muted hover:text-primary hover:bg-elevated'
              "
            >
              {{
                tab === "console"
                  ? "Console"
                  : tab === "network"
                    ? "Network"
                    : tab === "errors"
                      ? "Errors"
                      : tab === "snapshot"
                        ? "Snapshot"
                        : tab === "exec"
                          ? "Exec"
                          : tab === "element"
                            ? "Element"
                            : tab === "feature"
                              ? "Feature"
                              : tab === "devtools"
                                ? "DevTools"
                                : "Storage"
              }}
              <span
                v-if="tab === 'console' && logs.length > 0"
                class="text-xs px-1.5 py-0.5 rounded bg-blue-soft text-secondary"
                >{{ logs.length }}</span
              >
              <span
                v-else-if="tab === 'network' && network.length > 0"
                class="text-xs px-1.5 py-0.5 rounded bg-blue-soft text-secondary"
                >{{ network.length }}</span
              >
              <span
                v-else-if="tab === 'errors' && errors.length > 0"
                class="text-xs px-1.5 py-0.5 rounded font-medium"
                :class="
                  activeTab === 'errors' ? 'bg-red-600 text-white' : 'bg-red-100 text-red-600'
                "
                >{{ errors.length }}</span
              >
            </button>
          </nav>

          <ConsolePanel
            v-if="activeTab === 'console'"
            :logs="logs"
            :device-id="selectedDeviceId"
            :dropped-count="droppedCounts.logs"
          />
          <NetworkPanel
            v-else-if="activeTab === 'network'"
            :network="network"
            :device-id="selectedDeviceId"
            :request-body="requestNetworkBody"
            :dropped-count="droppedCounts.network"
          />
          <ErrorsPanel
            v-else-if="activeTab === 'errors'"
            :errors="errors"
            :dropped-count="droppedCounts.errors"
          />
          <FeaturePanel v-else-if="activeTab === 'feature'" :device-id="selectedDeviceId" />
          <SnapshotPanel v-else-if="activeTab === 'snapshot'" :device-id="selectedDeviceId" />
          <ElementPanel
            v-else-if="activeTab === 'element'"
            :device-id="selectedDeviceId"
            :dom-change-version="domChangeVersion"
            :dom-change-data="domChangeData"
            :screen-frame="screenFrame"
            :screen-share-status="screenShareStatus"
            :device-mouse="deviceMouse"
            :send-console-message="sendConsoleMessage"
          />
          <StoragePanel
            v-else-if="activeTab === 'storage'"
            :device-id="selectedDeviceId"
            :storage-version="storageVersion"
            :storage-update-time="storageUpdateTime"
            :storage-key-times="storageKeyTimes"
          />
          <ExecPanel v-else-if="activeTab === 'exec'" :device-id="selectedDeviceId" />
          <DevToolsPanel
            v-else-if="activeTab === 'devtools'"
            :device-id="selectedDeviceId"
            :frameworks="selectedDevice?.frameworks"
            :on-relay="onDevtoolsRelay"
            :on-reconnect="onDeviceReconnect"
            :send="sendDevtoolsRelay"
          />
        </template>

        <div v-else class="flex-1 flex items-center justify-center text-faint overflow-y-auto">
          <div class="text-center max-w-lg w-full px-6 py-8">
            <!-- 空态主视觉：柔和渐变圆底 + 图标 -->
            <div
              class="mx-auto mb-5 w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500/15 to-indigo-500/10 border border-blue-500/20 flex items-center justify-center text-3xl"
            >
              🩺
            </div>
            <p class="text-sm font-medium text-secondary mb-1">从左侧选择一个设备查看详情</p>
            <p class="text-xs text-faint mb-6">
              设备接入后，日志 / 网络 / DOM 将实时出现在对应面板
            </p>
            <div class="bg-surface border border-base rounded-xl p-4 text-left shadow-sm">
              <h3 class="text-sm font-semibold text-primary mb-3 flex items-center gap-1.5">
                <span
                  class="w-5 h-5 rounded-md bg-green-500/15 text-green-600 dark:text-green-400 flex items-center justify-center text-xs"
                  >➕</span
                >
                接入新设备
              </h3>
              <InjectPanel />
            </div>
          </div>
        </div>
      </main>
    </div>

    <div
      v-if="showInjectModal"
      class="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      @click.self="showInjectModal = false"
    >
      <div
        class="bg-surface rounded-2xl shadow-2xl ring-1 ring-black/10 w-full max-w-[560px] mx-4 max-h-[80vh] flex flex-col overflow-hidden"
      >
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

    <AgentPromptModal v-model="showAgentModal" :server-url="serverOrigin" :api-key="apiKey || ''" />
  </div>
</template>
