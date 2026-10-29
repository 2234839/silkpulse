/**
 * i18n 入口 —— 基于 vue-i18n 的全局国际化实例
 *
 * 语言解析优先级：localStorage > 浏览器语言（zh 开头）> 英文。
 * 切换语言时同步持久化到 localStorage，并更新 <html lang> 与 <title>。
 */
import { createI18n } from "vue-i18n";
import { messages } from "./messages/index";

/** 支持的语言列表（en 为兜底） */
export const locales = ["en", "zh"] as const;
/** 支持的语言类型 */
export type Locale = (typeof locales)[number];

const STORAGE_KEY = "silkpulse-locale";

/** 各语言对应的文档标题 */
const docTitle: Record<Locale, string> = {
  en: "silkpulse console",
  zh: "silkpulse 控制台",
};

/** 读取初始语言：localStorage > 浏览器语言 > 英文 */
function loadLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const hit = locales.find((l) => l === saved);
    if (hit) return hit;
  } catch {}
  if (navigator.language?.toLowerCase().startsWith("zh")) return "zh";
  return "en";
}

/** 全局 i18n 实例（composition 模式 + globalInjection，模板可直接用 $t / i18n-t） */
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: loadLocale(),
  fallbackLocale: "en",
  missingWarn: true,
  fallbackWarn: true,
  messages,
});

/** 把语言应用到 DOM：<html lang> 与 <title> */
function applyLocaleDoc(loc: Locale) {
  document.documentElement.lang = loc === "zh" ? "zh-CN" : "en";
  document.title = docTitle[loc];
}

/** 切换语言并持久化（模块初始化时也调用一次，同步 DOM 初始状态） */
export function setLocale(loc: Locale) {
  i18n.global.locale.value = loc;
  try {
    localStorage.setItem(STORAGE_KEY, loc);
  } catch {}
  applyLocaleDoc(loc);
}

// 模块加载即同步一次 DOM，保证首屏 lang/title 与检测到的语言一致
applyLocaleDoc(loadLocale());

/** 全局翻译函数：供非组件模块（composables / utils）使用；组件内优先用 useI18n() */
export const t = i18n.global.t;
