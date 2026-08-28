#!/usr/bin/env bash
# 从 dsh monorepo 同步 telegram 插件的源码/测试/文档, 并在 monorepo 内重建 lib/,
# 再把模块产物同步回本独立仓库 (lib/ 提交进 git, 消费者免构建直接可用)。
#
# 用法: bash scripts/sync-from-monorepo.sh [monorepo路径]
#   默认 monorepo 路径: ../dsh/src (相对本仓库根)
#
# 注意: package.json 本仓库与 monorepo 的依赖声明不同 (独立仓库把 @deepseek-ai/*
# 全部放 peerDependencies, 并带 dsh.bundle 字段), 不会被覆盖; 仅同步 version 字段。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MONO="${1:-$(dirname "$ROOT")/dsh/src}"
PKG="$MONO/packages/host/telegram"

if [ ! -f "$PKG/tsdown.config.ts" ]; then
  echo "错误: 找不到 monorepo 包目录 $PKG" >&2
  exit 1
fi

echo "==> 同步源码/测试/文档..."
rsync -a --delete \
  "$PKG/src/" "$ROOT/src/"
rsync -a --delete \
  "$PKG/tests/" "$ROOT/tests/"
rsync -a --delete \
  "$PKG/docs/" "$ROOT/docs/"
# README* 由本仓库本地维护(含"安装"章节,monorepo 版没有),不被同步覆盖;
# monorepo 正文有变更需要时手动 merge 进本仓库的 README。
cp "$PKG/tsconfig.json" "$PKG/tsdown.config.ts" "$ROOT/"

echo "==> 在 monorepo 内构建 $PKG (tsc -b + tsdown)..."
(cd "$MONO" && pnpm --filter @deepseek-ai/dsh-host-telegram exec tsc -b && pnpm --filter @deepseek-ai/dsh-host-telegram exec tsdown)

echo "==> 同步 lib/ 产物..."
rm -rf "$ROOT/lib"
cp -r "$PKG/lib" "$ROOT/lib"
rm -f "$ROOT/lib/tsconfig.tsbuildinfo"

python3 - "$ROOT/package.json" "$PKG/package.json" <<'PY'
import json, sys
standalone, mono = sys.argv[1], sys.argv[2]
with open(standalone) as f:
    data = json.load(f)
with open(mono) as f:
    mono_data = json.load(f)
data["version"] = mono_data["version"]
with open(standalone, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"==> version 同步为 {mono_data['version']}")
PY

echo "==> 完成。请检查 git diff 并 commit。"