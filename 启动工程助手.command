#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
printf '\nEngineerAgent 本地工作台\n首次启动会联网安装缺失依赖；不会自动调用模型。\n\n'
if ! command -v node >/dev/null 2>&1; then
  printf '请先安装 Node.js ≥24.10（含 npm）：https://nodejs.org/\n'
  printf '安装后重新双击本文件。\n'
  read -r '?按回车关闭…'
  exit 1
fi
node scripts/start-local.mjs --install --open
result=$?
if (( result != 0 )); then
  printf '\n未成功启动，请保留上方诊断；常见问题见 README.md。\n'
  read -r '?按回车关闭…'
fi
exit "$result"
