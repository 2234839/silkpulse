/**
 * 弹窗类组件的消息包（ProjectModal / AiContextModal / AgentPromptModal）
 *
 * modalsEn 是本包的类型基准：modalsZh 必须满足 `typeof modalsEn` 的结构，
 * 缺 key / 多 key / 类型不符都会在编译期报错。
 * 注意：不要用 as const，否则 zh 包会被要求逐字重复英文文案。
 */
export const modalsEn = {
  /** 项目管理弹窗（ProjectModal.vue，仅超管可用） */
  projectModal: {
    /** 弹窗标题 */
    title: "📁 Projects",
    /** 创建项目区块标题 */
    createTitle: "Create a new project",
    /** 项目名输入框占位 */
    namePlaceholder: "Project name",
    /** 描述输入框占位 */
    descPlaceholder: "Description (optional)",
    /** 创建按钮 */
    create: "Create",
    /** 新建密钥一次性展示警告 */
    keyShowOnceWarning: "⚠️ This key is shown only once — copy and save it now:",
    /** 已有项目区块标题（{count} 项目总数） */
    existingTitle: "Existing projects ({count})",
    /** 项目启用状态徽标 */
    statusEnabled: "Enabled",
    /** 项目禁用状态徽标 */
    statusDisabled: "Disabled",
    /** 启用操作按钮 */
    actionEnable: "Enable",
    /** 禁用操作按钮 */
    actionDisable: "Disable",
    /** 游客项目徽标文字 */
    guestBadge: "Guest",
    /** 游客项目剩余天数（{days} 天数） */
    guestDaysLeft: "{days}d left",
    /** 游客项目无过期时间时的固定天数说明 */
    guestDaysFixed: "5-day max",
    /** 游客徽标悬停提示（{time} 具体到期时间） */
    guestBadgeExpires: "auto-destroyed {time}",
    /** 游客徽标悬停提示（无过期时间时） */
    guestBadgeNoExpiry: "lives at most 5 days",
    /** 轮换密钥按钮悬停提示 */
    rotateTitle: "Regenerate the key (the old key stops working immediately)",
    /** 轮换密钥按钮 */
    rotate: "🔄 Rotate key",
    /** 删除按钮 */
    delete: "Delete",
    /** 项目列表为空提示 */
    empty: "No projects yet — create one to manage device keys",
    /** 操作失败兜底提示（{status} HTTP 状态码） */
    operationFailed: "Operation failed ({status})",
    /** 删除项目确认框（{name} 项目名） */
    deleteConfirm: 'Delete project "{name}"? The projectId of its devices will be cleared.',
  },

  /** AI 诊断上下文弹窗（AiContextModal.vue） */
  aiContextModal: {
    /** 弹窗标题 */
    title: "AI diagnostic context",
    /** 复制失败状态 */
    copyFailed: "Copy failed",
    /** 关闭按钮 */
    close: "Close",
    /** 诊断包 markdown 总标题 */
    diagTitle: "# SilkPulse diagnostic report",
    /** 环境 section 标题 */
    envSection: "## Environment",
    /** 环境条目：生成时间 */
    generatedAtLabel: "Generated at",
    /** 环境条目：设备标题 */
    deviceTitleLabel: "Device title",
    /** 环境条目：屏幕分辨率（视口） */
    screenLabel: "Screen (viewport)",
    /** 环境条目：设备类型 */
    deviceTypeLabel: "Device type",
    /** 最近错误 section 标题 */
    errorsSection: "## Recent errors",
    /** 列表为空的占位文案 */
    none: "(none)",
    /** 错误条目前缀标签 */
    errorLabel: "Error",
    /** 最近请求 section 标题 */
    networkSection: "## Recent requests",
    /** 失败请求的标记 */
    failedMark: " ⚠ failed",
    /** Storage 摘要 section 标题 */
    storageSection: "## Storage summary",
    /** Storage 不可用占位 */
    storageUnavailable: "(unavailable)",
    /** Storage 为空占位 */
    storageEmpty: "(empty)",
    /** 超长文本截断标记 */
    truncated: "…(truncated)",
    /** 组装中的加载提示 */
    building: "Building the diagnostic report...",
    /** section 勾选项：环境 */
    sectionEnv: "Environment",
    /** section 勾选项：错误 */
    sectionErrors: "Errors",
    /** section 勾选项：请求 */
    sectionNetwork: "Requests",
    /** 字符数统计（{count} 总字符数） */
    charCount: "{count} chars",
  },

  /** 接入 AI Agent 弹窗（AgentPromptModal.vue） */
  agentPromptModal: {
    /** 弹窗标题 */
    title: "🤖 Connect an AI agent",
    /** 弹窗副标题 */
    subtitle: "Pick an integration mode, copy the prompt and paste it into your AI agent",
    /** 复制提示词按钮 */
    copyPrompt: "📋 Copy prompt",
    /** 复制失败状态 */
    copyFailed: "Copy failed",
    /** 关闭按钮 */
    close: "Close",
    /** 渐进式加载 tab */
    lazyTab: "⚡ Lazy loading",
    /** 完整提示词 tab */
    fullTab: "📄 Full prompt",
    /** 无密钥时提示词里的占位符 */
    fallbackKey: "<your API key>",
    /** 游客提示前段（后接具体到期时间） */
    guestNoticePrefix: "🔑 You're on a guest temporary project (lives at most 5 days, ",
    /** 游客提示中无过期时间时的兜底词 */
    guestExpiresOn: "on expiry",
    /** 游客提示后段（前接具体到期时间，后接部署链接） */
    guestNoticeMiddle:
      "auto-destroyed). Once expired, the key in this prompt stops working and must be recreated. This is a guest limitation — for long-term needs, deploy your own instance: ",
    /** 游客提示里的部署链接文字 */
    guestNoticeLink: "Open source on GitHub — a star ⭐ is appreciated",
    /** 渐进式加载说明前段（后接加粗的系统提示词字样） */
    lazyTipPrefix: "💡 Paste this tiny prompt into the agent's ",
    /** 渐进式加载说明中被加粗的「系统提示词」 */
    systemPromptLabel: "system prompt",
    /** 渐进式加载说明后段（前接加粗字样） */
    lazyTipSuffix:
      ". The agent curls the full docs on demand whenever it needs remote debugging, costing no tokens otherwise.",
    /** 底部提示（lazy tab）前段：后接 curl 地址 code 片段 */
    lazyFooterPrefix: "🚀 The curl URL in the prompt points to ",
    /** 底部提示（lazy tab）后段：前接 curl 地址 code 片段 */
    lazyFooterSuffix: ", and the agent pulls the full API docs on demand.",
    /** 底部提示（full tab）前段：后接服务地址 code 片段 */
    fullFooterPrefix: "💡 The prompt embeds the server address ",
    /** 底部提示（full tab）后段：前接服务地址 code 片段 */
    fullFooterSuffix:
      " and an API key — the agent can list devices, search logs and run code directly over the HTTP API.",
  },
};

