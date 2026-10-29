/**
 * 存储面板 + 颜色工具组组件的消息包（StoragePanel / ColorTool / OklchPanel / HslPanel / ColorInput）
 */
export const storageEn = {
  /** 远程设备存储读写面板（StoragePanel.vue） */
  storagePanel: {
    /** 实时标记（含最近更新时间） */
    live: "Live · {time}",
    /** 搜索框 placeholder */
    searchPlaceholder: "Search key / value...",
    /** 导出按钮 */
    export: "Export",
    /** 导入按钮 */
    import: "Import",
    /** 新增按钮 */
    add: "+ Add",
    /** IndexedDB 刷新按钮 */
    refresh: "Refresh",
    /** 加载中提示 */
    loading: "Loading...",
    /** IndexedDB 列表为空 */
    indexedDbEmpty: "No IndexedDB databases",
    /** IndexedDB 列表为空的补充说明 */
    indexedDbEmptyHint: "(IndexedDB requires browser support for the indexedDB.databases() API)",
    /** store 的记录条数 */
    recordCount: "({count} records)",
    /** 删除单条 record 按钮 title */
    deleteRecordTitle: "Delete this record",
    /** store 无记录 */
    emptyStore: "Empty store",
    /** database 无 objectStore */
    noObjectStore: "No objectStore",
    /** 表头：键 */
    colKey: "Key",
    /** 表头：值 */
    colValue: "Value",
    /** 表头：字节大小 */
    colSize: "Size",
    /** 表头：最后修改时间 */
    colUpdated: "Updated",
    /** 表头：操作列 */
    colActions: "Actions",
    /** 行内删除按钮 */
    delete: "Delete",
    /** 搜索无命中 */
    noMatch: "No matches",
    /** Cookie 类型空状态 */
    emptyCookie: "No cookies yet",
    /** localStorage / sessionStorage 空状态 */
    emptyTyped: "No {name} data",
    /** 新增模式 key 输入框前缀 */
    newKeyLabel: "New key:",
    /** 保存按钮 */
    save: "Save",
    /** 取消按钮 */
    cancel: "Cancel",
    /** 新增 value 说明 */
    newValueHint: "Value (JSON is auto-formatted)",
    /** 新增 value 输入框 placeholder */
    valuePlaceholder: 'Value (e.g. {"key":"val"} or a plain string)',
    /** 新增模式 JSON 树编辑器标题 */
    jsonTreeEdit: "JSON tree editing",
    /** 编辑模式 JSON 树编辑器标题（含操作说明） */
    jsonTreeEditHint: "JSON tree editing (click a value to edit, click ▶ to expand/collapse)",
    /** JSON 折叠后的纯文本编辑入口 */
    plainTextEdit: "Plain text editing",
    /** 编辑区快捷键提示 */
    shortcutHint: "⌘/Ctrl+Enter to save · Esc to close",
    /** 选中项的更新时间后缀 */
    updatedAtSuffix: "{time} updated",
    /** 编辑面板关闭按钮 */
    close: "Close",
    /** 保存成功反馈 */
    saved: "✓ Saved",
    /** 删除成功反馈 */
    deleted: "✓ Deleted",
    /** 导出成功反馈 */
    exported: "✓ Exported",
    /** 导入失败反馈 */
    importFailed: "Import failed: invalid file format",
    /** 导入完成反馈 */
    imported: "✓ Imported {ok}/{total}",
  },

  /** 颜色调试器（tools/ColorTool.vue） */
  colorTool: {
    /** 万能输入框 label */
    inputLabel: "Color input (HEX / rgb() / hsl() / oklch() / color names)",
    /** 大色块 title */
    currentColorTitle: "Current color",
    /** HEX 格式说明（ⓘ tooltip） */
    infoHex:
      "Hexadecimal notation #RRGGBB, optionally with a two-digit alpha #RRGGBBAA; compact and universal — the most common format in design comps and exported assets",
    /** RGB 格式说明（ⓘ tooltip） */
    infoRgb:
      "Three sRGB channels red/green/blue, each 0–255 (the raw coordinates of device displays), optional alpha; screen output maps directly onto it",
    /** HSL 格式说明（ⓘ tooltip） */
    infoHsl:
      "Hue 0–360° / Saturation % / Lightness %; intuitive but perceptually non-uniform — switch to OKLCH for even-lightness ramps",
    /** OKLCH 格式说明（ⓘ tooltip） */
    infoOklch:
      "Perceptually uniform: L lightness % / C chroma (vividness, unbounded) / H hue angle; standardized in CSS Color 4 — at constant L, sliding really keeps perceived lightness unchanged",
    /** 万能输入解析失败提示 */
    parseError:
      "Unrecognized color format. Supported: HEX / rgb() / hsl() / oklch() / CSS color names",
    /** Alpha 深浅底对比标题 */
    alphaCompareTitle:
      "Alpha comparison (alpha 0→1, left to right; the white line marks current A = {alpha}; click to set alpha)",
    /** alpha 渐变条点击 title */
    alphaClickTitle: "Click to set alpha to the clicked position",
    /** alpha 衬底：浅色底 */
    bgLight: "Light",
    /** alpha 衬底：深色底 */
    bgDark: "Dark",
    /** alpha 衬底：棋盘格 */
    bgChecker: "Checkerboard",
    /** 同色相明度色阶标题 */
    lightnessScaleTitle: "Lightness scale at constant hue (H = {hue}, S = {sat}%; click to pick)",
    /** 色阶单格 title */
    scaleStepTitle: "{color} (L = {l}%)",
    /** 渐变生成器标题 */
    gradientTitle: "Gradient generator",
    /** 渐变起始色输入 placeholder */
    gradStartPlaceholder: "Start color",
    /** 渐变结束色输入 placeholder */
    gradEndPlaceholder: "End color",
    /** 渐变起始色解析失败 */
    gradStartError: 'Cannot parse start color "{value}"',
    /** 渐变结束色解析失败 */
    gradEndError: 'Cannot parse end color "{value}"',
    /** sRGB 插值说明 */
    descSrgb: "Default interpolation — midtones tend to turn gray and muddy",
    /** HSL 插值说明 */
    descHsl: "Interpolates around the hue wheel — crossing hues sweeps through rainbow territory",
    /** OKLCH 插值说明 */
    descOklch:
      "Perceptually uniform with the smoothest transitions (P3-gamut colors may be clipped on sRGB screens)",
    /** 渐变条点击取中点色 title */
    gradMidTitle: "Click to pick the midpoint color of the {space} interpolation",
    /** CSS 效果实验室标题 */
    labTitle: "CSS effects lab (current color × common effects)",
    /** 毛玻璃小节标题 */
    glassTitle: "Frosted glass · backdrop-filter",
    /** 毛玻璃演示卡第一行 */
    glassCardLine1: "Glass card · glassmorphism",
    /** 毛玻璃演示卡第二行 */
    glassCardLine2: "Text stays readable over the blur layer",
    /** 彩色阴影小节标题 */
    shadowTitle: "Colored shadow · box-shadow",
    /** 彩色阴影小节说明 */
    shadowHint: "Airier than gray shadows; a staple since Web 2.0",
    /** 混合模式小节标题 */
    blendTitle: "Blend modes · mix-blend-mode",
    /** 混合模式小节说明 */
    blendHint: "Layered over a colorful gradient to preview the blend result",
    /** 混合模式：multiply */
    blendMultiply: "multiply — for darker variants",
    /** 混合模式：screen */
    blendScreen: "screen — for lighter variants",
    /** 混合模式：overlay */
    blendOverlay: "overlay — keeps contrast, boosts saturation",
    /** color-mix 派生色小节标题 */
    mixVariantsTitle: "color-mix derived state colors (design-system staples)",
    /** 派生色：hover（混白） */
    mixHover: "hover (mix 15% white)",
    /** 派生色：active（混黑） */
    mixActive: "active (mix 15% black)",
    /** 派生色：border（混透明） */
    mixBorder: "border (mix 60% transparent)",
    /** 派生色：bg-surface（混白 90%） */
    mixBg: "bg-surface (mix 90% white)",
    /** 派生色色块点击复制 title */
    mixCopyTitle: "Click to copy {css}",
    /** 文字对比度小节标题 */
    contrastTitle: "Text contrast (current color as background)",
    /** 白字对比度 title */
    whiteContrastTitle: "White text contrast {ratio}:1",
    /** 黑字对比度 title */
    blackContrastTitle: "Black text contrast {ratio}:1",
    /** WCAG 阈值说明 */
    wcagHint: "WCAG AA: body text ≥ 4.5:1, large text ≥ 3:1",
  },

  /** OKLCH 色彩空间调整面板（tools/color/OklchPanel.vue） */
  oklchPanel: {
    /** 坐标轴含义说明 */
    axisHint: "L lightness · C chroma · H hue",
    /** 色相环 title */
    wheelTitle:
      "OKLCH hue wheel: H is also a 0–360° angle, but its zero point differs from HSL (OKLCH 30° ≈ HSL 25°); ring colors fix the current L/C, showing the hue distribution at the actual lightness",
    /** 色域可视化标题 */
    gamutScanTitle: "Gamut (C-axis scan @ L = {l}% H = {h}°)",
    /** 色域标签：sRGB 内 */
    gamutSrgb: "Within sRGB",
    /** 色域标签：P3 广色域 */
    gamutP3: "Wide gamut (P3)",
    /** 色域标签：超出 P3 */
    gamutOut: "Out of P3",
    /** 色域条点击 title */
    gamutBarTitle:
      "Click to set chroma C; gray = displayable in sRGB, blue = only vivid on P3 screens, red = outside both gamuts",
    /** 色域条图例：0 端灰色 */
    legendGray: "0 gray",
    /** 色域条图例：sRGB 边界 */
    legendSrgb: "sRGB boundary",
    /** 色域条图例：P3 边界 */
    legendP3: "P3 boundary",
    /** 面板底部使用说明 */
    footerHint:
      "Sliding C at constant L keeps perceived lightness unchanged — ideal for design-system color ramps; the wheel rotates H with ring colors fixed at the current L/C",
  },

  /** HSL 色彩空间调整面板（tools/color/HslPanel.vue） */
  hslPanel: {
    /** 色相环 title */
    wheelTitle:
      "Hue wheel: H is a 0–360° angle (0° red, 120° green, 240° blue); click or drag to pick",
    /** 面板底部使用说明 */
    footerHint: "The wheel shows H as an angle; sliders work too. L = light/dark, S = vivid/muted",
  },

  /** 色值输入框（tools/color/ColorInput.vue） */
  colorInput: {
    /** 输入框默认 placeholder */
    defaultPlaceholder: "Color",
    /** 色块按钮 title */
    openPickerTitle: "Open color picker",
  },
};

