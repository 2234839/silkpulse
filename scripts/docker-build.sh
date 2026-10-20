#!/usr/bin/env bash
# 构建 silkpulse Docker 镜像并推送 Docker Hub
# 用法: bash scripts/docker-build.sh [版本号]   （不传版本号则只打 latest）
# 前置: docker 已登录（docker login）；会先执行 pnpm build 刷新产物
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="llej0/silkpulse"

echo "▶ [1/3] pnpm build（刷新 dist/public 产物）"
pnpm build > /dev/null
echo "  构建完成"

echo "▶ [2/3] docker build"
TAGS=("$IMAGE:latest")
if [[ $# -ge 1 ]]; then
  TAGS+=("$IMAGE:$1")
fi
BUILD_ARGS=()
for tag in "${TAGS[@]}"; do
  BUILD_ARGS+=(-t "$tag")
done
docker build "${BUILD_ARGS[@]}" .
echo "  镜像构建完成: ${TAGS[*]}"

echo "▶ [3/3] docker push"
for tag in "${TAGS[@]}"; do
  docker push "$tag"
done

echo "✓ 完成: ${TAGS[*]}"
