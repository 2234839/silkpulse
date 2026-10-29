/**
 * 列表面板类组件的消息包（DeviceList / InjectPanel / ErrorsPanel / FeaturePanel）
 */
export const listsEn = {
  deviceList: {
    /** 面板标题 */
    onlineDevices: "Online devices",
    /** 清理离线设备按钮 */
    clearOffline: "Clear offline",
    /** 清理按钮 title（非超管：全部离线设备） */
    clearOfflineAllTitle: "Delete all offline devices and their history",
    /** 清理按钮 title（超管：当前分组离线设备） */
    clearOfflineGroupTitle: "Delete all offline devices in this group and their history",
    /** 无项目归属的分组显示名 */
    ungrouped: "Ungrouped",
    /** 清理确认框里的当前范围称呼（非超管全量清理时） */
    currentScope: "Current scope",
    /** 删除单台设备确认框 */
    confirmDelete: 'Delete device "{name}"? Its logs and network records will be deleted as well.',
    /** 批量清理离线设备确认框 */
    confirmClearOffline:
      'Clear {count} offline devices in "{scope}"? Their logs and network records will be deleted as well.',
    /** 搜索框 placeholder */
    searchPlaceholder: "Search devices (title / URL / type)...",
    /** 离线徽章 */
    offline: "Offline",
    /** 离线徽章 title */
    offlineSince: "Offline since {time}",
    /** 编辑标签/备注按钮 title */
    editTagsTitle: "Edit tags / note",
    /** 删除设备按钮 title */
    deleteDeviceTitle: "Delete device and its history",
    /** 标签编辑输入框 placeholder */
    tagsPlaceholder: "Tags (comma-separated)",
    /** 备注编辑输入框 placeholder */
    notePlaceholder: "Note (optional)",
    /** 保存编辑 */
    save: "Save",
    /** 取消编辑 */
    cancel: "Cancel",
    /** 设备卡片上的错误计数 */
    errorCount: "{count} errors",
    /** 相对时间：一分钟内 */
    justNow: "just now",
    /** 相对时间：分钟 */
    minsAgo: "{n}m",
    /** 相对时间：小时 */
    hoursAgo: "{n}h",
    /** 相对时间：天 */
    daysAgo: "{n}d",
    /** 列表为空（超管视图） */
    empty: "No devices yet",
    /** 列表为空（项目/游客视图） */
    emptyOnline: "No online devices",
    /** 搜索无匹配 */
    noMatch: "No matching devices",
  },

  injectPanel: {
    /** Modal 头部标题 */
    modalTitle: "Connect a new device",
    /** Modal 关闭按钮 */
    close: "Close",
    /** 游客警示标题 */
    guestWarnTitle: "⚠️ Guest mode: this device is visible to everyone",
    /** 游客警示正文：第一段（接高亮「所有人可见」） */
    guestWarnPrefix:
      "Playground is a public project — page snapshots, console output and network traffic (including response bodies) of devices you connect ",
    /** 游客警示正文：高亮片段（数据所有人可见） */
    guestWarnVisibleToAll: "are visible to every visitor",
    /** 游客警示正文：两段高亮之间的衔接 */
    guestWarnMiddle: ". ",
    /** 游客警示正文：第二段高亮（切勿接敏感页面） */
    guestWarnNeverSensitive: "Never connect pages that hold login sessions or sensitive data",
    /** 游客警示正文：引导自建 Key 的前缀（接链接） */
    guestWarnLongTermPrefix: ". For long-term use, ",
    /** 游客警示正文：自建 Key 链接文案 */
    guestWarnCreateKey: "create your own project key",
    /** 游客警示正文：链接后的收尾 */
    guestWarnSuffix:
      " to get a private project only you can see (free, no sign-up, valid for 5 days).",
    /** 接入方式 Tab：Script 标签 */
    tabScript: "Script tag",
    /** 接入方式 Tab：IIFE */
    tabIife: "IIFE",
    /** 接入方式 Tab：Bookmarklet */
    tabBookmarklet: "Bookmarklet",
    /** 接入方式 Tab：Userscript */
    tabUserscript: "Userscript",
    /** 各接入方式适用场景：Script 标签 */
    scenarioScript: "Best for: projects where you can edit the source (your own site / app)",
    /** 各接入方式适用场景：IIFE */
    scenarioIife:
      "Best for: debugging a page on the fly — open the DevTools console, paste and hit Enter",
    /** 各接入方式适用场景：Bookmarklet */
    scenarioBookmarklet: "Best for: live sites you can't modify, one-off connections",
    /** 各接入方式适用场景：Userscript */
    scenarioUserscript:
      "Best for: long-term debugging of a site / strict-CSP sites (connect-src included); requires Tampermonkey or ScriptCat",
    /** 粘贴位置说明：Script 标签 */
    locationScript:
      "→ Paste into the target page's HTML (e.g. top of <head> or <body> in index.html); reconnects after redeploy/refresh",
    /** 粘贴位置说明：IIFE */
    locationIife:
      "→ Press F12 to open the target page's DevTools console, paste the code above and hit Enter (lost on page refresh)",
    /** 粘贴位置说明：Bookmarklet */
    locationBookmarklet:
      "→ Create a new bookmark and paste the code above as its URL; click the bookmark on any target page to inject",
    /** 粘贴位置说明：Userscript */
    locationUserscript:
      "→ Paste into a new Tampermonkey / ScriptCat script; it applies to all pages once saved. GM_addElement privileged injection bypasses CSP script-src, and the built-in GM bridge host carries all traffic over GM_xmlhttpRequest, so connect-src restrictions don't matter (requires Tampermonkey ≥ 4.10 or ScriptCat)",
    /** Alt 点选元素开关文案 */
    elementPickerLabel:
      'Enable "Alt element picker" — copy any element\'s location with one click and send it to AI for pinpoint fixes',
    /** Alt 点选元素开关 title */
    elementPickerTitle:
      "When enabled, Alt+click any element on the page opens a locator panel — copy the locator, prompt and snippet call in one click and send them to AI",
    /** 悬浮球开关文案 */
    floatingBallLabel:
      'Enable "floating ball" — live debug status at the page\'s bottom-right; drag it out to pick elements',
    /** 悬浮球开关 title */
    floatingBallTitle:
      "When enabled, a floating ball appears at the bottom-right of connected pages: live debug status; drag it to pick elements in sync with the console Element panel",
    /** 超管设备归属选择 label */
    ownerLabel: "Device project",
    /** 项目下拉默认选项：未分组 */
    ungroupedOption: "Ungrouped (global visibility)",
    /** 项目下拉选项里的停用后缀 */
    disabledSuffix: " · disabled",
    /** 接入代码未加载完成时的占位 */
    loading: "Loading...",
  },

  errorsPanel: {
    /** 时间范围筛选：全部 */
    rangeAll: "All time",
    /** 时间范围筛选：最近 1 小时 */
    range1h: "Last hour",
    /** 时间范围筛选：最近 10 分钟 */
    range10m: "Last 10 minutes",
    /** 滚动丢弃提示 title */
    droppedTitle:
      "The buffer for long sessions is full; the oldest entries have been evicted (new logs are unaffected)",
    /** 滚动丢弃提示正文 */
    dropped: "⚠ Oldest {count} entries evicted",
    /** 搜索框 placeholder */
    searchPlaceholder: "Search errors (message / stack / source location)",
    /** 复制全部按钮 */
    copyAll: "Copy all ({count})",
    /** 加载更早错误按钮 */
    loadEarlier: "↑ Load earlier errors ({count} more not rendered)",
    /** 复制单条映射后源码位置的按钮 */
    copyLocation: "Copy location",
    /** 复制源码位置按钮 title */
    copyLocationTitle: "Copy location {source}:{line}:{column}",
    /** 堆栈折叠摘要 */
    stack: "Stack",
    /** 复制文本里映射后源码位置行（name 为函数名，可能为空） */
    formatMapped: "  Mapped source: {source}:{line}:{column}{name}",
    /** 复制文本里原始位置行 */
    formatSource: "  Location: {source}:{line}:{column}",
    /** 列表为空 */
    empty: "No errors",
    /** 过滤后无匹配 */
    noMatch: "No matching errors",
  },

  featurePanel: {
    /** 分类显示名：CSS */
    catCss: "CSS features",
    /** 分类显示名：JS API */
    catJsApi: "JS APIs",
    /** 分类显示名：网络 */
    catNetwork: "Network",
    /** 分类显示名：媒体 */
    catMedia: "Media",
    /** 分类显示名：存储 */
    catStorage: "Storage",
    /** 分类显示名：设备信息 */
    catDevice: "Device info",
    /** 分类显示名：HTML 元素 */
    catElement: "HTML elements",
    /** 搜索框 placeholder */
    searchPlaceholder: "Search features (name / true / false)",
    /** 支持统计摘要 */
    supportSummary: "{supported}/{total} supported",
    /** 不支持计数后缀 */
    unsupportedCount: "· {count} unsupported",
    /** 只看不支持按钮 */
    onlyUnsupported: "Unsupported only",
    /** 只看不支持按钮（激活态） */
    onlyUnsupportedActive: "✗ Unsupported only",
    /** 按钮态：只看不支持的 title */
    onlyUnsupportedTitle: "Show only features unsupported by the current device",
    /** 刷新按钮 */
    refresh: "Refresh",
    /** 刷新进行中 */
    detecting: "Detecting...",
    /** 首次加载文案 */
    loading: "Detecting features on the target device...",
    /** 检测失败标题 */
    detectFailed: "Detection failed",
    /** 重试按钮 */
    retry: "Retry",
    /** MDN 链接 title */
    mdnTitle: "MDN docs",
    /** 搜索无匹配 */
    noMatch: "No matching features",
    /** 没有检测结果 */
    empty: "No results yet",
  },
};

