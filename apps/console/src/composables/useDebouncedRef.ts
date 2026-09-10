/**
 * useDebouncedRef —— 通用输入防抖只读 ref
 *
 * 大文本粘贴时避免每次键入都触发重量级 computed（JSON 解析 / LCS diff 等）卡死输入框。
 */
import { ref, watch, onUnmounted, type Ref } from "vue";

/**
 * @param source 源 ref
 * @param ms 防抖毫秒数
 */
export function useDebouncedRef<T>(source: Ref<T>, ms: number): Readonly<Ref<T>> {
  const debounced = ref(source.value) as Ref<T>;
  let t: ReturnType<typeof setTimeout> | undefined;
  watch(source, (v) => {
    clearTimeout(t);
    t = setTimeout(() => (debounced.value = v), ms);
  });
  onUnmounted(() => clearTimeout(t));
  return debounced;
}
