# silkpulse UI 逐功能视觉审查清单

> 方法：本地起服务（8080 server + 5174 console dev），headless chromium 打开 /demo 作为被调试设备，
> 控制台逐面板截图 → 视觉审查 → 优化 → 复查截图。
> 截图存放：`/tmp/ui/`，脚本：`scripts/ui-audit-shot.mjs`、`scripts/ui-audit-session.mjs`

## 状态图例
- [ ] 待审查
- [x] 已审查未发现问题
- [~] 已发现问题并优化（见问题描述）

## 一、全局 / 框架
- [x] 顶栏（logo、连接状态指示、主题切换、各入口按钮）
- [x] 亮色主题整体
- [x] 暗色主题整体
- [x] 设备列表侧栏（空态、有设备、搜索、离线设备区）
- [~] 面板 Tab 切换与布局拖拽（useResizable）——Tab 已验；拖拽手柄 headless 下难模拟，代码走查无误，待人工确认

## 二、设备接入
- [x] 接入新设备弹层（Script 标签/IIFE/Bookmarklet/Userscript 四个 tab）
- [x] 设备标签/备注内联编辑（🏷️）
- [x] 设备详情头部信息展示

## 三、调试面板（需接入设备）
- [~] ConsolePanel（级别着色/搜索/清空 ✅；对象日志不可展开 → F7 候选增强）
- [x] NetworkPanel（请求列表、详情、headers/body 展示）
- [x] ErrorsPanel（错误列表、堆栈、sourcemap 解析结果）
- [x] SnapshotPanel（compact 快照文本展示）
- [x] ElementPanel + ElementTreeNode（DOM 树、选中）
- [x] ExecPanel（输入、自动补全、历史、执行结果、ObjectInspector）
- [x] StoragePanel（localStorage/sessionStorage/cookie）
- [x] InjectPanel（注入代码/脚本管理）
- [~] FeaturePanel（能力探测展示 ✅，超时 bug 已修 → F8）
- [x] DevToolsPanel（vue-devtools / react-devtools 内嵌 iframe）

## 四、弹层 / 模态
- [x] AgentPromptModal（Agent 提示词）
- [x] AiContextModal（AI 上下文）
- [x] ProjectModal（项目管理）——本地起 SILKPULSE_ADMIN_KEY 验证（第 3 轮）

## 五、独立页面
- [x] /tools 工具箱（JSON 工具，F3 伪问题排除）
- [x] /blog 列表页
- [x] /blog/:slug 详情页（含暗色）
- [x] AuthPage（鉴权登录页）——本地起 SILKPULSE_ADMIN_KEY 验证，发现并修复 F9

## 审查记录

### 第 1 轮（2026-08-27，截图 /tmp/ui/）
覆盖：顶栏/设备列表空态、设备选中、Console、Element(DOM树/布局预览/画面)、Network(列表+详情)、Storage(localStorage/cookie/idb)、Errors(空+真实错误)、Feature、Snapshot、Exec(补全+ObjectInspector)、DevTools(空态/连接中)、接入弹层、诊断上下文弹层、Agent 弹层、标签编辑、/tools(JSON)、/blog 列表+详情、暗色主题。

| # | 发现 | 定位 | 状态 |
|---|---|---|---|
| F1 | `font-mono` 回退链在缺 Menlo/Consolas 的 Linux 上被 fontconfig 代偿到 Noto Sans Mono CJK，ASCII 字宽近全角，URL/时间戳/表格值被撑出巨大字距 | style.css | ✅ 已修：@theme 重定义 --font-mono 加 DejaVu Sans Mono / Ubuntu Sans Mono；同轮补 --font-sans 回退（DejaVu Sans / Ubuntu），用户要求（73 截图验证） |
| F2 | ObjectInspector 展开对象时，原型链方法（__defineGetter__/hasOwnProperty/…）与自有属性平铺混排，自有字段被淹没 | ObjectInspector.vue + shared SerializedProperty.inherited + sdk serialize-value | ✅ 已修：继承属性打 inherited 标记，展示层折叠进 [[Prototype]] 分组（74 截图验证） |
| F3 | /tools JSON 工具默认 Auto 模式下可视化区显示占位文案 → 复核为伪问题：那是输入框 placeholder 示例文本，非结果区错误 | — | ✅ 关闭（伪问题） |
| F4 | 设备卡片 meta 行（Linux · desktop · 时间 · 视口）flex 换行出孤字（"刚"/"分钟"独行），观感杂乱 | DeviceList.vue 两种卡片变体 | ✅ 已修：meta 行 flex-wrap + gap-x-2，各 span whitespace-nowrap（72 截图验证） |
| F5 | 弹层不互斥：AI 诊断上下文开着时点 Agent，两个 modal 叠开（双重遮罩） | ConsoleApp.vue | ✅ 已修：watch 四个弹窗状态互斥（打开一个关其余） |
| F6 | 控制台刷新/路由返回后不恢复上次选中设备（设备明明在线却回到空态） | useConsoleSocket.ts selectedDeviceId | ✅ 已修：localStorage 持久化 + device-list 恢复订阅 + 离线清除（72-f6-reload-restore.png 验证） |

