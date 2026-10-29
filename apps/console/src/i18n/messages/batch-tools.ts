/**
 * 工具组件组（components/tools/，颜色工具除外）的消息包
 *
 * 命名空间与组件一一对应：diffTool / logTool / codecTool / endpointTool /
 * jsonTool / timestampTool / regexTool / urlTool / cookieTool / jwtTool，
 * 另有 toolCommon 存放 UndoToast / ToolSplitLayout 及跨工具复用的零散文案。
 */
export const toolsEn = {
  /** 工具页通用零散文案（UndoToast / ToolSplitLayout / 拖拽手柄 title） */
  toolCommon: {
    /** 撤销按钮（UndoToast） */
    undo: "Undo",
    /** 分栏拖拽手柄 title（ToolSplitLayout） */
    dragSplitTitle: "Drag to adjust the split ratio",
    /** 输入区高度拖拽手柄 title（DiffTool / CodecTool） */
    dragHeightTitle: "Drag to adjust input height",
  },

  /** DiffTool —— 文本/JSON Diff 对比 */
  diffTool: {
    /** A 输入框 label */
    labelA: "Text A (expected)",
    /** B 输入框 label */
    labelB: "Text B (actual)",
    /** 对象树视图左窗格标题 */
    paneA: "A (expected)",
    /** 对象树视图右窗格标题 */
    paneB: "B (actual)",
    /** A/B 宽度拖拽手柄 title */
    dragRatioTitle: "Drag to adjust the A/B width ratio",
    /** JSON 格式化开关 */
    jsonFormat: "Format JSON",
    /** Key 排序开关 */
    sortKeys: "Sort keys",
    /** Key 排序开关 title */
    sortKeysTitle:
      "Recursively sort object keys before comparing; differences in key order alone no longer count as changes",
    /** 字符级高亮开关 */
    charLevel: "Char-level highlight",
    /** 折叠相同行开关 */
    collapseSame: "Collapse unchanged",
    /** 同步滚动开关 */
    syncScroll: "Sync scroll",
    /** 同步滚动开关 title */
    syncScrollTitle: "Scrolling one object tree scrolls the other proportionally",
    /** 同步展开开关 */
    syncExpand: "Sync expand",
    /** 同步展开开关 title */
    syncExpandTitle:
      "Expanding/collapsing a node expands/collapses the node at the same path on the other side",
    /** 交换按钮 */
    swap: "⇄ Swap",
    /** 清空按钮 */
    clear: "Clear",
    /** 视图切换：合并 */
    viewInline: "Inline",
    /** 视图切换：并排 */
    viewSplit: "Split",
    /** 视图切换：对象树 */
    viewObject: "Object",
    /** 自动对象开关 title */
    autoObjectTitle:
      "Auto object mode: switch to the object view automatically whenever both sides parse as JSON",
    /** 对象视图按钮 title */
    viewObjectTitle: "Render both sides side by side with the JSON panel's Object renderer",
    /** 折叠省略行数提示 */
    hiddenLines: "{count} lines hidden",
    /** 解析耗时 title */
    parseMsTitle: "JSON parse + format time",
    /** 解析耗时展示 */
    parseMs: "Parse {ms}ms",
    /** 渲染耗时 title */
    renderMsTitle: "Object tree render time (DOM update + paint)",
    /** 渲染耗时展示 */
    renderMs: "Render {ms}ms",
    /** 对象树搜索框 placeholder */
    searchNodes: "Search nodes...",
    /** 清空撤销 toast 文案 */
    clearedBoth: "Cleared both inputs",
    /** 两侧完全一致提示 */
    identical: "✅ Identical",
    /** 空输入引导文案 */
    inputHint: "Enter text on both sides to compare...",
    /** inline 视图折叠指示器 */
    collapsedInline: "⋯ {count} unchanged lines ⋯",
    /** split 视图折叠指示器 */
    collapsedSplit: "⋯ {count} lines ⋯",
  },

  /** LogTool —— 日志/流数据可视化查看器 */
  logTool: {
    /** 输入框 label */
    inputLabel: "Log input",
    /** 输入框 placeholder */
    inputPlaceholder:
      'event: message\ndata: {"msg":"hello"}\n\nOr paste raw log text / terminal ANSI output directly',
    /** SSE 示例按钮 */
    sampleSse: "SSE sample",
    /** JSONL 示例按钮 */
    sampleJsonl: "JSONL sample",
    /** ANSI 示例按钮 */
    sampleAnsi: "ANSI sample",
    /** 事件条数后缀 */
    count: "{count} items",
    /** 过滤器开关按钮 */
    filterBtn: "🔽 Filter",
    /** 映射器开关按钮 */
    mapperBtn: "⚡ Mapper",
    /** 控制符可视化开关 */
    controlChars: "Control chars",
    /** 过滤器面板标题 */
    filterTitle: "Filter",
    /** 过滤器正则模式开关 */
    regexToggle: "Regex",
    /** 过滤器纯文本模式 placeholder */
    filterTextPlaceholder: "Keyword contains match...",
    /** 映射器面板标题 */
    mapperTitle: "Mapper",
    /** 清除映射器按钮 */
    clearParser: "Clear",
    /** 映射器代码框 placeholder */
    mapperPlaceholder:
      "// `data` is the raw entry; return the mapped display value\n// e.g. return JSON.parse(data).msg",
    /** 空输入引导文案 */
    emptyInput: "Paste log data to parse...",
    /** 过滤后无匹配 */
    noMatch: "No matches",
  },

  /** CodecTool —— 编解码/解析工具集 */
  codecTool: {
    /** 类别页签：编解码 */
    kindCodec: "Encode / Decode",
    /** 类别页签：JWT 解码 */
    kindJwt: "JWT decode",
    /** 类别页签：URL 解析 */
    kindUrl: "URL parse",
    /** 类别页签：Cookie 解析 */
    kindCookie: "Cookie parse",
    /** 类别页签：时间戳 */
    kindTimestamp: "⏰ Timestamp",
    /** Auto 模式检测结果（当前为编码方向） */
    detectedEncode: "({mode} · encode)",
    /** Auto 模式检测结果（当前为解码方向） */
    detectedDecode: "({mode} · decode)",
    /** 原文框 label */
    plainLabel: "Plain text",
    /** 编码结果框 label */
    encodedLabel: "Encoded result",
    /** 数据源徽章 */
    sourceBadge: "(source)",
    /** 字符计数后缀 */
    charCount: "{count} chars",
    /** 清空按钮 */
    clear: "Clear",
    /** 复制原文按钮 */
    copyPlain: "📋 Copy plain",
    /** 复制编码结果按钮 */
    copyEncoded: "📋 Copy encoded",
    /** 数据源说明（框尾常驻灰字） */
    sourceHint: "Whichever box you edit becomes the data source",
    /** 编码方向无变化提示 */
    noChangeEncode: "Input is already encoded; encoding again changes nothing",
    /** 解码方向无变化提示 */
    noChangeDecode: "No change after decoding as {mode} (the input may not be in that encoding)",
    /** 清空撤销 toast 文案 */
    cleared: "Cleared input",
  },

  /** EndpointTool —— 服务端测试端点速查 */
  endpointTool: {
    /** delay-test 卡片标题 */
    delayTitle: "⏱️ Delayed JS endpoint",
    /** delay-test 说明前段（接 <code>&lt;script src&gt;</code> 标记） */
    delayDescA:
      "Generates a JS URL that responds after a delay of N seconds (no auth required). Use the URL as ",
    /** delay-test 说明后段（接在 script 标记之后） */
    delayDescB:
      " or a fetch target to verify slow requests, loading placeholders and the SDK's network capture. The server prints a log when each request arrives and completes.",
    /** 文件名输入 label */
    fileNameLabel: "File name",
    /** 延迟秒数输入 label */
    delayLabel: "Delay (seconds)",
    /** 复制按钮 */
    copy: "Copy",
    /** 打开按钮 */
    open: "Open",
    /** delay-test 卡片底部提示 */
    delayHint:
      "Seconds 0–300; non-ASCII file names are URL-encoded automatically and shown decoded in the server logs.",
    /** 固定端点卡片标题 */
    fixedTitle: "🧪 Other fixed endpoints",
    /** /sse-test 说明 */
    sseDesc:
      "SSE streaming endpoint: pushes 5 events (with event/id/data) at 500ms intervals, then closes. Verify EventSource and the SDK's SSE capture.",
    /** /test-fixtures/crash.js 说明 */
    crashDesc:
      "A minified script that throws on load, plus a source map (.map). Verify source-map resolution from error stacks back to crash.ts source locations.",
  },

  /** JsonTool —— JSON 可视化 + JQ 过滤 */
  jsonTool: {
    /** 输入框 label */
    inputLabel: "Input",
    /** 操作按钮：格式化 */
    format: "Format",
    /** 操作按钮：压缩 */
    minify: "Minify",
    /** 操作按钮：转义 */
    escape: "Escape",
    /** 操作按钮：反转义 */
    unescape: "Unescape",
    /** JQ 过滤输入框 placeholder */
    jqPlaceholder: "JQ filter (e.g. .items[].msg)",
    /** 提示：JQ 语法（默认模式） */
    hintJq: "Syntax: .key gets a field, .arr[] iterates an array, .a.b is a nested path",
    /** 提示：JSONC 模式 */
    hintJsonc: "JSONC: single/multi-line comments and trailing commas",
    /** 提示：JSON5 模式 */
    hintJson5:
      "JSON5: comments, single quotes, unquoted keys, trailing commas, hexadecimal numbers",
    /** JSON 解析失败错误前缀（message 为原始异常信息） */
    parseFailed: "JSON parse failed: {message}",
    /** 反转义时结果非字符串错误 */
    unescapeNotString: "JSON parse failed: the result is not a string, cannot unescape",
    /** 结果区 label */
    resultLabel: "Visualized result",
    /** 树内搜索框 placeholder */
    searchNodes: "Search nodes...",
    /** 空输入引导文案 */
    emptyInput: "Enter JSON to render...",
  },

  /** TimestampTool —— 时间戳 ↔ 人类时间双向转换 */
  timestampTool: {
    /** 时间戳 → 人类时间区块 label */
    tsToDate: "Timestamp → human time",
    /** 人类时间 → 时间戳区块 label */
    dateToTs: "Human time → timestamp",
    /** 「现在」按钮 */
    now: "Now",
    /** 时间戳输入框 placeholder */
    tsPlaceholder: "1691563200000 (ms) or 1691563200 (s)",
    /** 相对时间行 label */
    relative: "Relative",
    /** 相对时间：过去（duration 为 humanDuration 的产物，复用 jsonTools.* 键） */
    relAgo: "{duration} ago",
    /** 相对时间：未来 */
    relLater: "in {duration}",
    /** 时间戳输入非数字错误 */
    invalidTs: '"{raw}" is not a valid numeric timestamp',
    /** 时间戳超出范围错误 */
    outOfRange: '"{raw}" is out of the representable time range',
    /** 日期解析失败错误 */
    invalidDate: '"{raw}" cannot be parsed as a date',
  },

  /** RegexTool —— 正则测试器 */
  regexTool: {
    /** 正则输入 label */
    patternLabel: "Regular expression",
    /** ReDoS 安全提示 title */
    redosTitle:
      "Safety note: for regexes from untrusted sources, run a ReDoS check first — nested quantifiers (a+)+, (a|a)* and overlapping alternations (a|ab)* can trigger catastrophic backtracking. This page has 250ms input debounce and a 500-match cap as backstop, but the browser main thread can still be blocked for seconds by long backtracking. Pre-check with recheck (https://makenowjust-labs.github.io/recheck/) or Node's re2 package.",
    /** 测试文本 label */
    testTextLabel: "Test text",
    /** 替换输入 label */
    replaceLabel: "Replace with (optional)",
    /** 匹配结果 label */
    matchesLabel: "Matches",
    /** 匹配条数后缀 */
    matchCount: "({count})",
    /** 单条匹配序号 */
    matchN: "Match {n}",
    /** 替换结果标题 */
    replaceResult: "Replace result",
    /** 空输入引导文案 */
    emptyInput: "Enter a regex and text to match...",
  },

  /** UrlTool —— URL 解析器 */
  urlTool: {
    /** port 为空时的占位 */
    defaultPort: "(default)",
    /** hash 为空时的占位 */
    emptyHash: "(empty)",
    /** URL 非法提示 */
    invalid: "⚠ Cannot be parsed as a URL",
    /** 复制按钮 */
    copy: "Copy",
    /** Query 参数表标题 */
    queryParams: "Query params",
    /** 空输入引导文案 */
    emptyInput: "Paste a URL to parse...",
  },

  /** CookieTool —— Cookie 解析器 */
  cookieTool: {
    /** 输入框 label */
    inputLabel: "Cookie (document.cookie or Set-Cookie header, auto-detected)",
    /** 输入框 placeholder */
    placeholder:
      "a=1; b=%E4%B8%AD\nor one Set-Cookie per line:\ntoken=abc123; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT; SameSite=Lax",
    /** 条数与格式摘要 */
    summary: "{count} entries · format: {format}",
    /** 复制按钮 */
    copy: "Copy",
    /** 已过期徽章 */
    expired: "Expired",
    /** 未过期徽章 */
    valid: "Valid",
    /** 空输入引导文案 */
    emptyInput: "Paste cookies to parse...",
  },

  /** JwtTool —— JWT 解码器 */
  jwtTool: {
    /** token 已过期提示（time 为过期时刻的本地时间） */
    expired: "⏰ Token expired ({time})",
    /** token 有效期提示 */
    validUntil: "✅ Valid until: {time}",
    /** 空输入引导文案 */
    emptyInput: "Paste a JWT token to decode...",
  },
};

