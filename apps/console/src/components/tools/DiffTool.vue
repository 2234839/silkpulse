<script setup lang="ts">
/**
 * DiffTool —— 文本/JSON Diff 对比（ToolsPanel 的 Diff 页签）
 *
 * 三种视图：inline（配对行合并 + 字符级高亮）/ split（左右并排）/ object（JSON 对象树并排）。
 * JSON 模式支持可选 key 排序（消除 key 顺序误报）、解析/渲染耗时测量、
 * 对象树同步展开/同步滚动、折叠连续未变化行、可编辑对象树回写。
 * 输入经 300ms 防抖后才做行级 LCS diff。
 */
import { ref, computed, watch, nextTick } from "vue";
import { useDebouncedRef } from "../../composables/useDebouncedRef";
import { sortKeysDeep } from "../../utils/json-tools";
import { diffLines, diffText, type TextDiffSegment } from "@silkpulse/renderer";
import ObjectInspector from "../ObjectInspector.vue";
import { useUndoToast } from "../../composables/useUndoToast";
import { useResizable } from "../../composables/useResizable";
import UndoToast from "./UndoToast.vue";

/** 清空撤销 toast */
const { visible: undoVisible, toastMessage, clearWithUndo, undo: doUndo } = useUndoToast();

const diffA = defineModel<string>("inputA", { default: "" });
const diffB = defineModel<string>("inputB", { default: "" });
const diffTreeSearchA = defineModel<string>("searchA", { default: "" });
const diffTreeSearchB = defineModel<string>("searchB", { default: "" });

/** 防抖后的 Diff 两侧输入（300ms）：大文本粘贴时避免每次键入都同步做 LCS 卡死输入框 */
const diffADebounced = useDebouncedRef(diffA, 300);
const diffBDebounced = useDebouncedRef(diffB, 300);

const diffJsonMode = ref(true);
/**
 * 是否在 JSON 格式化前递归排序 object key
 *
 * 默认关闭——只有用户主动勾选才排序，避免改变用户数据原有的 key 顺序语义。
 * 排序后能让「仅 key 顺序不同」的 JSON 判定为一致，避免误报。
 */
const diffSortKeys = ref(false);
/** 视图模式：inline=上下合并显示，split=左右并排，object=JSON 对象树 */
const diffViewMode = ref<"inline" | "split" | "object">("inline");
/**
 * 对象模式自动开关（「对象」按钮内的 ✓/○ 切换）
 *
 * 开启时：一旦两侧都能解析为 JSON（可切对象视图），自动切到 object 模式。
 * 初始默认：能切对象就切对象，切不了就停在合并模式。
 */
const diffAutoObject = ref(true);
/** 对象视图：左右两树同步展开/折叠（展开一侧节点，对侧同路径节点跟随） */
const diffSyncExpand = ref(false);
/** 对象视图：左右两树同步滚动（滚动一侧，对侧滚动条按比例跟随） */
const diffSyncScroll = ref(false);
/** 同步滚动锁：防止 A→B→A 无限回环 */
let diffScrollLock = 0;

/** split 视图左右窗格滚动容器（模板 ref，替代脆弱的 CSS 选择器查找） */
const scrollA = ref<HTMLElement | null>(null);
const scrollB = ref<HTMLElement | null>(null);

/**
 * 按比例同步滚动
 *
 * 通过模板 ref 直接拿到对侧窗格，不依赖 DOM 层级/类名。
 */
function syncDiffScroll(e: Event, source: "a" | "b") {
  if (!diffSyncScroll.value || diffScrollLock > 0) return;
  const sourceEl = e.target as HTMLElement;
  const target = source === "a" ? scrollB.value : scrollA.value;
  if (!target || target === sourceEl) return;
  diffScrollLock++;
  try {
    const denomX = sourceEl.scrollWidth - sourceEl.clientWidth;
    const denomY = sourceEl.scrollHeight - sourceEl.clientHeight;
    target.scrollLeft =
      denomX > 0 ? (sourceEl.scrollLeft / denomX) * (target.scrollWidth - target.clientWidth) : 0;
    target.scrollTop =
      denomY > 0 ? (sourceEl.scrollTop / denomY) * (target.scrollHeight - target.clientHeight) : 0;
  } finally {
    /** 对侧的滚动事件在本宏任务派发后才触发，下个宏任务解锁即可放行下一次用户滚动 */
    setTimeout(() => diffScrollLock--, 0);
  }
}
/** 交换 Diff 两侧输入 */
function diffSwap() {
  const tmp = diffA.value;
  diffA.value = diffB.value;
  diffB.value = tmp;
}