环境伪影备忘（非产品 bug，勿修）：无头环境缺字体导致的等宽字距（已由 F1 缓解）；puppeteer evaluate 堆栈 URL-encoded（ptr:evaluate;file%3A…）。

### 第 2 轮（2026-08-27，截图 /tmp/ui/8x–10x）
覆盖：Exec/ObjectInspector 展开（亮+暗）、Console 日志（级别着色/搜索/清空）、接入弹层四 tab（Script/IIFE/Bookmarklet/Userscript）、Feature、Snapshot、blog 列表+详情（暗色）、未覆盖遗留：ProjectModal 与 AuthPage（本地未开鉴权/无超管密钥，需专用环境验证）。

| # | 发现 | 定位 | 状态 |
|---|---|---|---|
| F7 | Console 面板对象日志只渲染 message preview 纯文本，不可展开检查（Exec 面板同对象可用 ObjectInspector 展开）；根因 LogEntry 不携带结构化 args，需 SDK（serializeArgs）+ shared 类型 + 面板 UI 三层改动，属功能增强 | sdk log-collector / shared LogEntry / ConsolePanel.vue | 📝 记录，待定优先级 |
| F8 | Feature 面板必超时：feature-detect 检测脚本中 `canvas.getContext('webgl')` 在软件渲染（WSL2 swiftshader）下首建上下文耗时 80s+，超过 server 通用 exec 10s 超时；真实低端设备也可能超 | packages/server api.ts execOnDevice | ✅ 已修：execOnDevice 增加可选 timeoutMs 参数，feature-detect 路由独立 60s 超时（通用 exec 仍 10s），tsc 通过 |

### 第 3 轮（2026-08-27，本地起 SILKPULSE_ADMIN_KEY 开鉴权验证）
覆盖：AuthPage（页面布局/错误密钥/正确密钥）、ProjectModal 全流程（创建项目、密钥一次性展示、轮换/禁用/删除按钮、侧栏项目分组）、项目密钥登录视角。

| # | 发现 | 定位 | 状态 |
|---|---|---|---|
| F9 | 错误密钥登录无任何错误提示：verifyAuthKey 先 saveKey 再验证，错误的 key 一写入 apiKey，needAuth（依赖 apiKey 非空）瞬时翻 false → AuthPage 卸载；verify 失败 clearKey 后 needAuth 翻回 true → AuthPage 重挂，authError/输入框全部重置，红字永远显示不出来 | ConsoleApp.vue verifyAuthKey + useAuth verifyKey | ✅ 已修：verifyKey 增加可选 candidate 参数，先验证后 saveKey，验证期间不动 apiKey（115 截图验证：红字「密钥无效」正常显示，正确密钥登录成功） |

- ProjectModal：创建/一次性密钥警示/轮换/禁用/删除/侧栏分组均正常（116）
- 项目密钥视角：项目管理按钮隐藏、注入代码自动带 data-project-id、设备按项目过滤（117）

### 第 2 轮修复验证
- Exec 返回值展开：自有属性置顶 + `[[Prototype]]:(11 inherited)` 折叠组可展开（83/84 亮暗截图）
- Console 日志级别着色/对象 preview 正常（90）；接入弹层四 tab 布局正常（92/93）
- blog 详情暗色排版正常（99b）；Snapshot 文本流正常（97）
