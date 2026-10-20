# Docker 镜像打包与部署

## 目标

为 silkpulse 建立正式的 Docker 镜像打包流程，发布到 Docker Hub（llej0/silkpulse），并用本地 Docker 服务验证镜像可用。

## 背景

- 线上一直是「rsync 产物 + 1Panel 官方 node 镜像挂载运行」，从无自有镜像
- Docker Hub 账号 llej0 下 `clarosight` 是旧名称的镜像（2026-08-06），本项目不复用
- 仓库根的 `docker-compose.yml` 是遗留的 clarosight 配置（image: gs/clarosight:latest），需一并清理/更新

## 方案

- Dockerfile：node:22-alpine 基底，COPY packages/server/dist + public，CMD node dist/bin/silkpulse.mjs，EXPOSE 8080
- 构建脚本：`scripts/docker-build.sh`（或并入 package.json script），本地 pnpm build 后 docker build
- 实现见 [docker-build.sh](scripts/docker-build.sh)
- 推送：`docker push llej0/silkpulse:latest` + 版本 tag
- 验证：本地 docker run 起容器，curl 控制台/健康检查/WS 握手，确认与 rsync 部署行为一致

## 约束

- dist/ 内含平台相关 native（uws .node 文件），镜像内不重新 build，必须与构建机架构一致（本地 x64 → 镜像 x64）
- SILKPULSE_ADMIN_KEY 等敏感配置走环境变量，不进镜像

## 验收

- [x] Dockerfile + 构建脚本落库
- [x] 镜像推送成功（llej0/silkpulse，latest + 0.1.0）
- [x] 本地 docker run 验证：控制台 200、/demo 200、sdk.js 200、/ws/device 101 握手正常（容器 silkpulse-test，端口 8095）
- [x] README 补 Docker 部署方式
- [x] 遗留 docker-compose.yml 更新为新镜像
