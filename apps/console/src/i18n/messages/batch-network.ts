/**
 * 网络面板的消息包（NetworkPanel.vue）
 */
export const networkEn = {
  networkPanel: {
    /** 搜索框 placeholder */
    searchPlaceholder: "Search requests (URL / method / status)",
    /** 类型筛选：全部 */
    kindAll: "All",
    /** 类型筛选：静态资源 */
    kindResource: "Resource",
    /** 资源分类筛选：全部 */
    catAll: "All",
    /** 资源分类筛选：JS */
    catJs: "JS",
    /** 资源分类筛选：CSS */
    catCss: "CSS",
    /** 资源分类筛选：图片 */
    catImg: "IMG",
    /** 资源分类筛选：字体 */
    catFont: "Font",
    /** 资源分类筛选：媒体 */
    catMedia: "Media",
    /** 资源分类筛选：其他 */
    catOther: "Other",
    /** 状态筛选：全部 */
    statusAll: "All",
    /** 状态筛选：成功（2xx-3xx） */
    statusSuccess: "Success",
    /** 状态筛选：失败（4xx-5xx / 未完成） */
    statusError: "Failed",
    /** 耗时排序小按钮（状态栏） */
    sortBtn: "Duration ↓",
    /** 耗时排序小按钮 title（未排序态） */
    sortOffTitle: "Sort the current list by duration descending",
    /** 耗时排序小按钮 title（降序态，点击取消） */
    sortDescResetTitle: "Duration descending — click to restore original order",
    /** 耗时表头 title（未排序态） */
    sortByDurationTitle: "Click to sort by duration (slowest first)",
    /** 耗时表头 title（降序态） */
    sortDescActiveTitle: "Duration descending (slowest on top)",
    /** 耗时表头 title（升序态） */
    sortAscActiveTitle: "Duration ascending",
    /** 导出全部按钮 */
    exportAll: "⬇ Export all",
    /** 导出全部按钮 title */
    exportAllTitle: "Export all filtered requests as JSON",
    /** 清空按钮 */
    clear: "🚫 Clear",
    /** 清空按钮 title */
    clearTitle: "Clear the current view (server buffer unaffected)",
    /** 表头：时间 */
    colTime: "Time",
    /** 表头：方法 */
    colMethod: "Method",
    /** 表头：状态 */
    colStatus: "Status",
    /** 表头：大小 */
    colSize: "Size",
    /** 表头：耗时 */
    colDuration: "Duration",
    /** 慢请求 title（threshold 为阈值毫秒数） */
    slowTitle: "Slow request (> {threshold}ms)",
    /** 列表为空 */
    empty: "No network requests yet",
    /** 过滤后无匹配 */
    noMatch: "No matching requests",
    /** 复制请求体按钮 */
    copyReqBody: "Copy request body",
    /** 复制请求体按钮 title */
    copyReqBodyTitle: "Copy the raw request body",
    /** 复制响应按钮 */
    copyRes: "Copy response",
    /** 复制响应按钮 title */
    copyResBodyTitle: "Copy the raw response body",
    /** 导出 JSON 按钮 */
    exportJson: "Export JSON",
    /** 导出 JSON 按钮 title */
    exportJsonTitle: "Export this request's full info as a JSON file",
    /** 复制为 cURL 按钮 */
    copyCurl: "Copy as cURL",
    /** 详情基本信息：时间 */
    detailTime: "Time:",
    /** 详情基本信息：方法 */
    detailMethod: "Method:",
    /** 详情基本信息：状态 */
    detailStatus: "Status:",
    /** 详情状态（资源加载无状态码） */
    statusUnknown: "Unknown",
    /** 详情基本信息：大小 */
    detailSize: "Size:",
    /** 详情基本信息：耗时 */
    detailDuration: "Duration:",
    /** 详情基本信息：类型 */
    detailKind: "Type:",
    /** 静态资源提示标题 */
    resourceNoticeTitle: "📦 Static resource load",
    /** 静态资源提示正文 */
    resourceNoticeBody:
      "SilkPulse cannot capture request headers or response bodies of static resource loads. Use the button to have the device re-fetch the URL and get the full response headers and body.",
    /** 重新请求进行中 */
    refetching: "Fetching...",
    /** 重新请求按钮 */
    refetch: "🔄 Re-fetch",
    /** 重新请求失败标题 */
    refetchFailed: "Re-fetch failed",
    /** 重新请求结果：响应头标题 */
    refetchResHeaders: "Response headers (re-fetched)",
    /** 重新请求结果：响应体标题 */
    refetchResBody: "Response body (re-fetched)",
    /** 重新请求结果图片 alt */
    refetchImageAlt: "Resource preview",
    /** 详情错误区标题 */
    errorLabel: "Error",
    /** WS 帧时间线标题 */
    wsTimeline: "Frame timeline",
    /** WS 帧计数（shown 已渲染 / total 总帧数） */
    framesCount: "({shown} / {total} frames)",
    /** WS 帧过滤框 placeholder */
    filterFramesPlaceholder: "🔍 Filter frame content...",
    /** Parser 编辑框 placeholder（WS 帧） */
    parserPlaceholderFrames:
      "// JS function body; data is the frame content string&#10;// e.g. return JSON.parse(data).msg",
    /** Parser 模板按钮 */
    templateBtn: "📋 Template",
    /** Parser 历史按钮 */
    historyBtn: "📚 History",
    /** Parser 执行按钮 */
    runBtn: "▶ Run",
    /** WS 无帧（连接已建立） */
    wsEmpty: "No frames yet (connection established, waiting for messages)",
    /** WS 过滤后无匹配帧 */
    wsNoMatch: "No matching frames",
    /** SSE 事件流标题 */
    sseTimeline: "SSE event stream",
    /** SSE 连接状态：连接中 */
    sseOpen: "● Open",
    /** SSE 连接状态：已关闭 */
    sseClosed: "○ Closed",
    /** SSE 事件计数（shown 已渲染 / total 事件总数） */
    sseCountEvents: "({shown} / {total} events)",
    /** SSE JSON 模式计数（shown 已渲染 / total 切分出的 JSON 总数） */
    sseCountJson: "({shown} / {total} JSON)",
    /** SSE 事件过滤框 placeholder */
    filterEventsPlaceholder: "🔍 Filter event content/type...",
    /** SSE JSON 模式开关 title */
    jsonModeTitle:
      "Enable when SSE returns consecutive JSON ({..}{..}.., one JSON may be split across events) — splits and displays by JSON value boundary",
    /** Parser 编辑框 placeholder（SSE 事件） */
    parserPlaceholderEvents:
      "// JS function body; data is the event data string&#10;// e.g. return JSON.parse(data).msg",
    /** JSON 模式下不完整尾段徽章 */
    pending: "⏳ Receiving",
    /** 不完整尾段徽章 title */
    pendingTitle: "JSON not yet complete, waiting for more data",
    /** SSE 无事件（连接已建立） */
    sseEventsEmpty: "No events yet (connection established, waiting for server push)",
    /** SSE JSON 模式无 JSON（连接已建立） */
    sseJsonEmpty: "No JSON yet (connection established, waiting for server push)",
    /** SSE 过滤后无匹配事件 */
    sseEventsNoMatch: "No matching events",
    /** SSE JSON 模式过滤后无匹配 */
    sseJsonNoMatch: "No matching JSON",
    /** 请求头区标题 */
    reqHeaders: "Request headers",
    /** 响应头区标题 */
    resHeaders: "Response headers",
    /** 请求体区标题 */
    reqBody: "Request body",
    /** 响应体区标题 */
    resBody: "Response body",
    /** 请求体截断提示（size 为格式化后的截断大小） */
    reqTruncated: "⚠ Request body too large, truncated ({size} / full content loaded on demand)",
    /** 加载进行中 */
    loading: "Loading...",
    /** 懒加载完整内容按钮 */
    loadFull: "📥 Load full content",
    /** 响应体图片预览 alt */
    resImageAlt: "Response preview",
    /** 响应体视图：预览 */
    preview: "Preview",
    /** 响应体视图：原始 */
    raw: "Raw",
    /** 二进制 info 模式无内容提示 */
    noRawContent: "No raw content (binary not read)",
    /** 响应体截断提示（size 为原始大小片段，可为空串） */
    resTruncated: "⚠ Response body too large, truncated{size}; full content loaded on demand",
    /** 响应体截断提示里的原始大小片段 */
    resTruncatedSize: " (original {kb}KB)",
    /** 无请求体/响应体提示 */
    noBodyHint:
      "No request/response body for this request (possibly a GET request or an incomplete response)",
    /** 未选中请求时的详情占位 */
    selectHint: "Click a request on the left to see details",
    /** exec 通道执行失败 */
    execFailed: "exec failed",
    /** exec 返回空结果 */
    execEmptyResult: "exec returned an empty result",
    /** 重新请求结果解析失败（raw 为原始返回片段） */
    parseFailed: "Failed to parse result: {raw}",
  },
};