/** 清空 Diff 两侧输入（暂存内容，5s 内可撤销） */
function diffClear() {
  const a = diffA.value;
  const b = diffB.value;
  if (!a && !b) return;
  diffA.value = "";
  diffB.value = "";
  clearWithUndo(() => {
    diffA.value = a;
    diffB.value = b;
  }, "已清空两侧输入");
}

/** 字符级高亮：对变化的行进一步标出具体改了哪些字符 */
const diffCharLevel = ref(true);
/** 折叠连续未变化行（只保留首尾各 2 行上下文） */
const diffCollapseSame = ref(true);

/** Diff 单侧的 JSON 预处理结果 */
interface DiffPrepared {
  /** 用于行级 diff 的格式化文本（JSON 模式下格式化成功则为 pretty JSON，失败回退原文本） */
  formatted: string;
  /** 解析后的 JS 值（object 树视图用，解析失败为 undefined） */
  parsed: unknown;
  /** 是否解析成功（决定能否切到 object 视图） */
  isJson: boolean;
}

/** 预处理单侧 diff 输入：JSON 模式下解析 + 可选 key 排序 + 格式化 */
function prepareDiffInput(text: string): DiffPrepared {
  if (!diffJsonMode.value) return { formatted: text, parsed: undefined, isJson: false };
  if (!text.trim()) return { formatted: text, parsed: undefined, isJson: false };
  try {
    let parsed: unknown = JSON.parse(text);
    if (diffSortKeys.value) parsed = sortKeysDeep(parsed);
    return { formatted: JSON.stringify(parsed, null, 2), parsed, isJson: true };
  } catch {
    return { formatted: text, parsed: undefined, isJson: false };
  }
}

/** JSON 解析耗时（A+B 合计，含 sortKeys 和格式化） */
const diffParseMs = ref<number | null>(null);
/** 对象视图渲染耗时（从数据就绪到 DOM 完成） */
const diffRenderMs = ref<number | null>(null);

/** 两侧输入的预处理结果（memo 化，行级 diff 和 object 视图共用） */
const diffPrepA = computed<DiffPrepared>(() => prepareDiffInput(diffADebounced.value));
const diffPrepB = computed<DiffPrepared>(() => prepareDiffInput(diffBDebounced.value));

/** 测量解析耗时（在 computed 外手动计时，避免每次访问都重复计时；非同步 flush，防抖后代价可接受） */
watch([diffADebounced, diffBDebounced, diffJsonMode, diffSortKeys], () => {
  if (!diffJsonMode.value) {
    diffParseMs.value = null;
    return;
  }
  const t0 = performance.now();
  /** 触发一次完整解析（利用 computed 缓存，实际只算一次） */
  void diffPrepA.value;
  void diffPrepB.value;
  diffParseMs.value = performance.now() - t0;
});

/** 测量对象视图渲染耗时：数据变化 → nextTick → rAF（浏览器完成绘制） */
watch([diffPrepA, diffPrepB, diffViewMode], async () => {
  if (diffViewMode.value !== "object" || !diffCanObjectView.value) {
    diffRenderMs.value = null;
    return;
  }
  const t0 = performance.now();
  /** 等 Vue 完成 DOM 更新 */
  await nextTick();
  /** 再等浏览器完成一帧绘制 */
  requestAnimationFrame(() => {
    diffRenderMs.value = performance.now() - t0;
  });
});

/** 是否可切到 object 视图（JSON 模式 + 两侧都解析成功） */
const diffCanObjectView = computed(() => diffPrepA.value.isJson && diffPrepB.value.isJson);

