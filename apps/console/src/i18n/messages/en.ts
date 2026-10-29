/**
 * 英文消息包（i18n 基准包）
 *
 * en 是所有语言的类型基准：其他语言包必须满足 `typeof en` 的结构，
 * 缺 key / 多 key / 类型不符都会在编译期报错。
 * 注意：不要用 as const，否则 zh 包会被要求逐字重复英文文案。
 */
export const en = {
  common: {
    /** 通用「复制」按钮文案 */
    copy: "📋 Copy",
    /** 已复制状态 */
    copied: "✓ Copied",
    /** 通用网络错误提示 */
    networkError: "Network error. Please check the server connection.",
  },

  /** 登录鉴权页（AuthPage.vue） */
  auth: {
    /** 品牌徽标副标（悬丝诊脉的产品隐喻） */
    brandBadge: "Remote pulse diagnosis",
    /** 一句话定位主标题（两行） */
    taglineLine1: "AI-native",
    taglineLine2: "remote device debugger",
    /** 一句话定位描述段落 */
    positioning:
      "When QA reports “white screen on the test device” or “won't open on my phone”, developers can't attach local DevTools to a device far away. SilkPulse lets AI connect directly to the remote page — inspect the structure, read logs, run diagnostics, operate elements — closing the loop of “remote diagnosis → action → verification”.",
    /** 四张核心能力卡片 */
    cardXrayTitle: "Remote X-Ray",
    cardXrayDesc: "console / network / errors / DOM snapshots, penetrating shadow DOM + iframes",
    cardAiTitle: "AI Operation",
    cardAiDesc:
      "AI clicks, types, scrolls and takes screenshots on the remote page, just like a human",
    cardConcurrentTitle: "Concurrent Devices",
    cardConcurrentDesc:
      "Debug many devices at once; history survives reconnects with a ring buffer as backstop",
    cardZeroIntroTitle: "Zero-Intrusion Setup",
    cardZeroIntroDesc:
      "script tag / bookmarklet / userscript — works without touching your source code",
    /** GitHub 链接 title */
    githubTitle: "Open source on GitHub — a star means a lot ⭐",
    /** 底部接入方式列表：script 标签 */
    scriptTag: "Script tag",
    /** 登录区 */
    signInTitle: "Sign in to console",
    signInSubtitle: "Enter your key to access remote devices",
    keyPlaceholder: "Admin key or project key",
    signIn: "Sign in",
    signingIn: "Signing in...",
    invalidKey: "Invalid or expired key. Please check and try again.",
    guestUnavailable: "Guest mode is temporarily unavailable. Please try again later.",
    /** 游客区 */
    or: "or",
    guestPlayground: "Visit Playground as guest",
    guestExtras: "Guest extras",
    /** 游客自建项目说明（内联高亮拆成片段键，避免 i18n-t 槽位复杂性） */
    guestCreatePrefix: "Create a temporary project key that is ",
    guestYoursAlone: "yours alone",
    guestCreateMiddle: ". Devices are isolated from each other. ",
    guestLivesMax5Days: "lives at most 5 days",
    guestCreateSuffix: ", destroyed automatically on expiry.",
    guestNamePlaceholder: "Project name (optional)",
    randomNameTitle: "Generate another random project name",
    creating: "Creating...",
    createMyKey: "🔑 Create my key",
    createFailed: "Creation failed (possibly rate-limited: at most 5 per hour).",
    createdButLoginFailed:
      "Created successfully but sign-in failed. Paste the key into the sign-in box above and try again.",
    /** 一次性密钥展示 */
    keyShowOnceWarning: "⚠️ This is your project key — shown only once. Copy and save it now!",
    keyShowOnceHint:
      "It cannot be viewed again after this page is closed (the server stores only a hash). If lost, you must create a new one.",
    enterConsole: "🚀 Enter console",
    enterConsoleCopiedTitle: "Key copied — enter the console directly",
    enterConsoleNotCopiedTitle: "Not copied yet — save the key yourself after entering",
    /** 项目信息行 */
    projectInfo: 'Project "{name}" · auto-destroyed {expires} · Project ID: ',
    expiresDefault: "in 5 days",
    /** 底部密钥说明（内联强调拆成片段键） */
    keyScopeAdminLabel: "Admin key",
    keyScopeAdminRest: "can view all projects and devices",
    keyScopeProjectLabel: "Project key",
    keyScopeProjectRest: "can only view devices of its own project",
    keyStorageHint: "Keys are stored locally in your browser",
    /** 游客限制提示 */
    guestNotice:
      "🎮 Guest limitations: data travels over the public internet, projects live at most 5 days, destroyed automatically on expiry.",
    guestDeployLink:
      "For long-term needs, deploy your own instance (open source & free — and a star ⭐ is appreciated)",
  },

  /** 控制台主界面外壳（ConsoleApp.vue） */
  shell: {
    /** 顶部栏 */
    openDeviceList: "Open device list",
    subtitle: "Remote device debugging console",
    guestBadge: "🎮 Guest",
    guestBadgeTitle:
      "Guest mode · data is shared over the public internet; self-hosting is recommended",
    guestProjectBadge: "🔑 Temp project",
    guestProjectDays: "· {days}d",
    guestProjectBadgeTitle:
      "Guest project · lives at most 5 days, auto-destroyed {time}. For long-term needs, deploy your own (open source on GitHub)",
    guestProjectExpiresOn: "on expiry",
    connected: "Connected",
    disconnected: "Disconnected",
    /** 主题切换 */
    toLightTitle: "Switch to light theme",
    toDarkTitle: "Switch to dark theme",
    toLight: "☀️ Light",
    toDark: "🌙 Dark",
    /** 桌面端按钮 */
    githubTitle: "Open source on GitHub — a star means a lot ⭐",
    githubStar: "⭐ GitHub — give us a star",
    addDevice: "➕ Connect device",
    addDeviceTitle: "Three ways to connect a device to this console",
    projects: "📁 Projects",
    projectsTitle: "Manage projects and keys",
    generating: "Generating...",
    aiContext: "📋 AI context",
    toolbox: "🔧 Toolbox",
    toolboxTitle: "Web debug toolbox (no device selection needed)",
    blogTitle: "silkpulse blog — project updates & technical articles",
    agent: "🤖 Agent",
    agentTitle: "Copy a prompt to hand remote debugging to an AI agent",
    agentConnect: "🤖 Connect Agent",
    signOut: "🚪",
    signOutTitle: "Sign out",
    signOutMenu: "🚪 Sign out",
    /** 空状态 */
    emptySelectDevice: "Select a device on the left to view details",
    emptyAddDeviceTitle: "Connect a device",
    /** 首进控制台一次性密钥弹窗 */
    firstKeyTitle: "🔑 Your project key",
    firstKeyWarning: "Shown only once — copy and save it now!",
    firstKeyHint:
      "It cannot be viewed again after closing (the server stores only a hash). If lost, you must create a new project.",
    copyKey: "📋 Copy key",
    firstKeySaved: "Saved — enter console",
    /** 语言切换 */
    language: "中文",
    languageTitle: "切换到中文",
  },

  /** AI 诊断上下文（useAiContext.ts 生成的可复制文本，粘贴给 AI agent 用） */
  aiContext: {
    snapshotUnavailable: "(snapshot unavailable)",
    docTitle: "# silkpulse device diagnostic context",
    pageLine: "- Page: {title}",
    timeLine: "- Time: {time}",
    errorsHeader: "## Errors ({count})",
    none: "(none)",
    mappedSource: "  Original source: {source}:{line}:{col}{name}",
    sourceLocation: "  Location: {source}:{line}:{col}",
    snapshotHeader: "## Page snapshot",
    failedRequestsHeader: "## Failed network requests ({count})",
    slowRequestsHeader: "## Slowest requests top {count} (> {threshold}ms marked ⚠)",
    noRequests: "(no network requests)",
    logsHeader: "## Recent logs ({count})",
    hint: "Hint: use the silkpulse skill to run diagnostic code on this device, e.g.:",
  },

  /** 控制台输入自动补全（useAutocomplete.ts 的候选项说明） */
  autocomplete: {
    builtinGlobals: "Built-in global",
    silkpulseHelpers: "silkpulse helpers",
    remoteVariable: "Remote variable",
  },

  /** JSON 路径工具（utils/json-tools.ts 的错误与时长格式化） */
  jsonTools: {
    arrayOnly: "[] can only be applied to an array",
    pathNoValue: 'No value at path "{tok}"',
    seconds: "{n}s",
    minutes: "{n}m",
    hours: "{n}h",
    days: "{n}d",
  },

  /** 撤销 toast（useUndoToast.ts 的默认提示） */
  undoToast: {
    cleared: "Cleared",
  },

  /** DevTools dock（utils/devtools-docks.ts 的未注册插件错误） */
  devtoolsDocks: {
    unregisteredPlugin: "[DevToolsDock] Unregistered devtools plugin: {plugin}",
  },

  /** Console 日志面板（ConsolePanel.vue） */
  consolePanel: {
    allLevels: "All",
    searchPlaceholder: "Search logs...",
    droppedTitle:
      "Long-session buffer is full; the oldest logs were evicted (new logs are unaffected)",
    dropped: "⚠ {count} oldest logs evicted",
    copyAllTitle: "Copy all logs matching the current filter",
    copyAll: "Copy all ({count})",
    clearViewTitle: "Clear the current view (new logs will still appear)",
    clear: "Clear",
    loadOlder: "↑ Load older logs ({count} more not rendered)",
    copiedTitle: "✓ Copied",
    clickToCopy: "Click to copy",
    copy: "Copy",
    emptyAll: "No logs yet",
    emptyFiltered: "No matching logs",
    execResults: "Exec results",
    clearExecTitle: "Clear exec results",
    inputPlaceholder: "Type code · Enter to run · Shift+Enter newline · Tab complete · ↑↓ history",
    selectDeviceFirst: "Select a device first",
    probingContext: "Probing context...",
    running: "Running...",
    /** exec 返回失败但服务端未给错误信息时的兜底 */
    unknownError: "Unknown error",
  },

  /** 敏感文本模糊组件（SecretText.vue） */
  secretText: {
    /** 切换明文/模糊状态的悬停提示 */
    toggleTitle: "Click to show/hide plain text",
    /** 未揭示时的角标提示 */
    clickToView: "🔒 Click to reveal",
  },

  /** SSE 流式耗时单元格（SseDurationCell.vue） */
  sseDurationCell: {
    /** 进行中流式连接的悬停提示（{seconds} 为已持续秒数） */
    liveFor: "Streaming connection open for {seconds}s",
  },

  /** Web Debug 工具箱（ToolsPanel.vue） */
  toolsPanel: {
    subtitle: "Web Debug toolbox · pure frontend · data stays local · Alt+number switches tools",
    shortcutTitle: "Shortcut: Alt + 1~9 switches to the Nth visible tool",
    settingsBtn: "⚙️ Tool settings",
    settingsTitle: "Customize tool tabs: order and visibility",
    backToConsole: "← Console",
    settingsModalTitle: "⚙️ Tool tab settings",
    close: "Close",
    settingsHint: "Drag rows to reorder; uncheck to hide a tab.",
    dragToSort: "Drag to reorder",
    pinToTop: "Pin to top",
    resetDefaults: "Reset defaults",
    apply: "Apply",
    tabLog: "Logs",
    tabCodec: "Encode/Decode",
    tabColor: "Color",
    tabRegex: "Regex",
    tabEndpoints: "Test endpoints",
  },
};

/** en 包导出的消息类型（其他语言包的编译期基准） */
export type MessageSchema = typeof en;
