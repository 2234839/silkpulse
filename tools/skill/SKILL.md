---
name: clarosight
description: 远程设备调试器 —— 查看、诊断、操作用户在远程页面（线上 H5、移动端、webview）上的实时状态。当用户报告"线上页面有问题""手机上打不开""某个页面报错"而无法用本地 DevTools 时，用这个 skill 直接查看远程设备的页面结构、console 日志、网络请求、错误，并可在远程页面执行诊断代码。
---

# clarosight —— AI 原生远程设备调试

## 何时使用

当用户需要调试**无法直接打开 DevTools** 的网页时：
- 线上 H5 页面出了问题（线上环境，非本地 dev server）
- 用户的手机/平板上的页面
- 小程序 webview / 混合 App 的内嵌页面
- 任何开发者无法本地复现的远程页面问题

前提：目标页面已注入 clarosight SDK（`<script src="http://<server>/sdk.js"></script>`），且 server 在运行。

## 快速上手

```bash
# 1. 先看有哪些在线设备
node tools/skill/scripts/clarosight.mjs devices

# 2. 取页面快照（AI 友好的 compact 文本，一眼读懂页面结构）
node tools/skill/scripts/clarosight.mjs snapshot <deviceId>

# 3. 查看错误和日志
node tools/skill/scripts/clarosight.mjs errors <deviceId>
node tools/skill/scripts/clarosight.mjs logs <deviceId>

# 4. 在远程页面执行诊断代码
node tools/skill/scripts/clarosight.mjs exec <deviceId> "return document.querySelector('#btn').textContent"
```

设备 id 支持前缀模糊匹配，输入前几个字符即可。

## 典型诊断流程

**用户："线上这个页面白屏了，帮我看看"**

```
1. clarosight devices                     # 确认有在线设备
2. clarosight errors <id>                 # 先看有没有报错
3. clarosight logs <id>                   # 看 console 日志
4. clarosight snapshot <id>               # 看页面实际渲染了什么
5. clarosight exec <id> "return location.href"   # 确认页面 URL 和状态
6. clarosight network <id>                # 看接口请求是否正常
```

## exec 代码指南

exec 的 code 作为 **async 函数体**执行，可以写多条语句，用 `return` 返回值：

```js
// 读取元素文本
return document.querySelector('.price')?.textContent

// 检查某个状态
return { visible: !!document.getElementById('modal'), title: document.title }

// 操作元素（用 snapshot 里的 idx）
__clarosight_click(5)
__clarosight_setValue(3, 'test@example.com')
await __clarosight_wait(500)
return document.querySelector('#result')?.textContent
```

**辅助函数**（exec 代码中可直接用）：
- `__clarosight_click(idx)` — 点击 snapshot 中 idx 对应的元素
- `__clarosight_setValue(idx, val)` — 设置表单值（触发 input 事件，兼容 Vue/React v-model）
- `__clarosight_wait(ms)` — 异步等待
- `__clarosight_snapshot()` — 手动取页面快照

**注意**：exec code 是 async 函数体，写 `return` 才有返回值。多条操作间用 `await __clarosight_wait(0)` 让框架处理响应式更新。

## snapshot 阅读指南

snapshot 是 token 高效的 compact 文本，每行一个元素：

```
# url: https://example.com/shop
# title: 商品页
button #5 text=打招呼            ← 可点击的按钮，idx=5
input #4 #name-input ph:输入名字  ← 输入框，idx=4，有 placeholder
select #9 #city-select val:北京 <北京|上海|广州>  ← 下拉框
input #10 #agree type:checkbox check 同意条款     ← 勾选框（已选中）
```

- `#数字` 是稳定 idx，跨快照不变，供 `__clarosight_click(idx)` 使用
- `#id名` 是元素的 id 属性（语义信息）
- 交互元素（button/input/a/select）会显示 idx，纯文本元素不显示

## 配置

- `CLAROSIGHT_SERVER` 环境变量指定 server 地址（默认 `http://localhost:8080`）
- server 启动：`pnpm start`（或 `node packages/server/dist/bin/clarosight.mjs --port 8080`）
- SDK 注入：目标页面加 `<script src="http://<server>/sdk.js" data-server="http://<server>"></script>`