export const listsZh: typeof listsEn = {
  deviceList: {
    onlineDevices: "在线设备",
    clearOffline: "清理离线",
    clearOfflineAllTitle: "删除全部离线设备及其历史数据",
    clearOfflineGroupTitle: "删除该分组全部离线设备及其历史数据",
    ungrouped: "未分组",
    currentScope: "当前范围",
    confirmDelete: "确定删除设备「{name}」？其日志/网络记录将一并清除。",
    confirmClearOffline: "确定清理「{scope}」的 {count} 台离线设备？其日志/网络记录将一并清除。",
    searchPlaceholder: "搜索设备（标题/URL/类型）...",
    offline: "离线",
    offlineSince: "离线于 {time}",
    editTagsTitle: "编辑标签/备注",
    deleteDeviceTitle: "删除设备及其历史数据",
    tagsPlaceholder: "标签（逗号分隔）",
    notePlaceholder: "备注（可选）",
    save: "保存",
    cancel: "取消",
    errorCount: "{count} 错误",
    justNow: "刚刚",
    minsAgo: "{n} 分钟",
    hoursAgo: "{n} 小时",
    daysAgo: "{n} 天",
    empty: "暂无设备",
    emptyOnline: "暂无在线设备",
    noMatch: "无匹配设备",
  },

  injectPanel: {
    modalTitle: "接入新设备",
    close: "关闭",
    guestWarnTitle: "⚠️ 游客模式：该设备对所有人可见",
    guestWarnPrefix:
      "Playground 是公共项目，你接入设备的页面快照、console、网络请求（含响应体）等数据",
    guestWarnVisibleToAll: "所有访客都能看到",
    guestWarnMiddle: "。",
    guestWarnNeverSensitive: "切勿接入有登录态或敏感信息的页面",
    guestWarnLongTermPrefix: "。长期使用请",
    guestWarnCreateKey: "创建我的项目 Key",
    guestWarnSuffix: "，获得仅自己可见的私有项目（免费免注册，5 天有效）。",
    tabScript: "Script 标签",
    tabIife: "IIFE 立即执行",
    tabBookmarklet: "Bookmarklet",
    tabUserscript: "Userscript",
    scenarioScript: "适合：能改源码的项目（自己的网站 / App）",
    scenarioIife: "适合：临时调试某个页面，F12 打开 console 粘贴即注入",
    scenarioBookmarklet: "适合：改不了源码的线上站，临时接入一次",
    scenarioUserscript:
      "适合：长期调试某个站 / 强 CSP 站（含 connect-src 限制），需 Tampermonkey 或脚本猫（ScriptCat）",
    locationScript:
      "→ 粘贴到目标页面的 HTML 里（如 index.html 的 <head> 或 <body> 顶部），重新部署/刷新即接入",
    locationIife: "→ F12 打开目标页面的 DevTools console，粘贴上面代码回车即注入（页面刷新后失效）",
    locationBookmarklet: "→ 复制后新建书签，URL 粘贴为上面的代码；在目标页面点这个书签即注入",
    locationUserscript:
      "→ 粘贴到 Tampermonkey / 脚本猫（ScriptCat）新建的脚本里，保存后自动在所有页面生效；GM_addElement 特权注入穿过 CSP script-src，内置 GM 桥接宿主用 GM_xmlhttpRequest 承载全部通信，connect-src 限制也不影响（需 Tampermonkey ≥ 4.10 或 ScriptCat）",
    elementPickerLabel:
      "开启「Alt 点选元素」—— 选中页面元素后一键复制定位信息，发给 AI 直接指哪改哪",
    elementPickerTitle:
      "开启后，页面里按住 Alt 点击任意元素会弹出定位信息面板，可一键复制定位 + 提示词 + 接入调用方法发给 AI",
    floatingBallLabel: "开启「悬浮球」—— 页面右下角实时展示调试状态，拖出可联动选元素",
    floatingBallTitle:
      "开启后，接入页面右下角出现悬浮球：实时展示调试状态，拖住可联动控制台 Element 面板选元素",
    ownerLabel: "设备归属",
    ungroupedOption: "未分组（全局可见）",
    disabledSuffix: " · 已停用",
    loading: "加载中...",
  },

  errorsPanel: {
    rangeAll: "全部",
    range1h: "最近 1 小时",
    range10m: "最近 10 分钟",
    droppedTitle: "长会话缓冲区已满，最早的记录已被滚动淘汰（新日志不受影响）",
    dropped: "⚠ 已滚动丢弃最早 {count} 条",
    searchPlaceholder: "搜索错误（message / 堆栈 / 源码位置）",
    copyAll: "复制全部 ({count})",
    loadEarlier: "↑ 加载更早错误（还有 {count} 条未渲染）",
    copyLocation: "复制位置",
    copyLocationTitle: "复制位置 {source}:{line}:{column}",
    stack: "堆栈",
    formatMapped: "  原始源码: {source}:{line}:{column}{name}",
    formatSource: "  位置: {source}:{line}:{column}",
    empty: "暂无错误",
    noMatch: "无匹配错误",
  },

  featurePanel: {
    catCss: "CSS 特性",
    catJsApi: "JS API",
    catNetwork: "网络能力",
    catMedia: "媒体能力",
    catStorage: "存储能力",
    catDevice: "设备信息",
    catElement: "HTML 元素",
    searchPlaceholder: "搜索特性（名称 / true / false）",
    supportSummary: "{supported}/{total} 支持",
    unsupportedCount: "· {count} 不支持",
    onlyUnsupported: "只看不支持",
    onlyUnsupportedActive: "✗ 只看不支持",
    onlyUnsupportedTitle: "只显示当前设备不支持的特性",
    refresh: "刷新",
    detecting: "检测中...",
    loading: "正在检测目标设备特性...",
    detectFailed: "检测失败",
    retry: "重试",
    mdnTitle: "MDN 文档",
    noMatch: "无匹配特性",
    empty: "暂无检测结果",
  },
};