/**
 * 对象视图可用性联动：
 * - 可用且自动开关开启 → 自动切到 object（含初始默认：能切对象就默认对象）
 * - 不可用 → 回退到 inline（避免卡在空视图）
 */
watch(
  diffCanObjectView,
  (can) => {
    if (can) {
      if (diffAutoObject.value && diffJsonMode.value) diffViewMode.value = "object";
    } else if (diffViewMode.value === "object") {
      diffViewMode.value = "inline";
    }
  },
  { immediate: true },
);

/** 一行 diff 数据（行级） */
interface DiffLine {
  /** 行类型：equal=add=del */
  type: "equal" | "add" | "del";
  /** 行文本（不含换行符） */
  text: string;
  /** 旧文件行号（1-based，del/equal 有值，add 为 null） */
  oldNum: number | null;
  /** 新文件行号（1-based，add/equal 有值，del 为 null） */
  newNum: number | null;
  /** 字符级 inline diff（仅 add/del 行且启用字符级时有值） */
  charDiff?: TextDiffSegment[];
}

/**
 * 计算 diff 结果
 *
 * 算法：先用 diffLines 做行级 LCS（解决行错位问题），
 * 再对相邻的 del+add 行对做字符级 diffText（标出具体改了哪些字符）。
 */
const diffResult = computed<DiffLine[]>(() => {
  /** 对象视图模式下跳过行级 LCS diff（大 JSON 时 LCS O(n×m) 是性能瓶颈，且结果不被使用） */
  if (diffViewMode.value === "object") return [];
  const a = diffPrepA.value.formatted;
  const b = diffPrepB.value.formatted;
  if (!a && !b) return [];

  /** 行级 LCS diff */
  const lineSegs = diffLines(a, b);

  /** 展开为逐行 DiffLine，分配行号 */
  const lines: DiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;

  for (const seg of lineSegs) {
    /** 按 \n 切分，去掉末尾空串（最后一段可能没有换行符） */
    const segLines = seg.text.split("\n");
    /** split('\n') 在末尾有换行时会产生空串，去掉它 */
    if (seg.text.endsWith("\n")) segLines.pop();

    for (const lineText of segLines) {
      switch (seg.op) {
        case "equal":
          oldNum++;
          newNum++;
          lines.push({ type: "equal", text: lineText, oldNum, newNum });
          break;
        case "removed":
          oldNum++;
          lines.push({ type: "del", text: lineText, oldNum, newNum: null });
          break;
        case "added":
          newNum++;
          lines.push({ type: "add", text: lineText, oldNum: null, newNum });
          break;
      }
    }
  }

  /**
   * 字符级 diff：对配对的 del+add 行做 inline char diff。
   *
   * 配对策略：找到所有连续的「del 块 + add 块」（不论顺序），
   * 按位置逐对做 diffText，让用户在同一行内看到具体改了哪些字符。
   * del 和 add 的相对顺序由 LCS 回溯决定，可能 del 在前也可能 add 在前。
   */
  if (diffCharLevel.value) {
    let i = 0;
    while (i < lines.length) {
      /** 跳过 equal 行 */
      if (lines[i].type === "equal") {
        i++;
        continue;
      }
      /** 收集连续的非 equal 行（del 和 add 混合） */
      const blockStart = i;
      while (i < lines.length && lines[i].type !== "equal") i++;
      const block = lines.slice(blockStart, i);

      /** 从块中分离 del 和 add */
      const dels = block.filter((l) => l.type === "del");
      const adds = block.filter((l) => l.type === "add");

      /** 按位置配对做字符级 diff */
      const pairs = Math.min(dels.length, adds.length);
      for (let p = 0; p < pairs; p++) {
        const charDiff = diffText(dels[p].text, adds[p].text);
        dels[p].charDiff = charDiff;
        adds[p].charDiff = charDiff;
      }
    }
  }

  return lines;
});

/** diff 统计信息 */
const diffStats = computed(() => {
  const lines = diffResult.value;
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
    else unchanged++;
  }
  return { added, removed, unchanged, total: lines.length };
});

