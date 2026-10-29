/**
 * 元素诊断类组件的消息包（ElementPanel / ObjectInspector）
 */
export const elementEn = {
  elementPanel: {
    /** 顶部视图切换：DOM 树 */
    viewTree: "DOM tree",
    /** 顶部视图切换：布局预览 */
    viewPreview: "Layout",
    /** 顶部视图切换：实时画面 */
    viewScreen: "Screen",
    /** 树刷新按钮 */
    refresh: "Refresh",
    /** 通用加载中 */
    loading: "Loading...",
    /** 布局预览右上角的元素/视口摘要 */
    previewSummary: "{count} elements · {width}×{height}",
    /** filter 搜索框 placeholder */
    searchPlaceholder: "Search elements (tag/id/class/text)...",
    /** filter 搜索中 */
    searching: "Searching...",
    /** filter 无匹配 */
    noMatch: "No matching elements",
    /** filter 匹配计数 */
    matchCount: "{count} matches",
    /** 树为空 */
    empty: "No elements",
    /** 诊断加载中 */
    diagnosing: "Diagnosing...",
    /** 未选中元素时的占位提示 */
    clickToInspect: "Click an element to inspect",
    /** 悬浮诊断面板标题 */
    inspectTitle: "Element diagnostics",
    /** 截图按钮 title */
    screenshotTitle: "Capture this element",
    /** 截图进行中 */
    screenshotting: "Capturing...",
    /** 截图按钮 */
    screenshot: "Capture",
    /** 悬浮诊断面板关闭按钮 title */
    closePanelTitle: "Close diagnostics panel",
    /** 元素截图 img alt */
    screenshotAlt: "Element screenshot",
    /** 截图缩放提示 */
    zoomHint: "Click image to zoom in",
    /** 可见性诊断卡片标题 */
    visibilityTitle: "Visibility",
    /** 可见性：尺寸标签 */
    sizeLabel: "Size:",
    /** 可见性：在视口内标签 */
    inViewportLabel: "In viewport:",
    /** 在视口内：是 */
    yes: "✓ Yes",
    /** 在视口内：否 */
    no: "✗ No",
    /** 可见性：被遮挡标签 */
    coveredByLabel: "Covered by:",
    /** 值同步卡片标题 */
    valueSyncTitle: "Value sync",
    /** 值同步进行中 */
    syncing: "Syncing...",
    /** 值同步双向绑定标记 */
    twoWayBinding: "↔ Two-way binding",
    /** checkbox/radio 状态：已选中 */
    checked: "checked",
    /** checkbox/radio 状态：未选中 */
    unchecked: "unchecked",
    /** text/textarea 编辑占位 */
    valuePlaceholder: "Enter value...",
    /** 样式规则卡片标题 */
    stylesTitle: "Styles",
    /** 匹配规则计数 */
    rulesCount: "{count} rules",
    /** 匹配规则加载中 */
    loadingRules: "Fetching matched CSS rules...",
    /** 跨域规则警告 */
    crossOriginWarning: "⚠ Cross-origin, unreadable",
    /** 跨域样式表规则不可读提示 */
    crossOriginRuleHint: "Rules in cross-origin stylesheets cannot be read",
    /** 规则无属性 */
    noProps: "No properties",
    /** 继承属性分组标题 */
    inheritedTitle: "Inherited",
    /** 无匹配 CSS 规则空状态 */
    noMatchedRules: "No matched CSS rules",
    /** 计算样式卡片标题 */
    computedTitle: "Computed",
    /** 盒模型卡片标题 */
    boxModelTitle: "Box model",
    /** 祖先链卡片标题 */
    ancestorsTitle: "Ancestors",
    /** 布局预览快照加载中 */
    snapshotLoading: "Loading snapshot...",
    /** 布局预览快照不可用 */
    snapshotUnavailable: "Snapshot unavailable",
    /** 布局预览底部操作提示 */
    previewHint:
      "Click element → select (click again → parent) · Alt+click → select parent · 📷 capture selected element",
    /** 悬浮诊断面板关闭后重新打开按钮 */
    showDiagnostics: "📋 Show diagnostics",
    /** 一次性快照按钮 title */
    viewportSnapshotTitle: "Capture the remote page's current viewport (one-shot)",
    /** 一次性快照按钮 */
    snapshot: "Snapshot",
    /** 开始实时画面按钮 */
    startLive: "▶ Live screen",
    /** 停止实时画面按钮 */
    stopLive: "⏹ Stop live",
    /** 实时画面状态：共享中 */
    statusSharing: "Live",
    /** 实时画面状态：已停止 */
    statusStopped: "Stopped",
    /** 实时画面状态：出错 */
    statusError: "Error",
    /** 页面快照 img alt */
    pageSnapshotAlt: "Page snapshot",
    /** 画面模式空状态：快照引导 */
    emptySnapshotHint: 'Click "📸 Snapshot" to capture the current page',
    /** 画面模式空状态：实时画面引导 */
    emptyLiveHint: 'Or turn on "Live screen" to watch continuously',
    /** 快照放大 dialog 关闭按钮 title */
    close: "Close",
    /** 元素截图放大 img alt */
    screenshotZoomAlt: "Element screenshot (zoomed)",
  },

  objectInspector: {
    /** 右键菜单：展开全部子节点 */
    expandAll: "Expand all children",
    /** 右键菜单：收起全部子节点 */
    collapseAll: "Collapse all children",
    /** 右键菜单：复制 JSON */
    copyJson: "Copy JSON",
    /** 右键菜单：复制值 */
    copyValue: "Copy value",
    /** 右键菜单：复制 JSON 路径 */
    copyJsonPath: "Copy JSON path",
    /** 右键菜单：字号增大 */
    fontLarger: "Increase font size",
    /** 右键菜单：字号减小 */
    fontSmaller: "Decrease font size",
    /** 右键菜单：重置字号 */
    fontReset: "Reset font size",
    /** 复制失败 toast */
    copyFailed: "✗ Copy failed",
    /** 折叠容器的差异计数提示 */
    diffCount: "({count} diffs)",
    /** 分批渲染剩余条数提示 */
    moreRemaining: "… {count} more",
    /** 分批渲染：展开全部按钮 */
    showAll: "All",
  },
};

