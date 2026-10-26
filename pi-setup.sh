#!/usr/bin/env bash
# 树莓派一键环境修复脚本（toggl webhook自动实时推送到notion数据库 V3）
# 做三件事：装项目专用 Node 22（不动系统 Node）、用国内镜像重建 Linux arm64 依赖、跑自检。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_DIR="$HOME/.local/node22"
NODE_VERSION="v22.20.0"
MIRROR="https://registry.npmmirror.com"

cd "$PROJECT_DIR"

if ! "$NODE_DIR/bin/node" -v 2>/dev/null | grep -q '^v22\.'; then
  echo "==> 安装 Node $NODE_VERSION 到 $NODE_DIR"
  mkdir -p "$NODE_DIR"
  curl -sL "$MIRROR/-/binary/node/latest-v22.x/node-$NODE_VERSION-linux-arm64.tar.xz" -o /tmp/node22.tar.xz
  tar -xJf /tmp/node22.tar.xz -C "$NODE_DIR" --strip-components=1
  rm -f /tmp/node22.tar.xz
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "==> Node: $(node -v)  npm: $(npm -v)"

echo "==> npm ci（镜像：$MIRROR）"
npm ci --no-audit --no-fund --registry="$MIRROR"

echo "==> TypeScript 检查"
npx tsc --noEmit
echo "==> 单元测试"
npx vitest run
echo "==> Worker 打包检查（dry-run，不上传）"
CI=true npx wrangler deploy --dry-run

echo
echo "全部通过。以后在此目录执行 npm 命令前，先运行：source ./pi-env.sh"