export const toolsZh: typeof toolsEn = {
  toolCommon: {
    undo: "撤销",
    dragSplitTitle: "拖拽调整分栏比例",
    dragHeightTitle: "拖拽调整输入区高度",
  },

  diffTool: {
    labelA: "文本 A（期望）",
    labelB: "文本 B（实际）",
    paneA: "A（期望）",
    paneB: "B（实际）",
    dragRatioTitle: "拖拽调整两侧占比",
    jsonFormat: "JSON 格式化",
    sortKeys: "Key 排序",
    sortKeysTitle: "递归排序 object 的 key 后再对比，key 顺序不同将不再误报",
    charLevel: "字符级高亮",
    collapseSame: "折叠相同行",
    syncScroll: "同步滚动",
    syncScrollTitle: "滚动一侧的对象树，另一侧按比例跟随滚动",
    syncExpand: "同步展开",
    syncExpandTitle: "展开/折叠一侧节点时，另一侧同路径节点跟随展开/折叠",
    swap: "⇄ 交换",
    clear: "清空",
    viewInline: "合并",
    viewSplit: "并排",
    viewObject: "对象",
    autoObjectTitle: "自动对象模式：开启后，只要两侧都能解析为 JSON，就自动切换到对象视图",
    viewObjectTitle: "用 JSON 面板的 Object 渲染器并排展示两侧结构",
    hiddenLines: "省略 {count} 行",
    parseMsTitle: "JSON 解析 + 格式化耗时",
    parseMs: "解析 {ms}ms",
    renderMsTitle: "对象树渲染耗时（DOM 更新 + 绘制）",
    renderMs: "渲染 {ms}ms",
    searchNodes: "搜索节点...",
    clearedBoth: "已清空两侧输入",
    identical: "✅ 完全一致",
    inputHint: "输入两段文本后自动对比...",
    collapsedInline: "⋯ {count} 行未变化 ⋯",
    collapsedSplit: "⋯ {count} 行 ⋯",
  },

  logTool: {
    inputLabel: "日志输入",
    inputPlaceholder:
      'event: message\ndata: {"msg":"hello"}\n\n或直接粘贴日志文本 / 终端 ANSI 彩色输出',
    sampleSse: "SSE 示例",
    sampleJsonl: "JSONL 示例",
    sampleAnsi: "ANSI 示例",
    count: "{count} 条",
    filterBtn: "🔽 过滤器",
    mapperBtn: "⚡ 映射器",
    controlChars: "控制符",
    filterTitle: "过滤器 Filter",
    regexToggle: "正则",
    filterTextPlaceholder: "关键词包含匹配...",
    mapperTitle: "映射器 Mapper",
    clearParser: "清除",
    mapperPlaceholder: "// 参数 data，返回映射后的展示值\n// 例: return JSON.parse(data).msg",
    emptyInput: "粘贴日志数据后自动解析...",
    noMatch: "无匹配项",
  },

  codecTool: {
    kindCodec: "编解码",
    kindJwt: "JWT 解码",
    kindUrl: "URL 解析",
    kindCookie: "Cookie 解析",
    kindTimestamp: "⏰ 时间戳",
    detectedEncode: "（{mode}·编码）",
    detectedDecode: "（{mode}·解码）",
    plainLabel: "原文",
    encodedLabel: "编码结果",
    sourceBadge: "（数据源）",
    charCount: "{count} 字符",
    clear: "清空",
    copyPlain: "📋 复制原文",
    copyEncoded: "📋 复制编码结果",
    sourceHint: "编辑哪一框，哪一框就是数据源",
    noChangeEncode: "输入已是编码形式，再次编码无变化",
    noChangeDecode: "按 {mode} 解码后无变化（输入可能不是该编码）",
    cleared: "已清空输入",
  },

  endpointTool: {
    delayTitle: "⏱️ 延迟 JS 端点",
    delayDescA: "生成一个延迟 N 秒才返回的 JS 地址（免鉴权）。把 URL 当 ",
    delayDescB:
      " 或 fetch 目标，验证慢请求、加载占位与 SDK 的 network 采集。服务端会打印请求到达/响应完成日志。",
    fileNameLabel: "文件名",
    delayLabel: "延迟秒数",
    copy: "复制",
    open: "打开",
    delayHint: "秒数 0~300；中文文件名会自动 URL 编码，服务端日志里会解码显示。",
    fixedTitle: "🧪 其他固定端点",
    sseDesc:
      "SSE 流式端点：推送 5 条事件（含 event/id/data），每条间隔 500ms，推完关闭。验证 EventSource 与 SDK 的 SSE 采集。",
    crashDesc:
      "加载即抛错的压缩脚本 + source map（.map）。验证错误堆栈到 crash.ts 源码位置的 source map 解析能力。",
  },

  jsonTool: {
    inputLabel: "输入",
    format: "格式化",
    minify: "压缩",
    escape: "转义",
    unescape: "反转义",
    jqPlaceholder: "JQ 过滤（如 .items[].msg）",
    hintJq: "语法：.key 取字段，.arr[] 遍历数组，.a.b 嵌套路径",
    hintJsonc: "JSONC：支持单行/多行注释、尾逗号",
    hintJson5: "JSON5：支持注释、单引号、无引号 key、尾逗号、十六进制",
    parseFailed: "JSON 解析失败：{message}",
    unescapeNotString: "JSON 解析失败：结果不是字符串，无法反转义",
    resultLabel: "可视化结果",
    searchNodes: "搜索节点...",
    emptyInput: "输入 JSON 后自动渲染...",
  },

  timestampTool: {
    tsToDate: "时间戳 → 人类时间",
    dateToTs: "人类时间 → 时间戳",
    now: "现在",
    tsPlaceholder: "1691563200000 (ms) 或 1691563200 (s)",
    relative: "相对",
    relAgo: "{duration} 前",
    relLater: "{duration}后",
    invalidTs: "「{raw}」不是合法的数字时间戳",
    outOfRange: "「{raw}」超出可表示的时间范围",
    invalidDate: "「{raw}」无法解析为日期",
  },

  regexTool: {
    patternLabel: "正则表达式",
    redosTitle:
      "安全提示：对不可信来源的正则建议先做 ReDoS 检测——嵌套量词 (a+)+、(a|a)*、重叠交替 (a|ab)* 都可能触发灾难性回溯。本页有 250ms 输入防抖 + 500 条匹配上限兜底，但浏览器主线程仍可能被长回溯阻塞数秒。可用 recheck（https://makenowjust-labs.github.io/recheck/）或 Node 的 re2 库预检。",
    testTextLabel: "测试文本",
    replaceLabel: "替换为（可选）",
    matchesLabel: "匹配结果",
    matchCount: "（{count} 个）",
    matchN: "匹配 {n}",
    replaceResult: "替换结果",
    emptyInput: "输入正则和文本后自动匹配...",
  },

  urlTool: {
    defaultPort: "(默认)",
    emptyHash: "(空)",
    invalid: "⚠ 无法解析为 URL",
    copy: "复制",
    queryParams: "Query 参数",
    emptyInput: "粘贴 URL 后自动解析...",
  },

  cookieTool: {
    inputLabel: "Cookie（document.cookie 或 Set-Cookie 头，自动识别）",
    placeholder:
      "a=1; b=%E4%B8%AD\n或每行一条 Set-Cookie：\ntoken=abc123; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT; SameSite=Lax",
    summary: "共 {count} 条 · 格式：{format}",
    copy: "复制",
    expired: "已过期",
    valid: "有效",
    emptyInput: "粘贴 Cookie 后自动解析...",
  },

  jwtTool: {
    expired: "⏰ Token 已过期（{time}）",
    validUntil: "✅ 有效期至：{time}",
    emptyInput: "粘贴 JWT token 自动解码...",
  },
};
