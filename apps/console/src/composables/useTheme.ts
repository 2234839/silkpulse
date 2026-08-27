/**
 * useTheme —— 亮/暗主题切换 hook
 *
 * 持久化到 localStorage，默认跟随系统偏好（prefers-color-scheme）。
 * 在 <html> 上 toggle .dark class，CSS 变量自动切换。
 */
import { ref, watch } from "vue";

type Theme = "light" | "dark";
const STORAGE_KEY = "silkpulse-theme";

const theme = ref<Theme>(loadTheme());

/** 读取初始主题：localStorage > 系统偏好 > 亮色 */
function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

/** 应用主题到 <html> */
function applyTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
}

/** 切换主题 */
function toggleTheme() {
  theme.value = theme.value === "dark" ? "light" : "dark";
}

/** 持久化 + 应用 */
watch(
  theme,
  (t) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {}
    applyTheme(t);
  },
  { immediate: true },
);

export function useTheme() {
  return { theme, toggleTheme };
}
