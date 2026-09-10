/**
 * useCopyFlash —— 复制按钮的统一成功反馈
 *
 * 用法：const { copiedKey, copy } = useCopyFlash();
 * 按钮 @click="copy('my-key', text)"，文案 :class 判断 copiedKey === 'my-key'
 * 显示「✓ 已复制」，resetMs 后自动复原。
 */
import { ref, onUnmounted } from "vue";
import { copyText } from "../utils/clipboard";

export function useCopyFlash(resetMs = 1500) {
  /** 当前处于「已复制」状态的按钮 key（null = 无） */
  const copiedKey = ref<string | null>(null);
  /** 复原定时器句柄 */
  let timer: ReturnType<typeof setTimeout> | undefined;

  onUnmounted(() => clearTimeout(timer));

  /**
   * 复制文本并点亮对应按钮的反馈
   *
   * @param key 按钮唯一标识（同一按钮的多个实例用 index 拼进 key）
   * @param text 要复制的文本
   * @returns 是否复制成功
   */
  async function copy(key: string, text: string): Promise<boolean> {
    const ok = await copyText(text);
    copiedKey.value = ok ? key : null;
    clearTimeout(timer);
    if (ok) {
      timer = setTimeout(() => {
        copiedKey.value = null;
      }, resetMs);
    }
    return ok;
  }

  return { copiedKey, copy };
}
