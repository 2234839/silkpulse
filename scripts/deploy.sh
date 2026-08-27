#!/usr/bin/env bash
# SilkPulse 部署脚本（敏感配置走 .env.deploy，不进 git）
# 用法: pnpm deploy [--skip-build]
#   --skip-build  跳过本地构建（产物已就绪时）
#
# 首次使用：cp .env.deploy.example .env.deploy 并填入实际值
# 流程: 清理旧产物 → 构建 → rsync 双路径同步 → 重启容器 → 健康检查 + hash 校验

set -euo pipefail

cd "$(dirname "$0")/.."

# 敏感配置（SSH 地址/服务器路径/域名）从 .env.deploy 读，不硬编码在脚本里
ENV_FILE=".env.deploy"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ 缺少 $ENV_FILE（敏感配置不进 git，参考 .env.deploy.example）" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${DEPLOY_SSH_HOST:?DEPLOY_SSH_HOST 未配置}"
: "${DEPLOY_REMOTE_CODE_DIR:?DEPLOY_REMOTE_CODE_DIR 未配置}"
: "${DEPLOY_REMOTE_COMPOSE_DIR:?DEPLOY_REMOTE_COMPOSE_DIR 未配置}"
: "${DEPLOY_HEALTH_URL:?DEPLOY_HEALTH_URL 未配置}"
: "${DEPLOY_TOOLS_URL:?DEPLOY_TOOLS_URL 未配置}"
: "${DEPLOY_SITE_URL:=$DEPLOY_TOOLS_URL%/tools}"

SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."

if [[ $SKIP_BUILD -eq 0 ]]; then
  echo "▶ [1/4] 清理旧产物并构建…"
  # 根构建 copy 步骤不清空 server/public，旧 hash 产物会堆积导致部署不生效（见 deploy-workflow.md 2026-08-24 教训）
  rm -rf packages/server/public/assets packages/server/public/index.html
  NODE_OPTIONS="--max-old-space-size=2048" pnpm build
else
  echo "▶ [1/4] 跳过构建（--skip-build）"
fi

echo "▶ [2/4] 校验构建产物完整性…"
[[ -f packages/server/dist/uws_linux_x64_137.node ]] || { echo "✗ dist/ 缺 uWS 二进制（构建方式错误，必须走 pnpm build）" >&2; exit 1; }
[[ -f packages/server/dist/bin/silkpulse.mjs ]] || { echo "✗ dist/bin/silkpulse.mjs 缺失" >&2; exit 1; }
[[ -f packages/server/public/index.html ]] || { echo "✗ public/index.html 缺失" >&2; exit 1; }
LOCAL_HASH=$(grep -o 'index-[^"]*\.js' packages/server/public/index.html | head -1)
echo "  本地 index hash: $LOCAL_HASH"# 产物自洽校验：index.html 引用的入口 js/css 必须真实存在于 assets 目录。
# 缺这步会部署出「新 html + 旧资产」混杂套，线上全部 /assets/* 回退 text/html → SPA 白屏（见 deploy-workflow.md 2026-08-27 教训）
for ref in $(grep -o 'assets/[^"]*\.[jt]s' packages/server/public/index.html | head -1) $(grep -o 'assets/[^"]*\.css' packages/server/public/index.html | head -1); do
  [[ -f "packages/server/public/$ref" ]] || { echo "✗ public/$ref（index.html 引用）不存在——html 与 assets 不同套！" >&2; exit 1; }
done
echo "  产物自洽 ✓"
echo "▶ [3/4] rsync 双路径同步 + 重启容器…"
rsync -az --delete packages/server/dist/ "$DEPLOY_SSH_HOST:$DEPLOY_REMOTE_CODE_DIR/dist/"
rsync -az --delete packages/server/public/ "$DEPLOY_SSH_HOST:$DEPLOY_REMOTE_CODE_DIR/public/"
# server bundle staticRoot=dist/public，双目录都同步（见 deploy-workflow.md 2026-08-24 教训）
ssh "$DEPLOY_SSH_HOST" "mkdir -p $DEPLOY_REMOTE_CODE_DIR/dist/public && rm -rf $DEPLOY_REMOTE_CODE_DIR/dist/public/assets && cp -r $DEPLOY_REMOTE_CODE_DIR/public/* $DEPLOY_REMOTE_CODE_DIR/dist/public/ && cd $DEPLOY_REMOTE_COMPOSE_DIR && docker compose restart"

echo "▶ [4/4] 等待启动并验证…"
sleep 5
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$DEPLOY_HEALTH_URL")
[[ "$CODE" == "200" ]] || { echo "✗ 健康检查失败: HTTP $CODE" >&2; exit 1; }
echo "  健康检查: 200 ✓"

REMOTE_HASH=$(curl -s "$DEPLOY_TOOLS_URL" | grep -o 'index-[^"]*\.js' | head -1)
if [[ "$REMOTE_HASH" == "$LOCAL_HASH" ]]; then
  echo "  hash 校验: $REMOTE_HASH ✓（与本地一致）"
else
  echo "✗ hash 不一致！本地=$LOCAL_HASH 线上=$REMOTE_HASH（静态资源未生效）" >&2
  exit 1
fi

# 资产 MIME 校验：状态码会骗人——SPA 回退把 /assets/* 响应成 200 的 text/html，
# 只有 Content-Type 能识别这种「看起来正常实则白屏」的错位（见 deploy-workflow.md 2026-08-27 教训）
for ext in js css; do
  ASSET_URL="$DEPLOY_SITE_URL/assets/${LOCAL_HASH%.js}.$ext"
  MIME=$(curl -sI "$ASSET_URL" | grep -i '^content-type:' | tail -1)
  case "$ext:$MIME" in
    js:*javascript*) ;;
    css:*text/css*) ;;
    *) echo "✗ 线上资产 MIME 异常: $ASSET_URL → ${MIME:-无响应}（期望 .${ext} 类型，疑似静态资源回退 text/html）" >&2; exit 1 ;;
  esac
done
echo "  资产 MIME 校验: js/css ✓"
echo "✓ 部署完成: $DEPLOY_TOOLS_URL"
