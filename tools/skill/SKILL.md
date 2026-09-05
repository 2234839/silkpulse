---
name: silkpulse
description: 远程设备调试器 —— 查看、诊断、操作用户在远程页面（线上 H5、移动端、webview）上的实时状态。当用户报告"线上页面有问题""手机上打不开""某个页面报错"而无法用本地 DevTools 时，用这个 skill 直接查看远程设备的页面结构、console 日志、网络请求、错误，并可在远程页面执行诊断代码。
---

# silkpulse —— AI 原生远程设备调试

## 何时使用

当用户需要调试**无法直接打开 DevTools** 的网页时：

- 线上 H5 页面出了问题（线上环境，非本地 dev server）
- 用户的手机/平板上的页面
- 小程序 webview / 混合 App 的内嵌页面
- 任何开发者无法本地复现的远程页面问题

前提：目标页面已注入 silkpulse SDK（`<script src="http://<server>/sdk.js"></script>`），且 server 在运行。

## 快速上手

```bash
# 1. 先看有哪些在线设备
node tools/skill/scripts/silkpulse.mjs devices

# 2. 一键诊断聚合（错误 + 失败网络(含响应体) + 慢请求 Top + WebSocket 连接 + 日志 + 快照，AI 诊断最高效的入口）
node tools/skill/scripts/silkpulse.mjs inspect <deviceId>

# 3. 取页面快照（AI 友好的 compact 文本，一眼读懂页面结构）
node tools/skill/scripts/silkpulse.mjs snapshot <deviceId>

# 4. 查看错误和日志
node tools/skill/scripts/silkpulse.mjs errors <deviceId> 5         # 最近 5 条错误（每条带 stack，省 token）
node tools/skill/scripts/silkpulse.mjs logs <deviceId> 20          # 最近 20 条日志（AI 常用，省 token）
node tools/skill/scripts/silkpulse.mjs network <deviceId> 10       # 最近 10 条网络请求（含 WebSocket 连接 + 帧时间线）

# 4. 在远程页面执行诊断代码
node tools/skill/scripts/silkpulse.mjs exec <deviceId> "return document.querySelector('#btn').textContent"

# 复杂多行代码用管道传入（避免 shell 转义）
echo 'return { url: location.href, btn: document.querySelector("#btn")?.textContent }' | node tools/skill/scripts/silkpulse.mjs exec <deviceId>

# 5. 生成接入片段（给新设备装 SDK）
node tools/skill/scripts/silkpulse.mjs inject bookmarklet   # 书签
node tools/skill/scripts/silkpulse.mjs inject userscript    # Tampermonkey
```

设备 id 支持前缀模糊匹配，输入前几个字符即可。exec 的 code 也支持通过 stdin 传入（适合复杂多行代码）。

## 典型诊断流程

**用户："线上这个页面白屏了，帮我看看"**

```
1. silkpulse devices                     # 确认有在线设备
2. silkpulse inspect <id>                # 一键聚合：错误 + 失败网络 + 快照（最高效）
3. 如需深入：silkpulse errors/logs/network <id> 逐项细看
4. silkpulse exec <id> "return location.href"    # 执行诊断代码
```

**用户："线上压缩代码报错，堆栈指向 a1b2.min.js:1:8453，看不出是哪段代码"**

```
1. silkpulse errors <id>                 # errors 输出会自动带 ↳ 原始源码位置（若有 source map）
2. silkpulse exec <id> "return await __silkpulse_sourcemap(1, 8453, 'https://site.com/a1b2.min.js')"
   # → { source: 'src/cart.ts', line: 142, column: 8, name: 'calculateTotal' }
```

错误采集时会自动尝试解析 source map（若 .map 文件同源可访问），errors 输出里的 `↳ 原始源码` 行即解析结果。
若自动解析失败（跨域/无 map），可用 `__silkpulse_sourcemap` 在远程页面上下文手动解析（页面同源可访问自己的 .map）。

## exec 代码指南

