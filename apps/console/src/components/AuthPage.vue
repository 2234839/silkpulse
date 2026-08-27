<script setup lang="ts">
/**
 * 鉴权登录页
 *
 * 输入超管密钥或项目密钥，验证通过后进入控制台。
 */
import { ref } from "vue";
import { getBuildInfo } from "../utils/buildInfo";

const emit = defineEmits<{
  /** 验证成功 */
  success: [];
}>();

/** 构建信息（git 哈希/分支/构建时间，构建期注入） */
const buildInfo = getBuildInfo();

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
}>();

async function submitAuth() {
  if (!authKeyInput.value.trim()) return;
  authLoading.value = true;
  authError.value = "";
  try {
    const ok = await props.onVerify(authKeyInput.value.trim());
    if (!ok) {
      authError.value = "密钥无效，请检查后重试";
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
</script>

<template>
  <div class="min-h-screen flex flex-col lg:flex-row bg-gray-900 text-white">
    <!-- 左侧：产品自述 -->
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

    <!-- 右侧：登录区域 -->
    <div
      class="flex-1 flex items-center justify-center px-6 py-10 sm:px-10 lg:py-0 lg:max-w-[45%] bg-gray-950/50 border-t lg:border-t-0 lg:border-l border-gray-800"
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
              <span>游客访问</span>
            </button>
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
          v-if="playgroundEnabled"
          class="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-3"
        >
          <p class="text-xs text-yellow-400/80 leading-relaxed">
            🎮 游客模式仅可查看公开设备，数据在公网共享<br />
            <span class="text-yellow-600">建议私有化部署以保护隐私</span>
          </p>
        </div>

        <!-- 版本信息行：构建期注入的 git 哈希 + 时间，用于核对线上部署版本 -->
        <p class="pt-2 text-[11px] text-gray-700 text-center select-text font-mono">
          v-{{ buildInfo.commit.slice(0, 7) }}{{ buildInfo.dirty ? "+dirty" : "" }} ·
          {{ new Date(buildInfo.buildAt).toLocaleString() }}
        </p>
      </div>
    </div>
  </div>
</template>
