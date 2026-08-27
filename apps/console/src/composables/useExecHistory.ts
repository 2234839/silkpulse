/**
 * useExecHistory —— exec 执行历史 hook
 *
 * AI/开发者在 exec 面板反复试错诊断代码时，记录最近执行的代码片段，
 * 点击即可回填，避免重复输入。持久化到 localStorage，跨刷新保留。
 */
import { ref } from "vue";

/** 单条历史记录 */
interface ExecHistoryItem {
  /** 执行的代码 */
  code: string;
  /** 是否执行成功（用于 UI 标记） */
  ok: boolean;
  /** 时间戳 */
  time: number;
}

/** 最多保留的历史条数（避免 localStorage 膨胀） */
const MAX_ITEMS = 30;
const STORAGE_KEY = "silkpulse-exec-history";

/** 全局共享一份历史（同会话内多个组件实例共用） */
const history = ref<ExecHistoryItem[]>(loadHistory());

/** 从 localStorage 读取历史 */
function loadHistory(): ExecHistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch {
    return [];
  }
}

/** 持久化到 localStorage */
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.value));
  } catch {
    /** localStorage 满或禁用时静默 */
  }
}

/**
 * 记录一次执行
 *
 * 相同代码去重（移到最新），超过上限截断。
 */
function record(code: string, ok: boolean) {
  const trimmed = code.trim();
  if (!trimmed) return;
  /** 去重：移除已存在的相同代码 */
  const filtered = history.value.filter((h) => h.code !== trimmed);
  filtered.unshift({ code: trimmed, ok, time: Date.now() });
  history.value = filtered.slice(0, MAX_ITEMS);
  persist();
}

/** 清空全部历史 */
function clear() {
  history.value = [];
  persist();
}

/** 删除单条历史 */
function remove(code: string) {
  history.value = history.value.filter((h) => h.code !== code);
  persist();
}

export function useExecHistory() {
  return { history, record, clear, remove };
}
