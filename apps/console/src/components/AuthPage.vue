<script setup lang="ts">
/**
 * 鉴权登录页
 *
 * 输入超管密钥或项目密钥，验证通过后进入控制台。
 * 游客可一键进入 Playground，也可创建自己的临时项目 Key（最长 5 天）。
 */
import { ref } from "vue";
import { copyText } from "../utils/clipboard";

const emit = defineEmits<{
  /** 验证成功 */
  success: [];
}>();

/** 密钥输入 */
const authKeyInput = ref("");
/** 错误信息 */
const authError = ref("");
/** 加载中 */
const authLoading = ref(false);

/** 由父组件提供验证逻辑（因为 saveKey/verifyKey/connect 都在父级） */
const props = defineProps<{
  /** 父级提供的验证函数，返回 true=成功 */
  onVerify: (key: string) => Promise<boolean>;
  /** 父级提供的游客登录函数 */
  onGuestLogin?: () => Promise<boolean>;
  /** 是否开启了 Playground 游客模式 */
  playgroundEnabled?: boolean;
  /** 游客可否自建项目 Key */
  guestProjectsEnabled?: boolean;
  /** 父级提供的游客自建项目函数，返回创建结果 */
  onGuestCreateProject?: (name?: string) => Promise<{
    apiKey: string;
    projectId: string;
    projectName: string;
    expiresAt?: string;
  } | null>;
}>();

/** GitHub 开源地址 */
const GITHUB_URL = "https://github.com/2234839/silkpulse";

async function submitAuth() {
  if (!authKeyInput.value.trim()) return;
  authLoading.value = true;
  authError.value = "";
  try {
    const ok = await props.onVerify(authKeyInput.value.trim());
    if (!ok) {
      authError.value = "密钥无效或已过期，请检查后重试";
      return;
    }
    authKeyInput.value = "";
    emit("success");
  } catch {
    authError.value = "网络错误，请检查服务器连接";
  } finally {
    authLoading.value = false;
  }
}

async function handleGuestLogin() {
  if (!props.onGuestLogin) return;
  authLoading.value = true;
  authError.value = "";
  try {
    const ok = await props.onGuestLogin();
    if (!ok) {
      authError.value = "游客模式暂不可用，请稍后重试";
      return;
    }
    emit("success");
  } catch {
    authError.value = "网络错误，请检查服务器连接";
  } finally {
    authLoading.value = false;
  }
}

/** ── 游客自建项目 Key ── */
/** 自定义项目名（可选） */
const guestNameInput = ref("");
/** 创建结果（一次性展示） */
const guestResult = ref<{
  apiKey: string;
  projectId: string;
  projectName: string;
  expiresAt?: string;
} | null>(null);
/** 复制状态 */
const guestCopied = ref(false);

/** 已复制并进入控制台：把 Key 存起来登录（复用 onVerify） */
async function guestEnterConsole() {
  if (!guestResult.value || !guestCopied.value) return;
  const ok = await props.onVerify(guestResult.value.apiKey);
  if (ok) {
    guestResult.value = null;
    emit("success");
  } else {
    authError.value = "创建成功但登录失败，请把密钥粘贴到上方登录框重试";
  }
}

async function handleGuestCreate() {
  if (!props.onGuestCreateProject || authLoading.value) return;
  authLoading.value = true;
  authError.value = "";
  try {
    const result = await props.onGuestCreateProject(guestNameInput.value);
    if (!result) {
      authError.value = "创建失败（可能太频繁，每小时最多 5 个）";
      return;
    }
    guestResult.value = result;
    guestCopied.value = false;
  } catch {
    authError.value = "网络错误，请检查服务器连接";
  } finally {
    authLoading.value = false;
  }
}

async function handleGuestCopy() {
  if (!guestResult.value) return;
  const ok = await copyText(guestResult.value.apiKey);
  if (ok) guestCopied.value = true;
}

/** 到期时间格式化 */
function fmtExpires(iso?: string): string {
  if (!iso) return "5 天后";
  return new Date(iso).toLocaleString();
}
</script>

