<template>
  <div class="mx-auto max-w-3xl px-4 py-6">
    <!-- 顶部状态条 -->
    <div
      v-if="status"
      class="mb-4 flex items-center justify-between rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm"
    >
      <span v-html="status"></span>
      <span class="font-mono text-xs text-gray-400">fetch 请求计数: {{ fetchCount }}</span>
    </div>

    <h1 class="mb-1 text-xl font-semibold">端侧 AI 原生页面 Demo</h1>
    <p class="mb-5 text-[13px] text-gray-500">
      这是一个假的「用户反馈工单后台」。页面上没有任何聊天窗——AI 能力被打散嵌进每一个交互点。
      全部推理在<b>你的浏览器本地</b>完成（Chrome Prompt API / Gemini Nano），断网可用，Network 面板零请求。
      需 Chrome 138+ 桌面版，在 <code>chrome://settings/ai</code> 里开启内置 AI 并完成模型下载。
    </p>

    <!-- ① 语义搜索 -->
    <section class="mb-4 rounded-xl border border-gray-300 bg-white p-4">
      <h2 class="mb-1 text-[15px] font-semibold">① 语义搜索：搜「意思」而不是搜「字」</h2>
      <p class="mb-3 text-xs text-gray-500">
        传统搜索匹配关键词；这里模型理解语义。<b class="text-sky-600">为什么敢每次按键都调模型？因为零成本零延迟。</b>
      </p>
      <input
        v-model="semQuery"
        class="mb-3 w-full rounded-md border border-gray-300 px-2.5 py-2 text-[13px] focus:border-sky-500 focus:outline-none"
        placeholder="试试输入：登录不上来的那些 / 关于手机上用不了的 / 期望但还没有的功能"
      />
      <table class="w-full text-[13px]">
        <thead>
          <tr class="text-left text-gray-400">
            <th class="w-9 py-1.5">#</th>
            <th>反馈内容</th>
            <th class="w-44">AI 标签</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="t in tickets"
            :key="t.i"
            class="border-t border-gray-200"
            :class="hits.has(t.i) && 'bg-sky-100'"
          >
            <td class="py-1.5">{{ t.i + 1 }}</td>
            <td>{{ t.text }}</td>
            <td>
              <span v-if="t.tag" :class="tagClass(t.tag)" class="rounded-full px-2 py-0.5 text-[11px]">{{
                tagLabel(t.tag)
              }}</span>
              <span v-else class="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] italic text-gray-400">未打标</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="mt-2 text-xs text-gray-500">{{ semNote }}</p>
    </section>

    <!-- ② 报错翻译 -->
    <section class="mb-4 rounded-xl border border-gray-300 bg-white p-4">
      <h2 class="mb-1 text-[15px] font-semibold">② 报错的「人话翻译」：错误码 → 人能懂的话</h2>
      <p class="mb-3 text-xs text-gray-500">
        校验术语（正则、大小写、特殊字符）直接甩给用户是偷懒。
        <b class="text-sky-600">本地模型让每个错误提示都可以被翻译，且用户输入不出设备。</b>
      </p>
      <div class="flex flex-wrap items-start gap-3">
        <div class="min-w-64 flex-1">
          <input
            v-model="pwd"
            class="w-full rounded-md border border-red-400 px-2.5 py-2 text-[13px]"
            placeholder="输入一个不符合规则的密码，如 123"
          />
          <p class="mt-1 text-xs text-red-600">
            密码不符合规则：必须 ≥8 位，包含大小写字母、数字和特殊字符
            <span v-if="pwdHuman" class="block text-green-700">{{ pwdHuman }}</span>
          </p>
        </div>
        <button
          :disabled="!ready || pwdBusy"
          class="rounded-md bg-green-700 px-3.5 py-2 text-[13px] text-white disabled:bg-gray-400"
          @click="translatePwd"
        >
          {{ pwdBusy ? "本地翻译中…" : "帮我翻译成人话" }}
        </button>
      </div>
    </section>

    <!-- ③ 批量打标 -->
    <section class="mb-4 rounded-xl border border-gray-300 bg-white p-4">
      <h2 class="mb-1 text-[15px] font-semibold">③ 批量语义打标：把 6 条反馈分类，成本 ¥0</h2>
      <p class="mb-3 text-xs text-gray-500">
        同样的任务云端按 token 计费、有限速。
        <b class="text-sky-600">本地模型把它变成和 sort() 一样的免费内置函数。</b>
      </p>
      <button
        :disabled="!ready || tagBusy"
        class="rounded-md bg-green-700 px-3.5 py-2 text-[13px] text-white disabled:bg-gray-400"
        @click="tagAll"
      >
        开始本地打标
      </button>
      <div class="mt-2 h-1.5 overflow-hidden rounded bg-gray-200">
        <div class="h-full bg-green-700 transition-all" :style="{ width: tagProgress + '%' }"></div>
      </div>
      <p class="mt-2 text-xs text-gray-500">{{ tagNote }}</p>
    </section>

    <!-- ④ 划词解释 -->
    <section class="mb-4 rounded-xl border border-gray-300 bg-white p-4">
      <h2 class="mb-1 text-[15px] font-semibold">④ 划词即解释：模型增强的「查看定义」</h2>
      <p class="mb-3 text-xs text-gray-500">
        用鼠标选中下面这段工单里的任意术语，AI 就地解释。
        <b class="text-sky-600">浏览器第一次有了「内置词典」这个平台能力。</b>
      </p>
      <p ref="docEl" class="px-1.5 text-sm leading-8" @mouseup="explainSelection">
        用户反馈：在弱网环境调用 <code>/api/v2/submit</code> 时遭遇 CORS 拦截，预检请求 OPTIONS 返回 405，且响应头缺少
        <code>Access-Control-Allow-Origin</code>，疑似网关层未透传 CORS 头，触发 same-origin policy 限制。
      </p>
      <p
        v-if="docOut"
        class="mt-2 whitespace-pre-wrap rounded-md bg-gray-100 px-3 py-2.5 text-[13px] leading-7"
      >
        {{ docOut }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";

/** 本地模型会话（LanguageModel API 的 Prompt API） */
let session: AILanguageModelSession | null = null;
const status = ref("");
const ready = ref(false);

/** fetch 计数器：证明 AI 推理不走网络 */
let fetchCountRef = ref(0);
const fetchCount = computed(() => fetchCountRef.value);
const origFetch = window.fetch.bind(window);
window.fetch = (...args: Parameters<typeof fetch>) => {
  fetchCountRef.value++;
  return origFetch(...args);
};
onUnmounted(() => {
  window.fetch = origFetch;
  session?.destroy();
  session = null;
});

/** ① 工单数据 + 语义搜索 */
const tickets = ref(
  [
    "登录页面点登录没反应，转圈圈半天才报错",
    "手机上打开白屏，电脑上就正常",
    "验证码一直说错误，明明照着输的",
    "希望能支持深色模式，晚上用太刺眼了",
    "要是能像飞书一样支持快捷键就好了",
    "上传大文件到 80% 就失败，提示网络错误但网络没问题",
  ].map((text, i) => ({ i, text, tag: "" as "" | "bug" | "feat" | "ux" | "other" })),
);
const semQuery = ref("");
const semNote = ref("语义搜索待命");
const hits = ref(new Set<number>());
let semTimer: ReturnType<typeof setTimeout> | undefined;

/** 短回答助手（非流式，取完整结果） */
async function ai(prompt: string): Promise<string> {
  if (!session) throw new Error("本地模型未就绪");
  return (await session.prompt(prompt)).trim();
}

watch(semQuery, (q) => {
  clearTimeout(semTimer);
  if (!q.trim()) {
    hits.value = new Set();
    semNote.value = "语义搜索待命";
    return;
  }
  semTimer = setTimeout(() => runSemanticSearch(q.trim()), 400);
});

async function runSemanticSearch(q: string) {
  semNote.value = "本地模型理解中……";
  try {
    const list = tickets.value.map((t) => `${t.i + 1}. ${t.text}`).join("\n");
    const marks = await ai(`以下是工单列表：\n${list}\n\n用户想找：「${q}」。只输出匹配的行号，逗号分隔，不要其他文字。`);
    const set = new Set(
      marks
        .split(/[^0-9]+/)
        .filter(Boolean)
        .map((n) => parseInt(n) - 1),
    );
    hits.value = set;
    semNote.value = `模型理解为：「${q}」，命中 ${set.size} 条`;
  } catch (e) {
    semNote.value = `出错：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** ② 报错翻译 */
const pwd = ref("123");
const pwdHuman = ref("");
const pwdBusy = ref(false);

async function translatePwd() {
  pwdBusy.value = true;
  pwdHuman.value = "";
  try {
    const v = pwd.value || "123";
    pwdHuman.value =
      "💬 " +
      (await ai(
        `用户设置了密码"${v}"，校验规则是：≥8位、含大小写字母、数字、特殊字符。用一句友好的中文指出具体差什么，并给一个符合规则的示例密码。`,
      ));
  } catch (e) {
    pwdHuman.value = "出错：" + (e instanceof Error ? e.message : String(e));
  } finally {
    pwdBusy.value = false;
  }
}

/** ③ 批量打标 */
const tagBusy = ref(false);
const tagProgress = ref(0);
const tagNote = ref("待命");

async function tagAll() {
  tagBusy.value = true;
  tagProgress.value = 0;
  const total = tickets.value.length;
  for (const t of tickets.value) {
    tagNote.value = `正在打标 ${t.i + 1}/${total}：「${t.text.slice(0, 12)}…」`;
    try {
      const out = await ai(`把这条用户反馈分类，只输出一个词：bug（故障）/ feat（功能期望）/ ux（体验问题）/ other。「${t.text}」`);
      const word = (out.match(/bug|feat|ux|other/i)?.[0] ?? "other").toLowerCase();
      t.tag = word as typeof t.tag;
    } catch {
      t.tag = "other";
    }
    tagProgress.value = ((t.i + 1) / total) * 100;
  }
  tagNote.value = `完成 ✓ ${total} 条全部本地分类，总成本 ¥0，期间页面发出网络请求 ${fetchCount.value} 次`;
  tagBusy.value = false;
}

const TAG_LABELS = { bug: "🐞 故障", feat: "✨ 功能期望", ux: "📱 体验", other: "📋 其他" } as const;
const TAG_CLASSES = {
  bug: "bg-red-100 text-red-700",
  feat: "bg-green-100 text-green-700",
  ux: "bg-yellow-100 text-yellow-800",
  other: "bg-gray-100 text-gray-600",
} as const;
const tagLabel = (t: keyof typeof TAG_LABELS) => TAG_LABELS[t];
const tagClass = (t: keyof typeof TAG_CLASSES) => TAG_CLASSES[t];

/** ④ 划词解释 */
const docEl = ref<HTMLElement | null>(null);
const docOut = ref("");

async function explainSelection() {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? "";
  if (!text || text.length > 60 || !docEl.value?.contains(sel!.anchorNode)) return;
  docOut.value = `💬 本地解释「${text}」中……`;
  try {
    docOut.value = `💬 ${text}：` + (await ai(`用一两句话向前端开发者解释「${text}」是什么。`));
  } catch (e) {
    docOut.value = "出错：" + (e instanceof Error ? e.message : String(e));
  }
}

/** 初始化：能力检测 + 建会话 */
void (async () => {
  const badge = (text: string, cls: string) =>
    `<span class="rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}">${text}</span>`;
  if (!("LanguageModel" in window)) {
    status.value =
      badge("不支持", "bg-red-100 text-red-700") +
      " 当前浏览器无 LanguageModel 接口。请用 Chrome 138+ 桌面版，并在 chrome://settings/ai 里开启内置 AI 功能。";
    return;
  }
  const av = await LanguageModel.availability();
  if (av !== "available") {
    const tip = {
      downloadable: "模型未下载（约 1~2GB）。到 chrome://settings/ai 开启内置 AI 功能，浏览器会自动下载模型。",
      downloading: "模型正在下载中，稍后再试。",
      unavailable: "当前设备/浏览器配置无法运行本地模型（可能内存不足或功能未开放）。",
    }[av];
    status.value = badge(av, "bg-yellow-100 text-yellow-800") + " " + tip;
    return;
  }
  status.value = badge("模型加载中…", "bg-yellow-100 text-yellow-800") + " 正在初始化本地模型（如首次可能触发下载）";
  session = await LanguageModel.create({
    initialPrompts: [{ role: "system", content: "你是嵌入在网页里的助手。回答极简，中文，直接给结果不要客套。" }],
    temperature: 0.2,
    /** 实测：languages 声明只接受 de/en/es/fr/ja，声明 zh 抛 NotSupportedError；
     * 但不声明语言时模型照样能读写出中文（实测中文工单打标/搜索正常），中文能力来自模型本身而非声明。
     * 本页输入输出都是中文，因此不指定 languages */
    expectedInputs: [{ type: "text" }],
    expectedOutputs: [{ type: "text" }],
    /** 下载/加载进度监听：downloadprogress 的 e.loaded 是 0~1 的小数 */
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        status.value = badge("下载中", "bg-yellow-100 text-yellow-800") + ` 模型数据下载/加载中 ${Math.floor(e.loaded * 100)}%`;
      });
    },
  });
  ready.value = true;
  status.value =
    badge("本地模型就绪", "bg-green-100 text-green-700") +
      " Gemini Nano · 运行在本设备 · 断网可用 · 中文实测可用（官方语言声明仅接受 de/en/es/fr/ja，中文属于未保证的兜底能力）";
})();
</script>
