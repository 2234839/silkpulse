/**
 * 消息包合并 —— 把基准包与各分包合并为完整语言包
 *
 * 纯数据模块：不依赖 DOM，可被 node 脚本（scripts/i18n-check.mjs）直接导入校验。
 * 新增分包时在这里 spread 合入，i18n-check 会检测「分包已存在但未合入」的漏合。
 */
import { en, type MessageSchema } from "./en";
import { zh } from "./zh";
import { devtoolsEn, devtoolsZh } from "./batch-devtools";
import { listsEn, listsZh } from "./batch-lists";
import { modalsEn, modalsZh } from "./batch-modals";
import { networkEn, networkZh } from "./batch-network";
import { elementEn, elementZh } from "./batch-element";
import { storageEn, storageZh } from "./batch-storage";
import { toolsEn, toolsZh } from "./batch-tools";

/**
 * 完整语言包
 *
 * en 侧的展开顺序无关紧要（分包命名空间互不重叠）；
 * zh 侧每个分包都被 `typeof xEn` 约束，结构编译期对齐。
 */
export const messages = {
  en: {
    ...en,
    ...devtoolsEn,
    ...listsEn,
    ...modalsEn,
    ...networkEn,
    ...elementEn,
    ...storageEn,
    ...toolsEn,
  },
  zh: {
    ...zh,
    ...devtoolsZh,
    ...listsZh,
    ...modalsZh,
    ...networkZh,
    ...elementZh,
    ...storageZh,
    ...toolsZh,
  },
};

/** en 基准包与全部分包合并后的完整消息类型（i18n 实例的 schema） */
export type FullMessageSchema = typeof messages.en & MessageSchema;
