/**
 * Agent skill 提示词模板 —— 服务端 + 控制台共用
 *
 * 服务端在 /api/skill/silkpulse 路由中用此模板按需返回文档，
 * 控制台在"接入 Agent"弹窗中也用同一份模板生成完整提示词。
 * 两端共用同一份模板，确保 agent 拿到的内容永远一致。
 *
 * 占位符：
 * - __SERVER_URL__ → 服务访问地址（如 https://silkpulse.heartstack.space）
 * - __API_KEY__    → 用户密钥（超管密钥或项目密钥）
 */

/** 控制台地址用于 dashboard 链接等场景 */
const PLACEHOLDER_SERVER_URL = '__SERVER_URL__'
const PLACEHOLDER_API_KEY = '__API_KEY__'

/**
 * 完整的 agent 提示词模板（含占位符）
 *
 * 包含：连接信息、API 列表、exec 辅助函数、snapshot 阅读指南、诊断流程。
 * ~1500 字，agent 加载后即可通过 HTTP API 完整操作远程设备。
 */
export const SKILL_PROMPT_TEMPLATE = `# SilkPulse —— 远程设备调试工具

你可以通过以下 HTTP API 直接调试远程设备（线上页面、用户浏览器等）。
所有接口返回 text/plain（除 exec 返回 JSON），可直接读取，无需解析 JSON。

## 连接信息

- Server: ${PLACEHOLDER_SERVER_URL}
- 鉴权：\`Authorization: Bearer ${PLACEHOLDER_API_KEY}\` header 或 \`?key=${PLACEHOLDER_API_KEY}\` query 参数
- 建议加 \`Accept-Encoding: gzip\` 头减少传输量

## API 列表

所有接口前缀：\`${PLACEHOLDER_SERVER_URL}/api/agent/devices\`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | 查在线设备 | \`GET ${PLACEHOLDER_SERVER_URL}/api/agent/devices\` → JSON \`{ devices: [{ id, url, title, errors }] }\` |
| GET | \`/<id>/inspect\` | **一键诊断聚合**（错误 + 失败请求 + 页面快照，最高效入口） |
| GET | \`/<id>/snapshot\` | 页面快照（compact 文本，含可见元素树 + 最近错误） |
| GET | \`/<id>/logs?limit=20\` | 最近 N 条 console 日志（text/plain） |
| GET | \`/<id>/errors?limit=10\` | 最近 N 条错误（text/plain，含 source map 解析） |
| GET | \`/<id>/network?limit=10\` | 最近 N 条网络请求（text/plain，失败请求标记 FAIL） |
| GET | \`/<id>/element/tree?idx=N\` | DOM 元素子树（JSON，不传 idx 从根开始） |
| GET | \`/<id>/screenshot?idx=N\` | **截图**（返回图片，不传 idx 截全页，传 idx 截指定元素） |
| POST | \`/<id>/exec\` | 在远程页面执行 JS（body: \`{ "code": "..." }\`） |

### exec 示例

\`\`\`bash
# 基本执行（返回 JSON: { success, result, error, logs, snapshot? }）
curl -s -X POST -H "Authorization: Bearer ${PLACEHOLDER_API_KEY}" -H "Content-Type: application/json" \\
  -d '{"code":"return document.title"}' \\
  "${PLACEHOLDER_SERVER_URL}/api/agent/devices/<deviceId>/exec"

# 简单查询不需要快照，加 ?snapshot=0 节省 token
curl -s -X POST "${PLACEHOLDER_SERVER_URL}/api/agent/devices/<deviceId>/exec?snapshot=0" \\
  -H "Authorization: Bearer ${PLACEHOLDER_API_KEY}" -H "Content-Type: application/json" \\
  -d '{"code":"return { url: location.href, title: document.title }"}'
\`\`\`

exec 返回值说明：
- \`success\`：布尔，是否成功
- \`result\`：JSON 序列化后的返回值（你写的 return 值）
- \`error\`：失败时的错误信息
- \`logs\`：执行期间的 console 输出数组（可能为空）
- \`snapshot\`：执行后的页面快照（加 ?snapshot=0 禁用）

exec 的 code 作为 **async 函数体**执行，写 \`return\` 返回结果。

## exec 辅助函数（在远程页面上下文直接调用）

- \`__silkpulse_click(idx)\` — 点击元素（用 snapshot 中的 idx）
- \`__silkpulse_setValue(idx, val)\` — 设置表单值（兼容 Vue/React v-model）
- \`__silkpulse_type(idx, text)\` — 逐字输入（触发 keydown/keyup）
- \`__silkpulse_wait(ms)\` — 异步等待
- \`__silkpulse_snapshot()\` — 取页面快照
- \`__silkpulse_screenshot(idx?, opts?)\` — 截图（不传 idx 截全页，传 idx 截指定元素，返回 dataURL）
- \`__silkpulse_sourcemap(line, col, url?)\` — source map 解析（压缩代码定位源码）

## snapshot 阅读指南

\`\`\`
button #5 text=提交           ← idx=5 的按钮
input #4 #name ph:输入名字     ← idx=4 的输入框
select #9 check=bj:北京 <bj:北京|sh:上海>  ← 下拉框（setValue 传 value）
\`\`\`
\`#数字\` 是稳定 idx，跨快照不变，供 \`__silkpulse_click(idx)\` 使用。

## 典型诊断流程

1. \`GET /api/agent/devices\` → 拿到在线设备列表和 id
2. \`GET /<id>/inspect\` → 一键聚合诊断（最高效入口）
3. 需要深入时用 \`/<id>/logs|errors|network\` 逐项查看
4. \`GET /<id>/screenshot\` → 截图看页面真实渲染效果（传 \`?idx=N\` 截指定元素）
5. \`POST /<id>/exec?snapshot=0\` → 执行诊断代码定位问题

exec 超时 10 秒，长任务需拆分。`