export const elementZh: typeof elementEn = {
  elementPanel: {
    viewTree: "DOM 树",
    viewPreview: "布局预览",
    viewScreen: "画面",
    refresh: "刷新",
    loading: "加载中...",
    previewSummary: "{count} 元素 · {width}×{height}",
    searchPlaceholder: "搜索元素 (tag/id/class/text)...",
    searching: "搜索中...",
    noMatch: "无匹配元素",
    matchCount: "{count} 个匹配",
    empty: "暂无元素",
    diagnosing: "诊断中...",
    clickToInspect: "点击元素查看诊断",
    inspectTitle: "元素诊断",
    screenshotTitle: "截取此元素",
    screenshotting: "截图中...",
    screenshot: "截图",
    closePanelTitle: "关闭诊断面板",
    screenshotAlt: "元素截图",
    zoomHint: "点击图片放大查看",
    visibilityTitle: "可见性",
    sizeLabel: "尺寸:",
    inViewportLabel: "在视口内:",
    yes: "✓ 是",
    no: "✗ 否",
    coveredByLabel: "被遮挡:",
    valueSyncTitle: "值同步",
    syncing: "同步中...",
    twoWayBinding: "↔ 双向绑定",
    checked: "已选中",
    unchecked: "未选中",
    valuePlaceholder: "输入值...",
    stylesTitle: "样式规则",
    rulesCount: "{count} 条规则",
    loadingRules: "获取匹配的 CSS 规则...",
    crossOriginWarning: "⚠ 跨域不可读",
    crossOriginRuleHint: "跨域样式表无法读取规则内容",
    noProps: "无属性",
    inheritedTitle: "继承属性",
    noMatchedRules: "无匹配的 CSS 规则",
    computedTitle: "计算样式",
    boxModelTitle: "盒模型",
    ancestorsTitle: "祖先链",
    snapshotLoading: "加载快照...",
    snapshotUnavailable: "快照不可用",
    previewHint:
      "点击元素 → 选中（再次点击 → 选父元素）· Alt+点击 → 直接选父元素 · 📷 截图选中元素",
    showDiagnostics: "📋 显示诊断",
    viewportSnapshotTitle: "截取远端页面当前视口（一次性）",
    snapshot: "快照",
    startLive: "▶ 实时画面",
    stopLive: "⏹ 停止实时",
    statusSharing: "实时中",
    statusStopped: "已停止",
    statusError: "出错",
    pageSnapshotAlt: "页面快照",
    emptySnapshotHint: "点击「📸 快照」截取当前页面",
    emptyLiveHint: "或开启「实时画面」持续查看",
    close: "关闭",
    screenshotZoomAlt: "元素截图（放大）",
  },

  objectInspector: {
    expandAll: "展开全部子节点",
    collapseAll: "收起全部子节点",
    copyJson: "复制 JSON",
    copyValue: "复制值",
    copyJsonPath: "复制 JSON 路径",
    fontLarger: "字号增大",
    fontSmaller: "字号减小",
    fontReset: "重置字号",
    copyFailed: "✗ 复制失败",
    diffCount: "({count} 处差异)",
    moreRemaining: "… 还有 {count} 条",
    showAll: "全部",
  },
};
