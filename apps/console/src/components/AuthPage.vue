<script setup lang="ts">
/**
 * 鉴权登录页
 *
 * 输入超管密钥或项目密钥，验证通过后进入控制台。
 * 游客可一键进入 Playground，也可创建自己的临时项目 Key（最长 5 天）。
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { copyText } from "../utils/clipboard";
import { locales } from "../i18n";
import { useLocale } from "../composables/useLocale";

const { t, locale } = useI18n();
const { setLocale } = useLocale();

/** 语言菜单展开状态（点击外部关闭） */
const langMenuOpen = ref(false);

/** 各语言的自我显示名（语言名用本语言书写是惯例，不走消息包） */
const LANG_LABELS: Record<"en" | "zh", string> = {
  en: "English",
  zh: "简体中文", // i18n-allowed
};

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
      authError.value = t("auth.invalidKey");
      return;
    }
    authKeyInput.value = "";
    emit("success");
  } catch {
    authError.value = t("common.networkError");
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
      authError.value = t("auth.guestUnavailable");
      return;
    }
    emit("success");
  } catch {
    authError.value = t("common.networkError");
  } finally {
    authLoading.value = false;
  }
}

/** ── 游客自建项目 Key ── */
/** 各语言随机项目名词库：形容词 + 名词 + 4 位尾缀，好记不撞车 */
const NAME_POOLS: Record<"en" | "zh", { adjectives: string[]; nouns: string[] }> = {
  en: {
    adjectives: [
      "Happy",
      "Quiet",
      "Flashy",
      "Wavy",
      "Cloudy",
      "Meteoric",
      "Lemony",
      "Piney",
      "Dolphin",
      "Sunset",
    ],
    nouns: [
      "Puppy",
      "Lighthouse",
      "Tangerine",
      "Glacier",
      "Firefly",
      "Letter",
      "Windchime",
      "Seashell",
      "Mist",
      "Mountain",
    ],
  },
  zh: {
    adjectives: ["快乐", "安静", "闪也", "波涛", "云朵", "流星", "柠檬", "松果", "海豚", "晚霞"], // i18n-allowed: 中文词库
    nouns: ["小狗", "灯塔", "橘子", "冰川", "萤火", "信笺", "风铃", "拾贝", "晨雾", "远山"], // i18n-allowed: 中文词库
  },
};