/**
 * 渐进式加载的系统提示词模板（极短）
 *
 * 只有几十个 token，放在 agent 的系统提示词中。
 * agent 遇到需要远程调试前端/网页问题时，主动 curl 拉取完整 skill 文档。
 * 完整文档由服务端 /api/skill/silkpulse?key=xx 端点返回。
 */
export const SKILL_SYSTEM_PROMPT_TEMPLATE = `你有一个远程调试工具 SilkPulse 可用。

当用户遇到前端 / 网页 / 线上 bug 需要远程查看或调试时，先用 curl 拉取技能文档：

curl -s "${PLACEHOLDER_SERVER_URL}/api/skill/silkpulse?key=${PLACEHOLDER_API_KEY}"

拉取后按文档中的 API 列表操作即可（查看在线设备、快照、日志、错误、网络请求、执行代码等）。
不需要时忽略此工具。`

/**
 * 渲染完整 skill 提示词：替换占位符为实际值
 *
 * @param serverUrl 服务访问地址（如 https://silkpulse.heartstack.space）
 * @param apiKey    用户密钥
 * @returns 替换占位符后的完整提示词
 */
export function renderSkillPrompt(serverUrl: string, apiKey: string): string {
  return SKILL_PROMPT_TEMPLATE
    .split(PLACEHOLDER_SERVER_URL).join(serverUrl)
    .split(PLACEHOLDER_API_KEY).join(apiKey)
}

/**
 * 渲染渐进式加载的系统提示词：替换占位符为实际值
 *
 * @param serverUrl 服务访问地址
 * @param apiKey    用户密钥
 * @returns 替换占位符后的极短系统提示词
 */
export function renderSkillSystemPrompt(serverUrl: string, apiKey: string): string {
  return SKILL_SYSTEM_PROMPT_TEMPLATE
    .split(PLACEHOLDER_SERVER_URL).join(serverUrl)
    .split(PLACEHOLDER_API_KEY).join(apiKey)
}
