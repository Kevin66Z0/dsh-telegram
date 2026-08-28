#!/usr/bin/env bash
# dsh-host-telegram 一键安装到已有的 dsh 源码(deepseek-harness checkout)。
#
# 用法:
#   ./install.sh [dsh源码路径]
#   DSH_SRC_PATH=<路径> ./install.sh          # 或走环境变量
#   DSH_AUTO_CLONE=1 ./install.sh            # 没找到宿主时自动 clone 上游
#
# 可选环境变量:
#   DSH_HOME=<目录>   已设置时自动把 telegram 挂载行写进 <DSH_HOME>/profiles/web/cordis.patch.yml
#   SKIP_PNPM=1       跳过宿主 pnpm install(调试用)
#
# 安装后还需三件事(脚本末尾会提示):
#   1) 注入 botToken:  export TELEGRAM_BOT_TOKEN=<@BotFather token>, 或写入 $DSH_HOME/.env (0600)
#   2) 白名单:         $DSH_HOME/settings.yaml 的 telegram: 段填 allowChatIds (热加载)
#   3) 重启 dsh 服务
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$HERE/src" ] || { echo "错误: 请从插件仓库根目录执行 ./install.sh" >&2; exit 1; }
TARGET_PKG="src/packages/host/telegram"

# ── 1. 定位 dsh 宿主 ─────────────────────────────────────────────────────
HOST="${1:-${DSH_SRC_PATH:-}}"
if [ -z "$HOST" ]; then
  for cand in "$HERE/../dsh" "$HERE/../deepseek-harness" "$HERE/dsh" "$HOME/deepseek-harness" "$HOME/dsh"; do
    if [ -f "$cand/apps/cli/src/bin.ts" ]; then HOST="$cand"; break; fi
  done
fi
if [ -z "$HOST" ] || [ ! -f "$HOST/apps/cli/src/bin.ts" ]; then
  if [ "${DSH_AUTO_CLONE:-0}" = "1" ]; then
    HOST="$HERE/.dsh-host"
    echo "==> 未找到 dsh 源码, 自动 clone 上游 deepseek-ai/deepseek-harness ..."
    git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git "$HOST"
  else
    echo "错误: 未找到 dsh 源码。传路径: ./install.sh /path/to/deepseek-harness" >&2
    exit 1
  fi
fi
HOST="$(cd "$HOST" && pwd)"
echo "==> dsh 宿主: $HOST"

# ── 2. 同步源码(不动宿主的 package.json, 那是 monorepo 版清单)────────────
mkdir -p "$HOST/$TARGET_PKG"
rsync -a --delete "$HERE/src/"    "$HOST/$TARGET_PKG/src/"
rsync -a --delete "$HERE/tests/"  "$HOST/$TARGET_PKG/tests/"
rsync -a --delete "$HERE/docs/"   "$HOST/$TARGET_PKG/docs/"
cp -f "$HERE/tsconfig.json" "$HERE/tsdown.config.ts" "$HOST/$TARGET_PKG/"

# ── 3. package.json: 宿主已有则保留, 没有则生成 monorepo 版 ───────────────
if [ -f "$HOST/$TARGET_PKG/package.json" ]; then
  echo "==> 宿主已有该包, 保留其 monorepo 版 package.json"
else
  echo "==> 生成 monorepo 版 package.json ..."
  python3 - "$HERE/package.json" "$HOST/$TARGET_PKG/package.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    pkg = json.load(f)
deps = dict(pkg.get("dependencies", {}))
peers = dict(pkg.get("peerDependencies", {}))
devs = dict(pkg.get("peerDependencies", {}))
# @deepseek-ai/* 按 monorepo 惯例: schemastery 进 dependencies, 其余 peers + devs 镜像
sc = peers.pop("@deepseek-ai/schemastery", None)
if sc:
    deps["@deepseek-ai/schemastery"] = "workspace:^"
for name in list(peers):
    peers[name] = "workspace:^"
for name in list(devs):
    devs[name] = "workspace:^"
exports = {k: v for k, v in pkg.get("exports", {}).items() if k != "./cordis.patch.yml"}
files = [f for f in pkg.get("files", []) if f != "cordis.patch.yml"]
mono = {
    "name": pkg["name"],
    "description": pkg.get("description", ""),
    "version": pkg.get("version", "0.0.0"),
    "type": "module",
    "main": "lib/index.js",
    "types": "lib/types/index.d.ts",
    "exports": exports,
    "files": files,
    "license": "MIT",
    "dependencies": deps,
    "peerDependencies": peers,
    "devDependencies": devs,
}
with open(dst, "w") as f:
    json.dump(mono, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
fi

# ── 4. 宿主 workspace 注册 ───────────────────────────────────────────────
if [ "${SKIP_PNPM:-0}" = "0" ]; then
  echo "==> 宿主 pnpm install(注册/更新 workspace 包)..."
  (cd "$HOST" && pnpm install)
fi

# ── 5. 挂载行(profile patch)──────────────────────────────────────────────
MOUNTED=0
if [ -n "${DSH_HOME:-}" ] && [ -d "$DSH_HOME" ]; then
  PATCH="$DSH_HOME/profiles/web/cordis.patch.yml"
  mkdir -p "$(dirname "$PATCH")"
  touch "$PATCH"
  if ! grep -q "dsh-host-telegram" "$PATCH"; then
    printf -- "# dsh-host-telegram 安装器生成\n- insert:\n    - id: telegram\n      name: '@deepseek-ai/dsh-host-telegram'\n      config:\n        botToken: !!js process.env.TELEGRAM_BOT_TOKEN\n        allowChatIds: []\n" >> "$PATCH"
    echo "==> 已写入挂载行: $PATCH (allowChatIds 请在 settings 里配置)"
  else
    echo "==> $PATCH 已含 telegram 挂载行, 跳过"
  fi
  MOUNTED=1
fi

# ── 6. 收尾指引 ──────────────────────────────────────────────────────────
echo ""
echo "✅ 安装完成! 插件已在 $HOST/$TARGET_PKG"
if [ "$MOUNTED" = "0" ]; then
  echo "   (未检测到 DSH_HOME, 请手动把 telegram 插件行加入你的 profile cordis.patch.yml)"
fi
echo ""
echo "  接下来三步:"
echo "   1) 注入 token:  export TELEGRAM_BOT_TOKEN=<@BotFather token>"
echo "                    # 或写入 \$DSH_HOME/.env (0600, 推荐)"
echo "   2) 白名单:      \$DSH_HOME/settings.yaml 写 telegram: allowChatIds: [你的chatid] (热加载)"
echo "   3) 重启 dsh:    cd $HOST && <你的启动/部署命令>"