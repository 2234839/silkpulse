/**
 * useUndoToast —— 清空操作的可撤销 toast
 *
 * 清空时暂存被清内容，展示 5s 内可「撤销」的 toast；
 * 超时或替换为新清空时丢弃暂存内容。
 */
import { ref, onUnmounted } from "vue";

/**
 * @param timeoutMs toast 存续时长（ms），默认 5000
 */
export function useUndoToast(timeoutMs = 5000) {
  /** toast 可见性 */
  const visible = ref(false);
  /** 被清空的暂存内容（撤销时回填） */
  let snapshot: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 清空时调用：暂存恢复回调并弹出 toast
   *
   * @param restore 执行撤销时的内容恢复回调
   * @param message toast 文案
   */
  function clearWithUndo(restore: () => void, message = "已清空") {
    snapshot = restore;
    toastMessage.value = message;
    visible.value = true;
    clearTimeout(timer);
    timer = setTimeout(dismiss, timeoutMs);
  }

  /** toast 文案 */
  const toastMessage = ref("");

  /** 执行撤销：回填内容并隐藏 toast */
  function undo() {
    snapshot?.();
    dismiss();
  }

  /** 丢弃暂存并隐藏 toast */
  function dismiss() {
    snapshot = null;
    visible.value = false;
    clearTimeout(timer);
  }

  onUnmounted(() => clearTimeout(timer));

  return { visible, toastMessage, clearWithUndo, undo, dismiss };
}