export const storageZh: typeof storageEn = {
  storagePanel: {
    live: "实时 · {time}",
    searchPlaceholder: "搜索 key / value...",
    export: "导出",
    import: "导入",
    add: "+ 新增",
    refresh: "刷新",
    loading: "加载中...",
    indexedDbEmpty: "暂无 IndexedDB 数据库",
    indexedDbEmptyHint: "（IndexedDB 需要浏览器支持 indexedDB.databases() API）",
    recordCount: "({count} 条)",
    deleteRecordTitle: "删除此条",
    emptyStore: "空 store",
    noObjectStore: "无 objectStore",
    colKey: "Key",
    colValue: "Value",
    colSize: "大小",
    colUpdated: "更新时间",
    colActions: "操作",
    delete: "删除",
    noMatch: "无匹配项",
    emptyCookie: "暂无 Cookie",
    emptyTyped: "暂无 {name} 数据",
    newKeyLabel: "新增 key:",
    save: "保存",
    cancel: "取消",
    newValueHint: "value（支持 JSON 自动格式化）",
    valuePlaceholder: 'value（如 {"key":"val"} 或 plain string）',
    jsonTreeEdit: "JSON 树编辑",
    jsonTreeEditHint: "JSON 树编辑（点击值直接修改，点击 ▶ 展开/折叠）",
    plainTextEdit: "纯文本编辑",
    shortcutHint: "⌘/Ctrl+Enter 保存 · Esc 关闭",
    updatedAtSuffix: "{time} 更新",
    close: "关闭",
    saved: "✓ 已保存",
    deleted: "✓ 已删除",
    exported: "✓ 已导出",
    importFailed: "导入失败：文件格式不正确",
    imported: "✓ 已导入 {ok}/{total} 条",
  },

  colorTool: {
    inputLabel: "颜色输入（HEX / rgb() / hsl() / oklch() / 颜色名）",
    currentColorTitle: "当前颜色",
    infoHex: "十六进制记法 #RRGGBB，可带两位透明度 #RRGGBBAA；紧凑通用，设计稿/切图最常见",
    infoRgb: "sRGB 三通道红/绿/蓝各 0-255（设备显示的原始坐标），可带 alpha；屏幕发光直接对应它",
    infoHsl:
      "色相 Hue 0-360°角度 / 饱和度 Saturation % / 亮度 Lightness %；符合直觉但感知不均匀，调出等亮色阶需换 OKLCH",
    infoOklch:
      "感知均匀：L 亮度 % / C 色度（鲜艳度，无上限）/ H 色相角度；CSS Color 4 标准，同 L 滑动亮度真的不变",
    parseError: "无法识别的颜色格式，支持 HEX / rgb() / hsl() / oklch() / CSS 颜色名",
    alphaCompareTitle: "透明度对比（alpha 0→1 从左到右，白线为当前 A={alpha}，点击设定 alpha）",
    alphaClickTitle: "点击把 alpha 设为所点位置的值",
    bgLight: "浅底",
    bgDark: "深底",
    bgChecker: "棋盘格",
    lightnessScaleTitle: "同色相明度色阶（H={hue} S={sat}%，点击取色）",
    scaleStepTitle: "{color}（L={l}%）",
    gradientTitle: "渐变生成器",
    gradStartPlaceholder: "起始色",
    gradEndPlaceholder: "结束色",
    gradStartError: "起始色「{value}」无法解析",
    gradEndError: "结束色「{value}」无法解析",
    descSrgb: "默认插值，中段易发灰发脏",
    descHsl: "沿色相环过渡，跨色相时会扫过彩虹区",
    descOklch: "感知均匀，过渡最顺滑（P3 色域可能被 sRGB 屏裁剪）",
    gradMidTitle: "点击取 {space} 插值的中点色",
    labTitle: "CSS 效果实验室（当前颜色 × 常用效果）",
    glassTitle: "毛玻璃 backdrop-filter",
    glassCardLine1: "Glass card · 玻璃拟态",
    glassCardLine2: "文字在模糊层上仍可读",
    shadowTitle: "彩色阴影 box-shadow",
    shadowHint: "比灰阴影更通透，Web 2.0 起流行",
    blendTitle: "混合模式 mix-blend-mode",
    blendHint: "叠在花底上看混合结果",
    blendMultiply: "multiply 正片叠底（做深色变体）",
    blendScreen: "screen 滤色（做浅色变体）",
    blendOverlay: "overlay 叠加（保对比提饱和）",
    mixVariantsTitle: "color-mix 派生状态色（设计系统常用）",
    mixHover: "hover（混白 15%）",
    mixActive: "active（混黑 15%）",
    mixBorder: "border（混透明 60%）",
    mixBg: "bg-surface（混白 90%）",
    mixCopyTitle: "点击复制 {css}",
    contrastTitle: "文字对比度（当前色做底）",
    whiteContrastTitle: "白字对比度 {ratio}:1",
    blackContrastTitle: "黑字对比度 {ratio}:1",
    wcagHint: "WCAG AA 正文 ≥ 4.5:1，大字 ≥ 3:1",
  },

  oklchPanel: {
    axisHint: "L 亮度 · C 鲜艳度 · H 色相",
    wheelTitle:
      "OKLCH 色相环：H 也是 0-360° 角度，但角度定义与 HSL 不同（如 OKLCH 30° ≈ HSL 25° 附近）；环色固定当前 L/C，反映真实亮度下的色相分布",
    gamutScanTitle: "色域（C 轴扫描 @ L={l}% H={h}°）",
    gamutSrgb: "sRGB 内",
    gamutP3: "P3 广色域",
    gamutOut: "超出 P3",
    gamutBarTitle: "点击设定色度 C；灰色段 sRGB 可显示，蓝色段仅 P3 屏更艳，红色段两边都装不下",
    legendGray: "0 灰",
    legendSrgb: "sRGB 边界",
    legendP3: "P3 边界",
    footerHint:
      "等 L 滑动时 perceived 亮度不变，适合做设计系统色阶；色相环转动 H，环色固定当前 L/C",
  },

  hslPanel: {
    wheelTitle: "色相环：H 是 0-360° 的角度（0° 红、120° 绿、240° 蓝），点击或拖动选取",
    footerHint: "色相环直观展示 H 是角度；也可拖滑杆。L 明暗、S 鲜淡",
  },

  colorInput: {
    defaultPlaceholder: "颜色",
    openPickerTitle: "打开颜色选择器",
  },
};
