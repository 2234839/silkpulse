<script setup lang="ts">
/**
 * AgentPromptModal —— 接入 AI Agent 弹窗
 *
 * 提供两种接入方式：
 * 1. 渐进式加载 —— 极短系统提示词（~50 token），agent 按需 curl 拉取完整文档
 * 2. 完整提示词 —— 一键复制所有 API 文档，agent 直接全量加载
 *
 * 提示词模板来自 @silkpulse/shared（服务端 + 控制台共用同一份）。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { copyText } from "../utils/clipboard";
import SecretText from "./SecretText.vue";
import { renderSkillPrompt, renderSkillSystemPrompt } from "@silkpulse/shared";

const props = defineProps<{
  modelValue: boolean;
  /** 当前服务访问地址（如 https://silkpulse.example.com），为空时兜底 location.origin */
  serverUrl: string;
  /** 当前用户的 API key（超管密钥或项目密钥） */
  apiKey: string;
  /** 是否为游客自建项目（临时项目，5 天后销毁） */
  isGuestProject?: boolean;
  /** 游客项目的过期时间（ISO） */
  projectExpiresAt?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const { t } = useI18n();

/** 当前选中的 tab */
type Tab = "full" | "lazy";
const activeTab = ref<Tab>("lazy");

const copyState = ref<"idle" | "copied" | "error">("idle");

/** 兜底服务地址：跟随控制台自身访问地址（自部署场景永远展示用户自己的域名/IP，不能写死线上地址） */
const fallbackOrigin = typeof location !== "undefined" ? location.origin : "";

/** 渲染完整提示词（替换占位符） */
const fullPrompt = computed(() => {
  const key = props.apiKey || t("agentPromptModal.fallbackKey");
  const origin = props.serverUrl || fallbackOrigin;
  return renderSkillPrompt(origin, key);
});

/** 渲染渐进式加载系统提示词 */
const lazyPrompt = computed(() => {
  const key = props.apiKey || t("agentPromptModal.fallbackKey");
  const origin = props.serverUrl || fallbackOrigin;
  return renderSkillSystemPrompt(origin, key);
});

/** 当前 tab 对应的提示词 */
const currentPrompt = computed(() =>
  activeTab.value === "full" ? fullPrompt.value : lazyPrompt.value,
);

async function handleCopy() {
  const ok = await copyText(currentPrompt.value);
  copyState.value = ok ? "copied" : "error";
  if (ok) {
    setTimeout(() => {
      copyState.value = "idle";
    }, 2000);
  }
}

/** 切 tab 时重置复制状态 */
watch(activeTab, () => {
  copyState.value = "idle";
});

/** 弹窗关闭时重置状态 */
watch(
  () => props.modelValue,
  (v) => {
    if (!v) {
      copyState.value = "idle";
      activeTab.value = "lazy";
    }
  },
);
</script>

<template>
  <div
    v-if="modelValue"
    class="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
    @click.self="emit('update:modelValue', false)"
  >
    <div
      class="bg-surface rounded-lg shadow-xl w-full max-w-[760px] mx-4 max-h-[85vh] flex flex-col"
    >
      <!-- 标题栏 -->
      <div class="flex items-center justify-between px-5 py-3 border-b border-base">
        <div>
          <h3 class="text-sm font-semibold text-primary">{{ t("agentPromptModal.title") }}</h3>
          <p class="text-xs text-muted mt-0.5">{{ t("agentPromptModal.subtitle") }}</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="handleCopy"
            class="px-3 py-1.5 text-xs rounded font-medium transition-colors"
            :class="
              copyState === 'copied'
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : copyState === 'error'
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
            "
          >
            {{
              copyState === "copied"
                ? t("common.copied")
                : copyState === "error"
                  ? t("agentPromptModal.copyFailed")
                  : t("agentPromptModal.copyPrompt")
            }}
          </button>
          <button
            @click="emit('update:modelValue', false)"
            class="px-3 py-1.5 text-xs rounded bg-elevated text-secondary hover:bg-elevated-hover"
          >
            {{ t("agentPromptModal.close") }}
          </button>
        </div>
      </div>

      <!-- Tab 切换 -->
      <div class="flex gap-1 px-5 pt-3 border-b border-base">
        <button
          @click="activeTab = 'lazy'"
          class="px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px"
          :class="
            activeTab === 'lazy'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-muted hover:text-secondary'
          "
        >
          {{ t("agentPromptModal.lazyTab") }} <span class="text-muted/60">~50 token</span>
        </button>
        <button
          @click="activeTab = 'full'"
          class="px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px"
          :class="
            activeTab === 'full'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-muted hover:text-secondary'
          "
        >
          {{ t("agentPromptModal.fullTab") }} <span class="text-muted/60">~600 token</span>
        </button>
      </div>

      <!-- 提示词内容 -->
      <div class="flex-1 overflow-y-auto p-5">
        <!-- 游客项目限制提示 -->
        <div
          v-if="isGuestProject"
          class="mb-3 p-3 rounded bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700"
        >
          <p class="text-xs text-yellow-700 dark:text-yellow-300 leading-relaxed">
            {{ t("agentPromptModal.guestNoticePrefix")
            }}{{
              projectExpiresAt
                ? new Date(projectExpiresAt).toLocaleString()
                : t("agentPromptModal.guestExpiresOn")
            }}{{ t("agentPromptModal.guestNoticeMiddle") }}
            <a
              href="https://github.com/2234839/silkpulse"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2"
              >{{ t("agentPromptModal.guestNoticeLink") }}</a
            >
          </p>
        </div>
        <!-- 渐进式加载说明 -->
        <div
          v-if="activeTab === 'lazy'"
          class="mb-3 p-3 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800"
        >
          <p class="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
            {{ t("agentPromptModal.lazyTipPrefix")
            }}<strong>{{ t("agentPromptModal.systemPromptLabel") }}</strong
            >{{ t("agentPromptModal.lazyTipSuffix") }}
          </p>
        </div>
        <!-- 密钥部分模糊化（secret 精确匹配 + auto 正则兜底探测），点击查看明文 -->
        <pre class="text-xs font-mono text-primary whitespace-pre-wrap leading-relaxed"><SecretText
          :text="currentPrompt"
          :secret="apiKey"
          auto
        /></pre>
      </div>

      <!-- 底部提示 -->
      <div class="px-5 py-2.5 border-t border-base bg-elevated/30">
        <p class="text-xs text-muted">
          <template v-if="activeTab === 'lazy'">
            {{ t("agentPromptModal.lazyFooterPrefix") }}
            <code class="text-blue-500">{{ serverUrl }}/api/skill/silkpulse</code
            >{{ t("agentPromptModal.lazyFooterSuffix") }}
          </template>
          <template v-else>
            {{ t("agentPromptModal.fullFooterPrefix") }}
            <code class="text-blue-500">{{ serverUrl }}</code
            >{{ t("agentPromptModal.fullFooterSuffix") }}
          </template>
        </p>
      </div>
    </div>
  </div>
</template>
