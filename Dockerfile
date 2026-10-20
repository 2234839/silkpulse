# silkpulse 服务镜像
# 前置：宿主先 pnpm build（dist/ 含平台相关 uws native，镜像与构建机架构需一致）
# 构建：bash scripts/docker-build.sh [版本号]
# node:24-slim：宿主构建机为 Node 24（ABI 137），uws native 按构建机 ABI 编译，
# 容器 node 大版本必须一致；用 slim(Debian/glibc) 而非 alpine(musl)，否则 native 加载失败
FROM node:24-slim

WORKDIR /app

# 预打包产物自包含（无需 node_modules），public 含控制台 UI + sdk.js
COPY packages/server/dist/ ./dist/
COPY packages/server/public/ ./public/

# 数据目录（项目/设备持久化）
ENV SILKPULSE_DATA_DIR=/app/data
VOLUME /app/data

EXPOSE 8080

CMD ["node", "dist/bin/silkpulse.mjs", "--port", "8080"]