/** 随机项目名：取当前语言的词库，形容词 + 名词 + 4 位尾缀 */
function randomProjectName(): string {
  const pools = locale.value === "zh" ? NAME_POOLS.zh : NAME_POOLS.en;
  const tail = Math.random().toString(36).slice(2, 6);
  const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(pools.adjectives)}${pick(pools.nouns)}-${tail}`;
}
/** 自定义项目名（可选，默认预填随机名，可一键换） */
const guestNameInput = ref(randomProjectName());
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
  if (!guestResult.value) return;
  /** 先写一次性标记再触发登录：登录内部会翻转鉴权状态，控制台在 onVerify 成功后读取该标记弹窗重展密钥 */
  try {
    sessionStorage.setItem("silkpulse-new-key", guestResult.value.apiKey);
  } catch {
    /* 无 sessionStorage 时跳过弹窗重展 */
  }
  const ok = await props.onVerify(guestResult.value.apiKey);
  if (ok) {
    guestResult.value = null;
    emit("success");
  } else {
    authError.value = t("auth.createdButLoginFailed");
  }
}

async function handleGuestCreate() {
  if (!props.onGuestCreateProject || authLoading.value) return;
  authLoading.value = true;
  authError.value = "";
  try {
    const result = await props.onGuestCreateProject(guestNameInput.value);
    if (!result) {
      authError.value = t("auth.createFailed");
      return;
    }
    guestResult.value = result;
    /** 自动把密钥复制到剪贴板，避免用户漏存；失败才需要手动点复制 */
    const autoCopied = await copyText(result.apiKey);
    guestCopied.value = autoCopied;
    /** 创建即进控制台：密钥已在剪贴板，控制台内还会弹窗再展一次 */
    await guestEnterConsole();
  } catch {
    authError.value = t("common.networkError");
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
  if (!iso) return t("auth.expiresDefault");
  return new Date(iso).toLocaleString();
}
</script>

<template>
  <div class="min-h-screen flex flex-col-reverse lg:flex-row bg-gray-900 text-white relative">
    <!-- 语言切换（右上角） -->
    <div class="absolute top-3 right-3 z-20">
      <button
        @click="langMenuOpen = !langMenuOpen"
        class="px-2.5 py-1.5 text-xs rounded-lg text-gray-400 hover:text-white hover:bg-white/10 border border-gray-700 transition"
      >
        🌐 {{ t("shell.language") }}
      </button>
      <div
        v-if="langMenuOpen"
        class="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[120px] z-50"
      >
        <button
          v-for="lang in locales"
          :key="lang"
          @click="
            setLocale(lang);
            langMenuOpen = false;
          "
          class="w-full text-left px-3 py-2 text-xs transition"
          :class="locale === lang ? 'text-blue-400 font-medium' : 'text-gray-300 hover:bg-white/10'"
        >
          {{ LANG_LABELS[lang] }}
        </button>
      </div>
    </div>
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
            >{{ t("auth.brandBadge") }}</span
          >
        </div>

        <!-- 一句话定位 -->
        <h1 class="text-2xl sm:text-3xl lg:text-4xl font-bold leading-tight mb-3">
          {{ t("auth.taglineLine1") }}<br class="hidden sm:block" />{{ t("auth.taglineLine2") }}
        </h1>
        <p class="text-gray-400 text-sm sm:text-base leading-relaxed mb-8">
          {{ t("auth.positioning") }}
        </p>

        <!-- 核心能力卡片 -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
          <div class="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <div class="text-lg mb-1.5">🔍</div>
            <h3 class="font-semibold text-sm mb-1">{{ t("auth.cardXrayTitle") }}</h3>
            <p class="text-gray-500 text-xs leading-relaxed">
              {{ t("auth.cardXrayDesc") }}
            </p>
          </div>
          <div class="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <div class="text-lg mb-1.5">🤖</div>
            <h3 class="font-semibold text-sm mb-1">{{ t("auth.cardAiTitle") }}</h3>
            <p class="text-gray-500 text-xs leading-relaxed">
              {{ t("auth.cardAiDesc") }}
            </p>
          </div>
          <div class="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <div class="text-lg mb-1.5">📡</div>
            <h3 class="font-semibold text-sm mb-1">{{ t("auth.cardConcurrentTitle") }}</h3>
            <p class="text-gray-500 text-xs leading-relaxed">
              {{ t("auth.cardConcurrentDesc") }}
            </p>
          </div>
          <div class="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <div class="text-lg mb-1.5">🧩</div>
            <h3 class="font-semibold text-sm mb-1">{{ t("auth.cardZeroIntroTitle") }}</h3>
            <p class="text-gray-500 text-xs leading-relaxed">
              {{ t("auth.cardZeroIntroDesc") }}
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
            :title="t('auth.githubTitle')"
            >⭐ GitHub</a
          >
          <span class="text-gray-700">·</span>
          <router-link
            to="/blog"
            class="text-orange-400/80 hover:text-orange-400 transition-colors flex items-center gap-1"
            >📝 Blog</router-link
          >
          <span class="text-gray-700">·</span>
          <span>{{ t("auth.scriptTag") }}</span>
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
          <h2 class="text-xl font-bold mb-1">{{ t("auth.signInTitle") }}</h2>
          <p class="text-gray-500 text-sm">{{ t("auth.signInSubtitle") }}</p>
        </div>

        <div class="space-y-3">
          <input
            v-model="authKeyInput"
            type="password"
            :placeholder="t('auth.keyPlaceholder')"
            class="w-full px-4 py-3 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 focus:outline-none text-sm"
            @keydown.enter="submitAuth"
            :disabled="authLoading"
          />
          <button
            @click="submitAuth"
            :disabled="authLoading || !authKeyInput.trim()"
            class="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg font-medium text-sm transition"
          >
            {{ authLoading ? t("auth.signingIn") : t("auth.signIn") }}
          </button>
          <p v-if="authError" class="text-red-400 text-sm text-center">{{ authError }}</p>

          <!-- 游客访问按钮 -->
          <div v-if="playgroundEnabled" class="pt-2">
            <div class="flex items-center gap-3 mb-3">
              <div class="flex-1 h-px bg-gray-700"></div>
              <span class="text-xs text-gray-500">{{ t("auth.or") }}</span>
              <div class="flex-1 h-px bg-gray-700"></div>
            </div>
            <button
              @click="handleGuestLogin"
              :disabled="authLoading"
              class="w-full px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-gray-500 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition flex items-center justify-center gap-2"
            >
              <span>🎮</span>
              <span>{{ t("auth.guestPlayground") }}</span>
            </button>
          </div>

          <!-- 游客自建项目 Key -->
          <div v-if="guestProjectsEnabled" class="pt-4">
            <div class="flex items-center gap-3 mb-3">
              <div class="flex-1 h-px bg-gray-700"></div>
              <span class="text-xs text-gray-500">{{ t("auth.guestExtras") }}</span>
              <div class="flex-1 h-px bg-gray-700"></div>
            </div>

            <!-- 创建表单 -->
            <div v-if="!guestResult" class="space-y-2">
              <p class="text-xs text-gray-500 leading-relaxed">
                {{ t("auth.guestCreatePrefix")
                }}<span class="text-gray-300">{{ t("auth.guestYoursAlone") }}</span
                >{{ t("auth.guestCreateMiddle") }}
                <span class="text-yellow-500">{{ t("auth.guestLivesMax5Days") }}</span
                >{{ t("auth.guestCreateSuffix") }}
              </p>
              <div class="flex gap-2">
                <input
                  v-model="guestNameInput"
                  :placeholder="t('auth.guestNamePlaceholder')"
                  maxlength="30"
                  class="flex-1 px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 focus:outline-none text-sm"
                  @keydown.enter="handleGuestCreate"
                  :disabled="authLoading"
                />
                <button
                  @click="guestNameInput = randomProjectName()"
                  :title="t('auth.randomNameTitle')"
                  class="px-2.5 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg border border-gray-700 text-sm transition"
                >
                  🎲
                </button>
                <button
                  @click="handleGuestCreate"
                  :disabled="authLoading"
                  class="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition whitespace-nowrap"
                >
                  {{ authLoading ? t("auth.creating") : t("auth.createMyKey") }}
                </button>
              </div>
            </div>

            <!-- 一次性展示密钥 -->
            <div v-else class="space-y-3">
              <div class="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-3 space-y-2">
                <p class="text-xs text-yellow-400 font-semibold">
                  {{ t("auth.keyShowOnceWarning") }}
                </p>
                <p class="text-xs text-yellow-500/70 leading-relaxed">
                  {{ t("auth.keyShowOnceHint") }}
                </p>
                <code
                  class="block px-2 py-1.5 text-xs bg-gray-900 rounded font-mono break-all text-green-400 select-all"
                  >{{ guestResult.apiKey }}</code
                >
                <div class="flex gap-2">
                  <button
                    @click="guestEnterConsole"
                    :title="
                      guestCopied
                        ? t('auth.enterConsoleCopiedTitle')
                        : t('auth.enterConsoleNotCopiedTitle')
                    "
                    class="flex-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded font-medium text-xs transition"
                  >
                    {{ t("auth.enterConsole") }}
                  </button>
                  <button
                    @click="handleGuestCopy"
                    :class="
                      guestCopied
                        ? 'bg-green-700 hover:bg-green-700 text-white'
                        : 'bg-gray-700 hover:bg-gray-600 text-white'
                    "
                    class="px-3 py-2 rounded font-medium text-xs transition"
                  >
                    {{ guestCopied ? t("common.copied") : t("common.copy") }}
                  </button>
                </div>
              </div>
              <p class="text-[11px] text-gray-500">
                {{
                  t("auth.projectInfo", {
                    name: guestResult.projectName,
                    expires: fmtExpires(guestResult.expiresAt),
                  })
                }}
                <code class="text-gray-400">{{ guestResult.projectId }}</code>
              </p>
            </div>
          </div>
        </div>

        <div class="pt-4 space-y-2">
          <p class="text-xs text-gray-500 leading-relaxed">
            <span class="text-gray-400">{{ t("auth.keyScopeAdminLabel") }}</span
            >{{ t("auth.keyScopeAdminRest") }}<br />
            <span class="text-gray-400">{{ t("auth.keyScopeProjectLabel") }}</span
            >{{ t("auth.keyScopeProjectRest") }}
          </p>
          <p class="text-xs text-gray-600">{{ t("auth.keyStorageHint") }}</p>
        </div>

        <!-- 游客模式提示 -->
        <div
          v-if="playgroundEnabled || guestProjectsEnabled"
          class="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-3"
        >
          <p class="text-xs text-yellow-400/80 leading-relaxed">
            {{ t("auth.guestNotice") }}<br />
            <a
              :href="GITHUB_URL"
              target="_blank"
              rel="noopener noreferrer"
              class="text-yellow-600 hover:text-yellow-500 underline underline-offset-2"
              >{{ t("auth.guestDeployLink") }}</a
            >
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
