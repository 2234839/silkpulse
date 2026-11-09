declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

/** Vite ?raw 导入：以字符串形式获取文件内容 */
declare module "*?raw" {
  const content: string;
  export default content;
}

/**
 * Chrome Prompt API（Built-in AI / Gemini Nano）。低版本 TS lib.dom 未收录，这里补环境声明。
 * 本文件是环境声明脚本（无顶层 import/export），顶层声明自动并入全局。
 */
/** 能力查询结果：available 可用 / downloadable 需下载 / downloading 下载中 / unavailable 不可用 */
type AILanguageModelAvailability = "available" | "downloadable" | "downloading" | "unavailable";

/** 会话消息（system / user / assistant） */
type AILanguageModelPrompt = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** 一次已建立的本地模型会话 */
interface AILanguageModelSession {
  prompt(prompt: string, options?: { responseConstraint?: string; signal?: AbortSignal }): Promise<string>;
  promptStreaming(
    prompt: string,
    options?: { responseConstraint?: string; signal?: AbortSignal },
  ): Promise<ReadableStream<string>>;
  clone(options?: { signal?: AbortSignal }): Promise<AILanguageModelSession>;
  destroy(): void;
  readonly tokensSoFar: number;
  readonly tokensLeft: number;
  readonly topK: number;
  readonly temperature: number;
}

/** create() 选项 */
interface AILanguageModelCreateOptions {
  initialPrompts?: AILanguageModelPrompt[];
  temperature?: number;
  topK?: number;
  signal?: AbortSignal;
  /** 声明预期输入/输出形态，浏览器据此挑选量化变体（模型本身不可选，只有 Gemini Nano） */
  expectedInputs?: Array<{ type: "text"; languages?: string[]; plugins?: string[] }>;
  expectedOutputs?: Array<{ type: "text"; languages?: string[]; plugins?: string[] }>;
  /** 下载/加载进度回调；downloadprogress 事件的 loaded 是 0~1 小数 */
  monitor?(monitor: AILanguageModelMonitor): void;
}

/** 模型下载/加载进度监视器 */
interface AILanguageModelMonitor extends EventTarget {
  addEventListener(
    type: "downloadprogress",
    listener: (ev: { loaded: number }) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

/** LanguageModel 全局对象 */
interface Window {
  LanguageModel: {
    availability(): Promise<AILanguageModelAvailability>;
    create(options?: AILanguageModelCreateOptions): Promise<AILanguageModelSession>;
  };
}
