<div align="center">

# 🩺 silkpulse

### 让 AI 亲手调试你看不见的页面

线上 H5 · 移动端 webview · 用户现场 —— 任何打不开本地 DevTools 的远程页面

[![CI](https://github.com/2234839/silkpulse/actions/workflows/ci.yml/badge.svg)](https://github.com/2234839/silkpulse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![在线体验](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-silkpulse-6366f1.svg)](https://silkpulse.heartstack.space)

</div>

---

> 用户在千里之外的 iPhone 上说「页面白屏了」。
> 你对 AI 说一句「看看怎么回事」——它展开组件树、读 console、查网络请求，
> 定位到那行报错，执行代码验证，全程不需要用户装任何东西。
>
> **这就是 silkpulse 做的事。**

<p align="center">
  <img src="docs/vueDevTools.png" width="49.2%" alt="silkpulse 控制台：Vue 生产页组件树调试，选中组件 state/props 一目了然" title="Vue 生产页组件树调试">
  <img src="docs/reactDevTools.png" width="49.2%" alt="silkpulse 控制台：React 生产页组件树调试，hooks/props/source 直接看" title="React 生产页组件树调试">
</p>

## 它能做什么

把任意远程页面的"现场"搬到你的浏览器和 AI 面前：

- **看** —— 页面快照、console 日志、网络请求、报错堆栈（自动还原压缩代码的真实出错位置）
- **看组件树** —— Vue / React 组件树、state / props / hooks，**生产构建的线上页面也能看**，体验与本地 DevTools 一致
- **动** —— 在远程页面执行 JS、点击元素、填表单、滚动、模拟按键，AI 可以直接操作并验证
- **AI 闭环** —— 自带 AI skill：诊断 → 定位 → 操作 → 验证，一句话让 AI 自己排查线上问题
- **多设备管理** —— 多台设备同时接入，标签/备注区分、错误自动高亮、断线重连历史不丢

## 适合谁

- 排查**线上 H5 / 移动端 webview** 问题，但用户那边打不开 DevTools
- 用户说"白屏了 / 点不了"，你却拿不到现场
- 想让 AI agent 直接读懂并操作远程页面

## 在线体验

- **控制台**：[https://silkpulse.heartstack.space](https://silkpulse.heartstack.space)（输入密钥或以访客身份登录）
- **测试页**（已接入 SDK，可直接在控制台中看到）：[https://silkpulse.heartstack.space/test-page.html](https://silkpulse.heartstack.space/test-page.html)

## 接入有多简单

三种方式任选，**线上站不改一行源码也能接**：

1. **script 标签** —— 能改源码时加一行：
   ```html
   <script src="https://your-server/sdk.js"></script>
   ```
2. **bookmarklet** —— 访问 `/inject/bookmarklet`，拖到书签栏，任意页面点击即接入
3. **userscript** —— 访问 `/inject/userscript`，装进 Tampermonkey，自动匹配所有页面

## 快速开始

```bash
vp install
vp run -r build    # 构建
vp run start       # 启动，默认端口 8080
```

浏览器打开 `http://localhost:8080` 即是控制台。

### 部署到生产

构建产物自包含，无需 `node_modules`：

```bash
# 方式一：Node 直接跑
rsync -avz --delete packages/server/dist/   root@<server>:/app/silkpulse/dist/
rsync -avz --delete packages/server/public/ root@<server>:/app/silkpulse/public/
SILKPULSE_ADMIN_KEY=<你的密钥> node /app/silkpulse/dist/bin/silkpulse.mjs --port 8080

# 方式二：Docker
docker build -t silkpulse .
docker run -d -p 8080:8080 -e SILKPULSE_ADMIN_KEY=<你的密钥> -v ./data:/data silkpulse
```

Nginx 反代时记得放行 WebSocket 升级（`Upgrade` / `Connection` 头）。

## 让 AI 用起来

AI agent 通过 silkpulse skill 一句话排查问题：

```bash
node tools/skill/scripts/silkpulse.mjs devices      # 在线设备
node tools/skill/scripts/silkpulse.mjs inspect <id> # 一键诊断聚合（AI 最高效入口）
node tools/skill/scripts/silkpulse.mjs exec <id>    # 在远程页面执行 JS
```

完整用法见 [tools/skill/SKILL.md](tools/skill/SKILL.md)。

## 想深入了解

- **架构与实现细节**：[SILKPULSE_KNOWLEDGE.md](SILKPULSE_KNOWLEDGE.md)
- **项目结构**：`packages/`（server、sdk、shared）+ `apps/console`（控制台 UI）+ `tools/skill`（AI skill）

## 社区

感谢 [LINUX DO](https://linux.do) 社区佬友们的支持与反馈 🙏

[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-%E4%BD%AC%E5%8F%8B%E4%BB%AC%E7%9A%84%E6%94%AF%E6%8C%81-009df5?logo=linuxdo&logoColor=white)](https://linux.do)

## License

MIT
