/**
 * useLocale —— 语言切换 hook（配套 i18n/index.ts 的全局实例）
 *
 * 暴露当前语言与切换函数，供语言切换按钮使用；
 * i18n.global.locale 是 ref，切换后模板里的 $t 自动重渲染。
 */
import { useI18n } from "vue-i18n";
import { setLocale, type Locale } from "../i18n";

export function useLocale() {
  const { locale } = useI18n();
  return {
    /** 当前语言（'en' | 'zh'） */
    locale,
    /** 切换语言（内部已持久化 + 同步 <html lang>/<title>） */
    setLocale,
  };
}

/** 重新导出 Locale 类型，组件里 `lang in locales` 判断时用 */
export type { Locale };