/**
 * 折叠后的 diff 行列表（inline 模式）
 *
 * 连续超过 4 行的 equal 段只保留首尾各 2 行。
 * 连续的 del+add 块按位置交叉排列（del[0],add[0],del[1],add[1]...），
 * 让用户能直观对比「同一行的旧→新」。
 */
const diffCollapsedInline = computed(() => {
  const lines = diffResult.value;

  type CollapsedItem = { kind: "line"; line: DiffLine } | { kind: "collapse"; count: number };

  const CONTEXT = 2;
  const result: CollapsedItem[] = [];
  let hiddenTotal = 0;

  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "equal") {
      let j = i;
      while (j < lines.length && lines[j].type === "equal") j++;
      const equalLen = j - i;
      if (diffCollapseSame.value && equalLen > CONTEXT * 2 + 1) {
        for (let k = i; k < i + CONTEXT; k++) result.push({ kind: "line", line: lines[k] });
        const hiddenCount = equalLen - CONTEXT * 2;
        result.push({ kind: "collapse", count: hiddenCount });
        hiddenTotal += hiddenCount;
        for (let k = j - CONTEXT; k < j; k++) result.push({ kind: "line", line: lines[k] });
      } else {
        for (let k = i; k < j; k++) result.push({ kind: "line", line: lines[k] });
      }
      i = j;
    } else {
      /** 收集连续非 equal 块 */
      const blockStart = i;
      while (i < lines.length && lines[i].type !== "equal") i++;
      const block = lines.slice(blockStart, i);
      const dels = block.filter((l) => l.type === "del");
      const adds = block.filter((l) => l.type === "add");

      /** 交叉排列：del[0],add[0],del[1],add[1]... */
      const pairs = Math.min(dels.length, adds.length);
      for (let p = 0; p < pairs; p++) {
        result.push({ kind: "line", line: dels[p] });
        result.push({ kind: "line", line: adds[p] });
      }
      for (let p = pairs; p < dels.length; p++) result.push({ kind: "line", line: dels[p] });
      for (let p = pairs; p < adds.length; p++) result.push({ kind: "line", line: adds[p] });
    }
  }

  return { lines: result, hiddenCount: hiddenTotal };
});

/**
 * 折叠后的 diff 行列表（split 模式）
 *
 * 与 inline 相同的折叠逻辑，但不交叉排列 del/add。
 */
const diffCollapsed = computed(() => {
  const lines = diffResult.value;

  type CollapsedItem = { kind: "line"; line: DiffLine } | { kind: "collapse"; count: number };

  const CONTEXT = 2;
  const result: CollapsedItem[] = [];
  let hiddenTotal = 0;

  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "equal") {
      let j = i;
      while (j < lines.length && lines[j].type === "equal") j++;
      const equalLen = j - i;
      if (diffCollapseSame.value && equalLen > CONTEXT * 2 + 1) {
        for (let k = i; k < i + CONTEXT; k++) result.push({ kind: "line", line: lines[k] });
        const hiddenCount = equalLen - CONTEXT * 2;
        result.push({ kind: "collapse", count: hiddenCount });
        hiddenTotal += hiddenCount;
        for (let k = j - CONTEXT; k < j; k++) result.push({ kind: "line", line: lines[k] });
      } else {
        for (let k = i; k < j; k++) result.push({ kind: "line", line: lines[k] });
      }
      i = j;
    } else {
      result.push({ kind: "line", line: lines[i] });
      i++;
    }
  }

  return { lines: result, hiddenCount: hiddenTotal };
});

/**
 * 提取 charDiff 中指定 op 的文本段（用于渲染）
 *
 * del 行只渲染 removed + equal 段（红底），
 * add 行只渲染 added + equal 段（绿底）。
 */
function charDiffParts(line: DiffLine): TextDiffSegment[] {
  if (!line.charDiff) return [{ op: "equal", text: line.text }];
  const wantRemoved = line.type === "del";
  return line.charDiff.filter(
    (seg) => seg.op === "equal" || (wantRemoved ? seg.op === "removed" : seg.op === "added"),
  );
}

