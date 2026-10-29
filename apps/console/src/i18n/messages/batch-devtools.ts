/**
 * DevTools 面板与 blog 框架页的消息包
 */
export const devtoolsEn = {
  /** DevTools 面板（DevToolsPanel.vue） */
  devToolsPanel: {
    /** 框架探测绿点的 title */
    frameworkDetectedTitle: "Framework detected in the target page",
    /** 刷新按钮：刷新进行中的 title */
    refreshingTitle: "Fetching latest data…",
    /** 刷新按钮：常态 title */
    refreshTitle:
      "Fetch the latest component tree and data in place (keeps current expansion/selection). Pages built for production have no framework update pushes, so data won't update automatically — click to refresh when needed",
    /** 刷新按钮：刷新进行中文案 */
    refreshing: "Refreshing…",
    /** 刷新按钮：常态文案 */
    refresh: "Refresh",
    /** relay 链路已接通状态 */
    connected: "Connected",
    /** relay 链路握手中状态 */
    connecting: "Connecting…",
    /** 状态条：链路未通提示（{dock} 为插件显示名） */
    connectingTo:
      "Connecting to the {dock} DevTools backend of the target page… (requires the SilkPulse SDK injected in the target page and a {dock} app running)",
    /** 插件不支持标题（{dock} 为插件显示名） */
    unsupportedTitle: "This page doesn't support {dock} DevTools",
    /** 插件不支持：检测到其他框架时的提示（{detected} 为框架名列表） */
    unsupportedDetected: "The target page is a {detected} app — switch to the matching plugin",
    /** 插件不支持：未检测到任何框架时的提示 */
    unsupportedNone:
      "No Vue / React app detected in the target page (plain static pages or pages without a framework can't use DevTools)",
    /** 框架名列表为空时的占位词 */
    none: "none",
  },

  /** 页面快照面板（SnapshotPanel.vue） */
  snapshotPanel: {
    /** 快照搜索框占位 */
    searchPlaceholder: "Search snapshot (element name / idx / state token)",
    /** 过滤后行数统计（{count} 为行数；管道分隔单复数形式） */
    linesCount: "{count} line | {count} lines",
    /** 刷新快照按钮 */
    refresh: "Refresh",
    /** 快照加载中 */
    loading: "Loading...",
    /** 搜索无匹配行 */
    noMatch: "No matching lines",
  },

  /** blog 框架页（BlogHeader.vue / BlogList.vue / BlogPost.vue 共用） */
  blog: {
    /** 页头：返回控制台链接 title */
    consoleTitle: "Back to the debug console",
    /** 页头：返回控制台链接文案 */
    console: "🎯 Console",
    /** 阅读时长（{minutes} 为分钟数） */
    readingTime: "About {minutes} min",
    /** 列表页：站点介绍句的「AI 原生远程调试」前置片段 */
    introPrefix: "Practice notes on ",
    /** 列表页：站点介绍句的高亮片段 */
    introHighlight: "AI-native remote debugging",
    /** 列表页：站点介绍句的后置片段 */
    introSuffix:
      " — let AI agents directly view, diagnose, and operate web pages running on remote devices.",
    /** 列表页：外链帖子的来源标注（崮生为作者名保留原文） */
    externalLink: "WeChat official account “崮生” · Read original →",
    /** 列表页：二维码 alt */
    qrAlt: "Scan to read the original on your phone",
    /** 列表页：二维码下方提示 */
    qrHint: "Scan to read on your phone",
    /** 列表页：页脚品牌句 */
    footerBrand: "silkpulse — AI-native remote device debugger · ",
    /** 列表页：页脚打开控制台链接 */
    openConsole: "Open console",
    /** 详情页：返回列表链接 */
    allPosts: "← All posts",
    /** 详情页：打开控制台链接 */
    postOpenConsole: "Open silkpulse console",
    /** 详情页 404：标题 */
    notFoundTitle: "Post not found",
    /** 详情页 404：说明（{slug} 为路由参数） */
    notFound: 'No post found for slug "{slug}".',
    /** 详情页 404：返回列表链接 */
    backToList: "← Back to all posts",
  },
};

export const devtoolsZh: typeof devtoolsEn = {
  devToolsPanel: {
    frameworkDetectedTitle: "目标页检测到该框架",
    refreshingTitle: "正在拉取最新数据…",
    refreshTitle:
      "原地拉取最新组件树与数据（保留当前展开/选中状态）。生产构建的页面没有框架更新推送，数据不会自动更新，需要时点此刷新",
    refreshing: "刷新中…",
    refresh: "刷新",
    connected: "已连接",
    connecting: "连接中…",
    connectingTo:
      "正在连接目标页的 {dock} DevTools backend…（需要目标页注入了 SilkPulse SDK 且运行 {dock} 应用）",
    unsupportedTitle: "当前页面不支持 {dock} DevTools",
    unsupportedDetected: "目标页是 {detected} 应用，请切换到对应插件",
    unsupportedNone:
      "目标页未检测到 Vue / React 应用（纯静态页或未接入框架的页面无法使用 DevTools）",
    none: "无",
  },

  snapshotPanel: {
    searchPlaceholder: "搜索快照（元素名 / idx / 状态 token）",
    linesCount: "{count} 行 | {count} 行",
    refresh: "刷新",
    loading: "加载中...",
    noMatch: "无匹配行",
  },

  blog: {
    consoleTitle: "回到调试控制台",
    console: "🎯 控制台",
    readingTime: "约 {minutes} 分钟",
    introPrefix: "关于 ",
    introHighlight: "AI 原生远程调试",
    introSuffix: " 的实践笔记—— 让 AI agent 直接查看、诊断、操作运行在远程设备上的网页。",
    externalLink: "微信公众号「崮生」 · 阅读原文 →",
    qrAlt: "扫码在手机上阅读原文",
    qrHint: "手机扫码阅读",
    footerBrand: "silkpulse —— AI 原生的远程设备调试器 · ",
    openConsole: "打开控制台",
    allPosts: "← 所有文章",
    postOpenConsole: "打开 silkpulse 控制台",
    notFoundTitle: "文章不存在",
    notFound: "slug「{slug}」没有对应的帖子。",
    backToList: "← 返回文章列表",
  },
};