<template>
  <div class="min-h-screen flex flex-col-reverse lg:flex-row bg-gray-900 text-white">
    <!-- 左侧：产品自述（窄屏时排在登录区下方） -->
    <div
      class="flex-1 flex flex-col justify-center px-6 py-10 sm:px-10 lg:px-16 lg:py-0 lg:max-w-[55%]"
    >
      <div class="max-w-xl mx-auto lg:mx-0">
        <!-- Logo + 品牌名 -->
        <div class="flex items-center gap-3 mb-8">
          <div
            class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-xl shadow-lg shadow-blue-500/30"
          >
            🩺
          </div>
          <span class="text-2xl font-bold tracking-tight">SilkPulse</span>
          <span
            class="px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/20"
            >悬丝诊脉</span
          >
        </div>

        <!-- 一句话定位 -->
        <h1 class="text-2xl sm:text-3xl lg:text-4xl font-bold leading-tight mb-3">
          AI 原生的<br class="hidden sm:block" />远程设备调试器
        </h1>
        <p class="text-gray-400 text-sm sm:text-base leading-relaxed mb-8">
          测试同学报「测试机上白屏」「手机上打不开」时，开发者无法用本地 DevTools
          调试远在别处的设备。 SilkPulse 让 AI
          直接接入远程页面——看结构、读日志、执行诊断、操作元素，完成「远程诊断→操作→验证」闭环。
        </p>

        <!-- 核心能力卡片 -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
          <div class="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <div class="text-lg mb-1.5">🔍</div>
            <h3 class="font-semibold text-sm mb-1">远程透视</h3>
            <p class="text-gray-500 text-xs leading-relaxed">
              console / 网络 / 错误 / DOM 快照，穿透 shadow DOM + iframe
            </p>
          </div>
          <div class="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <div class="text-lg mb-1.5">🤖</div>
            <h3 class="font-semibold text-sm mb-1">AI 操作</h3>
            <p class="text-gray-500 text-xs leading-relaxed">
              AI 直接在远程页面点击、输入、滚动、截图，像人类一样操作
            </p>
          </div>
          <div class="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <div class="text-lg mb-1.5">📡</div>
            <h3 class="font-semibold text-sm mb-1">多设备并发</h3>
            <p class="text-gray-500 text-xs leading-relaxed">
              同时调试多台设备，断线重连不丢历史，环形缓冲区兜底
            </p>
          </div>
          <div class="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <div class="text-lg mb-1.5">🧩</div>
            <h3 class="font-semibold text-sm mb-1">零侵入接入</h3>
            <p class="text-gray-500 text-xs leading-relaxed">
              script 标签 / bookmarklet / userscript，不改源码也能接入
            </p>
          </div>
        </div>

        <!-- 底部链接 -->
        <div class="flex items-center gap-4 text-xs text-gray-600 flex-wrap">
          <a
            :href="GITHUB_URL"
            target="_blank"
            rel="noopener noreferrer"
            class="text-gray-400 hover:text-white transition-colors flex items-center gap-1"
            title="GitHub 开源地址，觉得有用求个 Star ⭐"
            >⭐ GitHub</a
          >
          <span class="text-gray-700">·</span>
          <router-link
            to="/blog"
            class="text-orange-400/80 hover:text-orange-400 transition-colors flex items-center gap-1"
            >📝 Blog</router-link
          >
          <span class="text-gray-700">·</span>
          <span>Script 标签</span>
          <span class="text-gray-700">·</span>
          <span>Bookmarklet</span>
          <span class="text-gray-700">·</span>
          <span>Userscript</span>
          <span class="text-gray-700">·</span>
          <span>Skill API</span>
        </div>
      </div>
    </div>

    <!-- 右侧：登录区域（窄屏时置顶） -->
    <div
      class="flex-1 flex items-center justify-center px-6 py-8 sm:px-10 lg:py-0 lg:max-w-[45%] bg-gray-950/50 border-b lg:border-b-0 lg:border-l border-gray-800"
    >
      <div class="w-full max-w-sm space-y-6">
        <div class="text-center lg:text-left">
          <h2 class="text-xl font-bold mb-1">登录控制台</h2>
          <p class="text-gray-500 text-sm">输入密钥以访问远程设备</p>
        </div>

        <div class="space-y-3">
          <input
            v-model="authKeyInput"
            type="password"
            placeholder="超管密钥或项目密钥"
            class="w-full px-4 py-3 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 focus:outline-none text-sm"
            @keydown.enter="submitAuth"
            :disabled="authLoading"
          />
          <button
            @click="submitAuth"
            :disabled="authLoading || !authKeyInput.trim()"
            class="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg font-medium text-sm transition"
          >
            {{ authLoading ? "验证中..." : "登录" }}
          </button>
          <p v-if="authError" class="text-red-400 text-sm text-center">{{ authError }}</p>

          <!-- 游客访问按钮 -->
          <div v-if="playgroundEnabled" class="pt-2">
            <div class="flex items-center gap-3 mb-3">
              <div class="flex-1 h-px bg-gray-700"></div>
              <span class="text-xs text-gray-500">或</span>
              <div class="flex-1 h-px bg-gray-700"></div>
            </div>
            <button
              @click="handleGuestLogin"
              :disabled="authLoading"
              class="w-full px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-gray-500 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition flex items-center justify-center gap-2"
            >
              <span>🎮</span>
              <span>游客访问 Playground</span>
            </button>
          </div>

          <!-- 游客自建项目 Key -->
          <div v-if="guestProjectsEnabled" class="pt-4">
            <div class="flex items-center gap-3 mb-3">
              <div class="flex-1 h-px bg-gray-700"></div>
              <span class="text-xs text-gray-500">游客进阶</span>
              <div class="flex-1 h-px bg-gray-700"></div>
            </div>

            <!-- 创建表单 -->
            <div v-if="!guestResult" class="space-y-2">
              <p class="text-xs text-gray-500 leading-relaxed">
                创建一个<span class="text-gray-300">只属于你</span>的临时项目 Key，设备互相隔离。
                <span class="text-yellow-500">最长存活 5 天</span>，到期自动销毁。
              </p>
              <div class="flex gap-2">
                <input
                  v-model="guestNameInput"
                  placeholder="项目名称（可选）"
                  maxlength="30"
                  class="flex-1 px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 focus:outline-none text-sm"
                  @keydown.enter="handleGuestCreate"
                  :disabled="authLoading"
                />
                <button
                  @click="handleGuestCreate"
                  :disabled="authLoading"
                  class="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition whitespace-nowrap"
                >
                  {{ authLoading ? "创建中..." : "🔑 创建我的 Key" }}
                </button>
              </div>
            </div>

            <!-- 一次性展示密钥 -->
            <div v-else class="space-y-3">
              <div class="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-3 space-y-2">
                <p class="text-xs text-yellow-400 font-semibold">
                  ⚠️ 这是你的项目密钥，仅展示这一次，请立即复制保存！
                </p>
                <p class="text-xs text-yellow-500/70 leading-relaxed">
                  关闭此页后将无法再查看（服务器只存哈希）。丢了只能重新创建。
                </p>
                <code
                  class="block px-2 py-1.5 text-xs bg-gray-900 rounded font-mono break-all text-green-400 select-all"
                  >{{ guestResult.apiKey }}</code
                >
                <div class="flex gap-2">
                  <button
                    @click="handleGuestCopy"
                    :class="
                      guestCopied
                        ? 'bg-green-700 hover:bg-green-700 text-white'
                        : 'bg-blue-600 hover:bg-blue-700 text-white'
                    "
                    class="flex-1 px-3 py-1.5 rounded font-medium text-xs transition"
                  >
                    {{ guestCopied ? "✓ 已复制" : "📋 复制密钥" }}
                  </button>
                  <button
                    @click="guestEnterConsole"
                    :disabled="!guestCopied"
                    :title="guestCopied ? '用这个 Key 进入控制台' : '请先复制密钥'"
                    class="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded font-medium text-xs transition"
                  >
                    🚀 进入控制台
                  </button>
                </div>
              </div>
              <p class="text-[11px] text-gray-500">
                项目「{{ guestResult.projectName }}」·
                {{ fmtExpires(guestResult.expiresAt) }}自动销毁 · Project ID:
                <code class="text-gray-400">{{ guestResult.projectId }}</code>
              </p>
            </div>
          </div>
        </div>

        <div class="pt-4 space-y-2">
          <p class="text-xs text-gray-500 leading-relaxed">
            <span class="text-gray-400">超管密钥</span>可查看所有项目和设备<br />
            <span class="text-gray-400">项目密钥</span>只能查看对应项目的设备
          </p>
          <p class="text-xs text-gray-600">密钥安全存储在浏览器本地</p>
        </div>

        <!-- 游客模式提示 -->
        <div
          v-if="playgroundEnabled || guestProjectsEnabled"
          class="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-3"
        >
          <p class="text-xs text-yellow-400/80 leading-relaxed">
            🎮 以上是对游客的限制：数据在公网传输、项目最长存活 5 天、到期自动销毁<br />
            <a
              :href="GITHUB_URL"
              target="_blank"
              rel="noopener noreferrer"
              class="text-yellow-600 hover:text-yellow-500 underline underline-offset-2"
              >有长期需要建议自己部署一份（开源免费，顺手求个 ⭐）</a
            >
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