exec 的 code 作为 **async 函数体**执行，可以写多条语句，用 `return` 返回值：```js
// 读取元素文本
return document.querySelector('.price')?.textContent

// 检查某个状态
return { visible: !!document.getElementById('modal'), title: document.title }

// 操作元素（用 snapshot 里的 idx）
__silkpulse_click(5)
__silkpulse_setValue(3, 'test@example.com')
await __silkpulse_wait(500)
return document.querySelector('#result')?.textContent

```

**辅助函数**（exec 代码中可直接用）：
- `__silkpulse_click(idx)` — 点击 snapshot 中 idx 对应的元素（触发完整鼠标事件序列 mouseover→mousedown→mouseup→click，覆盖 div[role=button] 等监听 mousedown 的自定义组件）
- `__silkpulse_setValue(idx, val)` — 设置表单值（触发 input/change 事件，兼容 Vue/React v-model）。input/textarea 传文本值；select 传 option 的 value；checkbox 传 `'true'`/`'1'` 勾选、`'false'`/`'0'` 取消；radio 传任意非空值选中（同组其他自动互斥取消）
- `__silkpulse_type(idx, text)` — 模拟键盘逐字输入（触发 keydown/keyup 序列，用于搜索框等监听 keyup 的场景）
- `__silkpulse_scroll(idx, x, y)` — 滚动元素内部（idx<0 时滚动整个窗口），触发懒加载/检查 sticky
- `__silkpulse_scrollIntoView(idx, block?)` — 滚动元素到可视区域（block: 'center'|'start'|'end'|'nearest'，默认 center）
- `__silkpulse_hover(idx)` — 鼠标悬停（触发 mouseover/mouseenter），展开下拉菜单/tooltip
- `__silkpulse_pressKey(idx, key, mods?)` — 按键（派发 keydown+keyup），如 'Enter'/'Escape'/'ArrowDown'；idx<0 对当前焦点元素；mods 可选 {ctrl,shift,alt,meta}
- `__silkpulse_wait(ms)` — 异步等待
- `__silkpulse_snapshot()` — 手动取页面快照
- `__silkpulse_sourcemap(line, col, sourceUrl?)` — 解析 source map，把压缩代码位置映射回原始源码位置（线上压缩代码报错时定位真实出错点）
- `__silkpulse_sourcemapStack([{url,line,col},...])` — 批量解析堆栈帧，返回紧凑文本
- `__silkpulse_storage(type?)` — 查询页面存储（`'local'`/`'session'`/`'cookie'`，默认 `'local'`），返回 `{key:value}` 对象。诊断登录态丢失/接口 401/配置异常（token 在 localStorage、会话在 cookie），单个值超 200 字符截断

**注意**：exec code 是 async 函数体，写 `return` 才有返回值。多条操作间用 `await __silkpulse_wait(0)` 让框架处理响应式更新。

## snapshot 阅读指南

snapshot 是 token 高效的 compact 文本，每行一个元素：

```

# url: https://example.com/shop

# title: 商品页

# viewport: 375×667

button #5 text=打招呼 ← 可点击的按钮，idx=5
input #4 #name-input ph:输入名字 ← 输入框，idx=4，有 placeholder
select #9 #city-select check=bj:北京 <bj:北京|sh:上海|gz:广州> ← 下拉框（value:text 格式，setValue 用 value）
input #10 #agree type:checkbox check 同意条款 ← 勾选框（已选中，setValue(idx,'false') 取消）
input #11 type:radio name:plan 专业版 ← 单选框（setValue(idx,'pro') 选中，同组自动互斥）

```

- `#数字` 是稳定 idx，跨快照不变，供 `__silkpulse_click(idx)` 使用
- `#id名` 是元素的 id 属性（语义信息）
- 交互元素（button/input/a/select）会显示 idx，纯文本元素不显示
- select 的 options 用 `value:text` 格式（如 `bj:北京`），`__silkpulse_setValue(idx, "bj")` 传 value 切换选项

## 配置

- `SILKPULSE_SERVER` 环境变量指定 server 地址（默认 `http://localhost:8080`）
- server 启动：`pnpm start`（或 `node packages/server/dist/bin/silkpulse.mjs --port 8080`）
- SDK 注入：目标页面加 `<script src="http://<server>/sdk.js" data-server="http://<server>"></script>`
```
