# SilkPulse DevTools 插件目录

每个子目录是一个 devtools 集成，包含官方打包好的 client/frontend 静态文件。

## 目录结构

```
plugins/
  vue-devtools/        ← Vue DevTools client（来自 vite-plugin-vue-devtools/client）
    index.html
    assets/
    ...
  react-devtools/      ← React DevTools frontend（来自 react-devtools-inline 构建）
    index.html
    assets/
    ...
```

## 版本同步

```bash
# 同步所有插件到最新版本
node scripts/sync-devtools-clients.mjs

# 只同步 Vue
node scripts/sync-devtools-clients.mjs --plugin vue

# 只同步 React
node scripts/sync-devtools-clients.mjs --plugin react
```

脚本会：

1. 从 npm 下载最新版 `vite-plugin-vue-devtools` / `react-devtools-inline`
2. 拷贝打包好的 client 静态文件到对应目录
3. 记录版本号到 `plugins/*/version.json`

## 添加新插件

1. 在此目录创建子目录
2. 写同步逻辑到 `scripts/sync-devtools-clients.mjs`
3. 在 `DevToolsPanel.vue` 注册 plugin config