export const networkZh: typeof networkEn = {
  networkPanel: {
    searchPlaceholder: "搜索请求（URL / 方法 / 状态码）",
    kindAll: "全部",
    kindResource: "资源",
    catAll: "全部",
    catJs: "JS",
    catCss: "CSS",
    catImg: "IMG",
    catFont: "字体",
    catMedia: "媒体",
    catOther: "其他",
    statusAll: "全部",
    statusSuccess: "成功",
    statusError: "失败",
    sortBtn: "耗时↓",
    sortOffTitle: "按耗时降序排列当前列表",
    sortDescResetTitle: "当前：耗时降序，点击取消恢复原序",
    sortByDurationTitle: "点击按耗时降序",
    sortDescActiveTitle: "当前：耗时降序（慢请求在上）",
    sortAscActiveTitle: "当前：耗时升序",
    exportAll: "⬇ 导出全部",
    exportAllTitle: "导出当前过滤后的全部请求为 JSON",
    clear: "🚫 清空",
    clearTitle: "清空当前视图（不影响服务端缓冲）",
    colTime: "时间",
    colMethod: "方法",
    colStatus: "状态",
    colSize: "大小",
    colDuration: "耗时",
    slowTitle: "慢请求（> {threshold}ms）",
    empty: "暂无网络请求",
    noMatch: "无匹配请求",
    copyReqBody: "复制请求体",
    copyReqBodyTitle: "复制请求体原始文本",
    copyRes: "复制响应",
    copyResBodyTitle: "复制响应体原始文本",
    exportJson: "导出 JSON",
    exportJsonTitle: "导出该请求完整信息为 JSON 文件",
    copyCurl: "复制为 cURL",
    detailTime: "时间：",
    detailMethod: "方法：",
    detailStatus: "状态：",
    statusUnknown: "未知",
    detailSize: "大小：",
    detailDuration: "耗时：",
    detailKind: "类型：",
    resourceNoticeTitle: "📦 静态资源加载",
    resourceNoticeBody:
      "SilkPulse 无法直接采集静态资源请求的请求头和响应体。点击右侧按钮可让设备重新 fetch 该 URL，获取完整的响应头和响应体。",
    refetching: "请求中...",
    refetch: "🔄 重新请求",
    refetchFailed: "重新请求失败",
    refetchResHeaders: "响应头（重新请求）",
    refetchResBody: "响应体（重新请求）",
    refetchImageAlt: "资源预览",
    errorLabel: "错误",
    wsTimeline: "帧时间线",
    framesCount: "({shown} / {total} 帧)",
    filterFramesPlaceholder: "🔍 过滤帧内容...",
    parserPlaceholderFrames:
      "// 输入 JS 函数体，参数 data 是帧内容字符串&#10;// 例: return JSON.parse(data).msg",
    templateBtn: "📋 模板",
    historyBtn: "📚 历史",
    runBtn: "▶ 执行",
    wsEmpty: "暂无帧（连接已建立，等待收发消息）",
    wsNoMatch: "无匹配帧",
    sseTimeline: "SSE 事件流",
    sseOpen: "● 连接中",
    sseClosed: "○ 已关闭",
    sseCountEvents: "({shown} / {total} 事件)",
    sseCountJson: "({shown} / {total} 个 JSON)",
    filterEventsPlaceholder: "🔍 过滤事件内容/类型...",
    jsonModeTitle:
      "SSE 返回连续 JSON（{..}{..}..，一个 JSON 可能拆多个 Event）时开启，按 JSON 值边界切分展示",
    parserPlaceholderEvents:
      "// 输入 JS 函数体，参数 data 是事件 data 字符串&#10;// 例: return JSON.parse(data).msg",
    pending: "⏳ 接收中",
    pendingTitle: "JSON 尚未接收完整，等待后续数据",
    sseEventsEmpty: "暂无事件（连接已建立，等待服务端推送）",
    sseJsonEmpty: "暂无 JSON（连接已建立，等待服务端推送）",
    sseEventsNoMatch: "无匹配事件",
    sseJsonNoMatch: "无匹配 JSON",
    reqHeaders: "请求头",
    resHeaders: "响应头",
    reqBody: "请求体",
    resBody: "响应体",
    reqTruncated: "⚠ 请求体过大已截断（{size} / 完整内容需懒加载）",
    loading: "加载中...",
    loadFull: "📥 加载完整内容",
    resImageAlt: "响应预览",
    preview: "预览",
    raw: "原始",
    noRawContent: "无原始内容（二进制未读取）",
    resTruncated: "⚠ 响应体过大已截断{size}，完整内容需懒加载",
    resTruncatedSize: "（原始 {kb}KB）",
    noBodyHint: "此请求无请求体/响应体（可能是 GET 请求或响应未完成）",
    selectHint: "点击左侧请求查看详情",
    execFailed: "exec 执行失败",
    execEmptyResult: "exec 返回空结果",
    parseFailed: "结果解析失败: {raw}",
  },
};