export const modalsZh: typeof modalsEn = {
  projectModal: {
    title: "📁 项目管理",
    createTitle: "创建新项目",
    namePlaceholder: "项目名称",
    descPlaceholder: "描述（可选）",
    create: "创建",
    keyShowOnceWarning: "⚠️ 密钥仅展示一次，请立即复制保存：",
    existingTitle: "已有项目 ({count})",
    statusEnabled: "启用",
    statusDisabled: "禁用",
    actionEnable: "启用",
    actionDisable: "禁用",
    guestBadge: "游客",
    guestDaysLeft: "剩 {days} 天",
    guestDaysFixed: "5 天限",
    guestBadgeExpires: "{time}自动销毁",
    guestBadgeNoExpiry: "最长存活 5 天",
    rotateTitle: "重新生成密钥（旧密钥立即失效）",
    rotate: "🔄 轮换密钥",
    delete: "删除",
    empty: "暂无项目，创建一个来管理设备密钥",
    operationFailed: "操作失败 ({status})",
    deleteConfirm: "确定删除项目「{name}」？关联设备的 projectId 将被清除。",
  },

  aiContextModal: {
    title: "AI 诊断上下文",
    copyFailed: "复制失败",
    close: "关闭",
    diagTitle: "# SilkPulse 诊断包",
    envSection: "## 环境",
    generatedAtLabel: "生成时间",
    deviceTitleLabel: "设备标题",
    screenLabel: "屏幕(视口)",
    deviceTypeLabel: "设备类型",
    errorsSection: "## 最近错误",
    none: "（无）",
    errorLabel: "错误",
    networkSection: "## 最近请求",
    failedMark: " ⚠ 失败",
    storageSection: "## Storage 摘要",
    storageUnavailable: "（不可用）",
    storageEmpty: "（空）",
    truncated: "…(截断)",
    building: "正在组装诊断包...",
    sectionEnv: "环境",
    sectionErrors: "错误",
    sectionNetwork: "请求",
    charCount: "{count} 字符",
  },

  agentPromptModal: {
    title: "🤖 接入 AI Agent",
    subtitle: "选择接入方式，复制提示词粘贴给你的 AI agent",
    copyPrompt: "📋 复制提示词",
    copyFailed: "复制失败",
    close: "关闭",
    lazyTab: "⚡ 渐进式加载",
    fullTab: "📄 完整提示词",
    fallbackKey: "<你的API密钥>",
    guestNoticePrefix: "🔑 你在使用游客临时项目（最长存活 5 天，",
    guestExpiresOn: "到期",
    guestNoticeMiddle:
      "自动销毁）。到期后此提示词中的 Key 失效，需重新创建。这是对游客的限制，有长期需要建议自己部署一份：",
    guestNoticeLink: "GitHub 开源，顺手求个 ⭐",
    lazyTipPrefix: "💡 将这段极短提示词写入 agent 的",
    systemPromptLabel: "系统提示词",
    lazyTipSuffix:
      "（system prompt）。 agent 会在需要远程调试时自动 curl 拉取完整文档，平时不占用 token。",
    lazyFooterPrefix: "🚀 提示词中的 curl 地址指向 ",
    lazyFooterSuffix: "，agent 按需拉取完整 API 文档。",
    fullFooterPrefix: "💡 提示词包含服务地址 ",
    fullFooterSuffix: " 和 API Key，agent 可直接通过 HTTP API 查看设备、搜索日志、执行代码。",
  },
};
