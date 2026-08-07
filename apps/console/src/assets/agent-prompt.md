# Clarosight —— 远程设备调试工具

你可以通过以下 HTTP API 直接调试远程设备（线上页面、用户浏览器等）。

## 连接信息

- Server: __SERVER_URL__
- API Key: __API_KEY__
- 所有请求需携带 Header: `Authorization: Bearer __API_KEY__`
- 建议加 `Accept-Encoding: gzip` 头减少传输量

## API 列表

所有接口前缀：`__SERVER_URL__/api/devices`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/<id>/inspect` | **一键诊断聚合**（错误 + 失败网络 + 快照，最高效入口） |
| GET | `/<id>/snapshot` | 页面快照（AI 友好的 compact 文本） |
| GET | `/<id>/logs?limit=20` | 最近 N 条 console 日志 |
| GET | `/<id>/errors?limit=10` | 最近 N 条错误（带 source map 解析） |
| GET | `/<id>/network?limit=10` | 最近 N 条网络请求（含响应体） |
| POST | `/<id>/exec` | 在远程页面执行 JS 代码（body: `{ "code": "..." }`） |

查看所有在线设备：`GET __SERVER_URL__/api/devices` → `{ devices: [{ id, url, title }] }`

### exec 示例

```bash
curl -s -X POST -H "Authorization: Bearer __API_KEY__" -H "Content-Type: application/json" \
  -d '{"code":"return document.title"}' \
  "__SERVER_URL__/api/devices/<deviceId>/exec"
```

exec 的 code 作为 **async 函数体**执行，写 `return` 返回结果。

## exec 辅助函数（在远程页面上下文直接调用）

- `__clarosight_click(idx)` — 点击元素（用 snapshot 中的 idx）
- `__clarosight_setValue(idx, val)` — 设置表单值（兼容 Vue/React v-model）
- `__clarosight_type(idx, text)` — 逐字输入（触发 keydown/keyup）
- `__clarosight_wait(ms)` — 异步等待
- `__clarosight_snapshot()` — 取页面快照
- `__clarosight_sourcemap(line, col, url?)` — source map 解析（压缩代码定位源码）

## snapshot 阅读指南

```
button #5 text=提交           ← idx=5 的按钮
input #4 #name ph:输入名字     ← idx=4 的输入框
select #9 check=bj:北京 <bj:北京|sh:上海>  ← 下拉框（setValue 传 value）
```
`#数字` 是稳定 idx，跨快照不变，供 `__clarosight_click(idx)` 使用。

## 典型诊断流程

1. `GET /api/devices` → 拿到在线设备列表和 id
2. `GET /<id>/inspect` → 一键聚合诊断（最高效）
3. 需要深入时用 `/<id>/logs|errors|network` 逐项查看
4. `POST /<id>/exec` → 执行诊断代码定位问题

exec 超时 10 秒，长任务需拆分。
