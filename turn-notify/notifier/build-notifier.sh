#!/bin/bash
# 构建 turn-notify 的通知小应用（macOS）。
#
# 为什么不用 osascript 直接发通知：`display notification` 由 StandardAdditions 实现，
# 需要一个 GUI 应用当归属方，macOS 会拉起 Script Editor 并让它常驻程序坞。
# 这里改用 osacompile 生成一个「自己的」applet：它自己就是通知归属方，
# 再把 LSUIElement 设为 true（配件应用，不进程序坞），本地 ad-hoc 签名后即可直接执行。
#
# 用法：build-notifier.sh [显示名]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$here/DSHNotify.app"
display_name="${1:-DSH Notify}"

rm -rf "$app"
/usr/bin/osacompile -o "$app" \
  -e 'on run argv' \
  -e '  set theBody to item 1 of argv' \
  -e '  set theTitle to item 2 of argv' \
  -e '  set theSubtitle to item 3 of argv' \
  -e '  set theSound to item 4 of argv' \
  -e '  if theSound is "" then' \
  -e '    display notification theBody with title theTitle subtitle theSubtitle' \
  -e '  else' \
  -e '    display notification theBody with title theTitle subtitle theSubtitle sound name theSound' \
  -e '  end if' \
  -e 'end run'

plist="$app/Contents/Info.plist"
set_or_add() {
  /usr/libexec/PlistBuddy -c "Set $1 $2" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add $1 $2" "$plist" >/dev/null
}
set_or_add ":LSUIElement" "bool true"
set_or_add ":CFBundleIdentifier" "string com.local.dsh-turn-notify"
set_or_add ":CFBundleName" "string $display_name"

if [ -f "$here/icon.icns" ]; then
  cp "$here/icon.icns" "$app/Contents/Resources/icon.icns"
  set_or_add ":CFBundleIconFile" "string icon.icns"
fi

/usr/bin/codesign --force -s - "$app" >/dev/null 2>&1 || true
echo "built: $app"