/** A/B 输入框宽度拖拽（各自持久化） */
const { width: inputAWidth, onDragStart: onInputADrag } = useResizable({
  initial: 0,
  min: 200,
  max: 1200,
  direction: "right",
  storageKey: "silkpulse.tools-split.diff-input-a",
});
/** 输入区高度拖拽（持久化；0 表示未拖过，用 rows 默认高度） */
const { width: inputHeight, onDragStart: onInputHeightDrag } = useResizable({
  initial: 133,
  min: 60,
  max: 480,
  direction: "down",
  storageKey: "silkpulse.tools-split.diff-input-height",
});
</script>

<template>
  <div class="flex flex-col h-full max-h-[calc(100vh-120px)]">
    <!-- 输入区：A/B 宽度可拖拽，整体高度可拖拽 -->
    <div class="flex gap-2 flex-shrink-0 mb-2">
      <div
        class="flex flex-col gap-1 min-w-0"
        :style="inputAWidth > 0 ? { width: inputAWidth + 'px' } : undefined"
        :class="inputAWidth > 0 ? '' : 'flex-1'"
      >
        <label class="text-xs text-muted">文本 A（期望）</label>
        <textarea
          v-model="diffA"
          rows="6"
          spellcheck="false"
          class="w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          :style="{ height: inputHeight + 'px' }"
        ></textarea>
      </div>
      <!-- A/B 宽度拖拽手柄 -->
      <div
        class="group relative w-1.5 cursor-col-resize flex-shrink-0 -mx-1 z-10"
        title="拖拽调整两侧占比"
        @mousedown="onInputADrag"
      >
        <div class="absolute inset-y-0 -left-1 -right-1"></div>
        <div
          class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 rounded bg-base transition-all group-hover:w-1 group-hover:bg-blue-400/60 group-active:bg-blue-500"
        ></div>
      </div>
      <div class="flex flex-col gap-1 flex-1 min-w-0">
        <label class="text-xs text-muted">文本 B（实际）</label>
        <textarea
          v-model="diffB"
          rows="6"
          spellcheck="false"
          class="w-full bg-input border border-base rounded p-2 text-xs font-mono text-primary resize-none focus:outline-none focus:border-blue-500"
          :style="{ height: inputHeight + 'px' }"
        ></textarea>
      </div>
    </div>
    <!-- 输入区高度拖拽手柄 -->
    <div
      class="group relative h-1.5 cursor-row-resize flex-shrink-0 -my-1 mb-1 z-10"
      title="拖拽调整输入区高度"
      @mousedown="onInputHeightDrag"
    >
      <div class="absolute inset-x-0 -top-1 -bottom-1"></div>
      <div
        class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 rounded bg-base transition-all group-hover:h-1 group-hover:bg-blue-400/60 group-active:bg-blue-500"
      ></div>
    </div>
    <!-- 工具栏 -->
    <div class="flex items-center gap-3 px-1 pb-2 border-b border-base flex-shrink-0 flex-wrap">
      <label class="text-xs text-muted flex items-center gap-1 cursor-pointer">
        <input type="checkbox" v-model="diffJsonMode" class="cursor-pointer" /> JSON 格式化
      </label>
      <label
        v-if="diffJsonMode"
        class="text-xs text-muted flex items-center gap-1 cursor-pointer"
        title="递归排序 object 的 key 后再对比，key 顺序不同将不再误报"
      >
        <input type="checkbox" v-model="diffSortKeys" class="cursor-pointer" /> Key 排序
      </label>
      <label class="text-xs text-muted flex items-center gap-1 cursor-pointer">
        <input type="checkbox" v-model="diffCharLevel" class="cursor-pointer" /> 字符级高亮
      </label>
      <label class="text-xs text-muted flex items-center gap-1 cursor-pointer">
        <input type="checkbox" v-model="diffCollapseSame" class="cursor-pointer" /> 折叠相同行
      </label>
      <label
        class="text-xs text-muted flex items-center gap-1 cursor-pointer"
        title="滚动一侧的对象树，另一侧按比例跟随滚动"
      >
        <input type="checkbox" v-model="diffSyncScroll" class="cursor-pointer" /> 同步滚动
      </label>
      <label
        class="text-xs text-muted flex items-center gap-1 cursor-pointer"
        title="展开/折叠一侧节点时，另一侧同路径节点跟随展开/折叠"
      >
        <input type="checkbox" v-model="diffSyncExpand" class="cursor-pointer" /> 同步展开
      </label>
      <div class="flex gap-1">
        <button
          @click="diffSwap"
          class="px-2 py-0.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          ⇄ 交换
        </button>
        <button
          @click="diffClear"
          class="px-2 py-0.5 text-xs rounded border border-base text-primary hover:border-blue-500"
        >
          清空
        </button>
      </div>
      <div class="flex rounded border border-base overflow-hidden">
        <button
          @click="diffViewMode = 'inline'"
          class="px-2 py-0.5 text-xs"
          :class="
            diffViewMode === 'inline'
              ? 'bg-blue-500 text-white'
              : 'bg-surface text-muted hover:text-primary'
          "
        >
          合并
        </button>
        <button
          @click="diffViewMode = 'split'"
          class="px-2 py-0.5 text-xs"
          :class="
            diffViewMode === 'split'
              ? 'bg-blue-500 text-white'
              : 'bg-surface text-muted hover:text-primary'
          "
        >
          并排
        </button>
        <div
          v-if="diffJsonMode"
          class="flex items-center rounded overflow-hidden border"
          :class="diffViewMode === 'object' ? 'border-blue-500' : 'border-base'"
        >
          <!-- 自动开关：点这里不切视图，只切换「能用时自动用对象」的状态 -->
          <button
            @click="diffAutoObject = !diffAutoObject"
            class="px-1 py-0.5 text-xs leading-none"
            :class="
              diffAutoObject
                ? 'bg-blue-500/20 text-blue-500'
                : 'bg-surface text-faint hover:text-primary'
            "
            title="自动对象模式：开启后，只要两侧都能解析为 JSON，就自动切换到对象视图"
          >
            {{ diffAutoObject ? "✓" : "○" }}
          </button>
          <button
            @click="diffViewMode = 'object'"
            :disabled="!diffCanObjectView"
            class="px-2 py-0.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
            :class="
              diffViewMode === 'object'
                ? 'bg-blue-500 text-white'
                : 'bg-surface text-muted hover:text-primary'
            "
            title="用 JSON 面板的 Object 渲染器并排展示两侧结构"
          >
            对象
          </button>
        </div>
      </div>
      <div
        v-if="diffStats.total || diffParseMs !== null"
        class="ml-auto flex items-center gap-3 text-xs"
      >
        <template v-if="diffStats.total">
          <span class="text-green-500">+{{ diffStats.added }}</span>
          <span class="text-red-500">−{{ diffStats.removed }}</span>
          <span v-if="diffCollapsed.hiddenCount" class="text-faint"
            >省略 {{ diffCollapsed.hiddenCount }} 行</span
          >
        </template>
        <span v-if="diffParseMs !== null" class="text-faint" title="JSON 解析 + 格式化耗时"
          >解析 {{ diffParseMs.toFixed(1) }}ms</span
        >
        <span
          v-if="diffRenderMs !== null"
          class="text-faint"
          title="对象树渲染耗时（DOM 更新 + 绘制）"
          >渲染 {{ diffRenderMs.toFixed(1) }}ms</span
        >
      </div>
    </div>
    <!-- 结果区 -->
    <div class="flex-1 overflow-auto min-h-0">
      <!-- ════ Object 对象树视图（JSON 模式专用，复用 ObjectInspector，带 diff 高亮 + 可编辑） ════ -->
      <div v-if="diffViewMode === 'object' && diffCanObjectView" class="flex gap-2 h-full">
        <div class="flex-1 min-w-0 flex flex-col border border-base rounded">
          <div
            class="px-2 py-1 text-xs text-muted bg-surface border-b border-base flex-shrink-0 flex items-center justify-between gap-2"
          >
            <span>A（期望）</span>
            <input
              v-model="diffTreeSearchA"
              type="text"
              placeholder="搜索节点..."
              class="w-32 px-2 py-0.5 text-xs bg-base border border-base rounded focus:outline-none focus:border-blue-400"
            />
          </div>
          <div ref="scrollA" class="flex-1 overflow-auto p-2" @scroll="syncDiffScroll($event, 'a')">
            <ObjectInspector
              :raw="diffPrepA.parsed"
              :diff-raw="diffPrepB.parsed"
              diff-side="old"
              :sync-key="'diff-a-b'"
              :sync-expand="diffSyncExpand"
              :search-query="diffTreeSearchA"
              editable
              @update:model-value="
                (v) => {
                  diffA = JSON.stringify(v, null, 2);
                }
              "
            />
          </div>
        </div>
        <div class="flex-1 min-w-0 flex flex-col border border-base rounded">
          <div
            class="px-2 py-1 text-xs text-muted bg-surface border-b border-base flex-shrink-0 flex items-center justify-between gap-2"
          >
            <span>B（实际）</span>
            <input
              v-model="diffTreeSearchB"
              type="text"
              placeholder="搜索节点..."
              class="w-32 px-2 py-0.5 text-xs bg-base border border-base rounded focus:outline-none focus:border-blue-400"
            />
          </div>
          <div ref="scrollB" class="flex-1 overflow-auto p-2" @scroll="syncDiffScroll($event, 'b')">
            <ObjectInspector
              :raw="diffPrepB.parsed"
              :diff-raw="diffPrepA.parsed"
              diff-side="new"
              :sync-key="'diff-a-b'"
              :sync-expand="diffSyncExpand"
              :search-query="diffTreeSearchB"
              editable
              @update:model-value="
                (v) => {
                  diffB = JSON.stringify(v, null, 2);
                }
              "
            />
          </div>
        </div>
      </div>

      <template v-else>
        <div
          v-if="diffResult.length === 0 && diffA && diffB"
          class="text-green-500 text-center py-4"
        >
          ✅ 完全一致
        </div>
        <div v-else-if="diffResult.length === 0" class="text-faint text-center py-4">
          输入两段文本后自动对比...
        </div>

        <!-- ════ Inline 视图（配对行合并：同一行内展示旧→新，字符级高亮） ════ -->
        <div v-else-if="diffViewMode === 'inline'" class="font-mono text-xs">
          <template v-for="(item, i) in diffCollapsedInline.lines" :key="i">
            <!-- 折叠指示器 -->
            <div
              v-if="item.kind === 'collapse'"
              class="px-4 py-0.5 text-faint text-center bg-base/50 border-y border-base cursor-pointer select-none"
            >
              ⋯ {{ item.count }} 行未变化 ⋯
            </div>
            <!-- diff 行（逐行渲染，VS Code inline 风格） -->
            <div
              v-else
              class="flex items-stretch"
              :class="{
                'diff-line-add': item.line.type === 'add',
                'diff-line-del': item.line.type === 'del',
              }"
            >
              <!-- 行号（del 显示旧行号，add 显示新行号，交叉排列后同一位置） -->
              <span
                class="inline-block w-12 text-right pr-2 select-none flex-shrink-0 text-faint"
                :class="{
                  'diff-gutter-add': item.line.type === 'add',
                  'diff-gutter-del': item.line.type === 'del',
                }"
                >{{ item.line.type === "del" ? item.line.oldNum : item.line.newNum }}</span
              >
              <!-- 变更符号 -->
              <span
                class="inline-block w-5 text-center select-none flex-shrink-0 font-bold"
                :class="{
                  'text-green-500 diff-gutter-add': item.line.type === 'add',
                  'text-red-500 diff-gutter-del': item.line.type === 'del',
                }"
                >{{ item.line.type === "add" ? "+" : item.line.type === "del" ? "−" : " " }}</span
              >
              <!-- 内容区 -->
              <span
                class="flex-1 whitespace-pre-wrap break-all py-px"
                :class="{ 'line-through opacity-70': item.line.type === 'del' }"
              >
                <!-- 有 charDiff：字符级高亮 -->
                <template v-if="item.line.charDiff">
                  <span
                    v-for="(part, j) in charDiffParts(item.line)"
                    :key="j"
                    :class="{
                      'diff-char-del': part.op === 'removed',
                      'diff-char-add': part.op === 'added',
                    }"
                    >{{ part.text }}</span
                  >
                </template>
                <!-- 无 charDiff：纯文本 -->
                <template v-else>{{ item.line.text }}</template>
              </span>
            </div>
          </template>
        </div>

        <!-- ════ Split 视图（左右独立渲染，字符级高亮，空白行对齐） ════ -->
        <div v-else class="flex font-mono text-xs">
          <!-- 左侧（旧文本） -->
          <div class="flex-1 min-w-0 border-r border-base">
            <template v-for="(item, i) in diffCollapsed.lines" :key="'l' + i">
              <div
                v-if="item.kind === 'collapse'"
                class="px-4 py-0.5 text-faint text-center bg-base/50 border-b border-base select-none"
              >
                ⋯ {{ item.count }} 行 ⋯
              </div>
              <div
                v-else-if="item.line.type !== 'add'"
                class="flex items-stretch"
                :class="{ 'diff-line-del': item.line.type === 'del' }"
              >
                <span
                  class="inline-block w-12 text-right pr-2 select-none flex-shrink-0 text-faint"
                  :class="{ 'diff-gutter-del': item.line.type === 'del' }"
                  >{{ item.line.oldNum ?? "" }}</span
                >
                <span
                  class="flex-1 whitespace-pre-wrap break-all py-px"
                  :class="{ 'line-through opacity-70': item.line.type === 'del' }"
                >
                  <template v-if="item.line.charDiff && item.line.type === 'del'">
                    <span
                      v-for="(part, j) in charDiffParts(item.line)"
                      :key="j"
                      :class="{ 'diff-char-del': part.op === 'removed' }"
                      >{{ part.text }}</span
                    >
                  </template>
                  <template v-else>{{ item.line.text }}</template>
                </span>
              </div>
              <div v-else class="flex items-stretch diff-empty">
                <span class="inline-block w-12 pr-2 select-none flex-shrink-0">&nbsp;</span>
              </div>
            </template>
          </div>
          <!-- 右侧（新文本） -->
          <div class="flex-1 min-w-0">
            <template v-for="(item, i) in diffCollapsed.lines" :key="'r' + i">
              <div
                v-if="item.kind === 'collapse'"
                class="px-4 py-0.5 text-faint text-center bg-base/50 border-b border-base select-none"
              >
                ⋯ {{ item.count }} 行 ⋯
              </div>
              <div
                v-else-if="item.line.type !== 'del'"
                class="flex items-stretch"
                :class="{ 'diff-line-add': item.line.type === 'add' }"
              >
                <span
                  class="inline-block w-12 text-right pr-2 select-none flex-shrink-0 text-faint"
                  :class="{ 'diff-gutter-add': item.line.type === 'add' }"
                  >{{ item.line.newNum ?? "" }}</span
                >
                <span class="flex-1 whitespace-pre-wrap break-all py-px">
                  <template v-if="item.line.charDiff && item.line.type === 'add'">
                    <span
                      v-for="(part, j) in charDiffParts(item.line)"
                      :key="j"
                      :class="{ 'diff-char-add': part.op === 'added' }"
                      >{{ part.text }}</span
                    >
                  </template>
                  <template v-else>{{ item.line.text }}</template>
                </span>
              </div>
              <div v-else class="flex items-stretch diff-empty">
                <span class="inline-block w-12 pr-2 select-none flex-shrink-0">&nbsp;</span>
              </div>
            </template>
          </div>
        </div>
      </template>
    </div>
    <UndoToast :visible="undoVisible" :message="toastMessage" @undo="doUndo" />
  </div>
</template>
