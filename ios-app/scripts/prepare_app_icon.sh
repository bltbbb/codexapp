#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICON_DIR="${1:-$SCRIPT_DIR/../CodexRemote/Assets.xcassets/AppIcon.appiconset}"
ICON_PATH="$ICON_DIR/Icon.png"

if [ ! -f "$ICON_PATH" ]; then
  echo "未找到 AppIcon 文件: $ICON_PATH"
  exit 1
fi

if ! command -v /usr/bin/sips >/dev/null 2>&1; then
  echo "当前环境缺少 sips，无法自动规范化 AppIcon。"
  exit 1
fi

width="$(/usr/bin/sips -g pixelWidth "$ICON_PATH" 2>/dev/null | awk '/pixelWidth:/ {print $2}')"
height="$(/usr/bin/sips -g pixelHeight "$ICON_PATH" 2>/dev/null | awk '/pixelHeight:/ {print $2}')"

if [ "$width" = "1024" ] && [ "$height" = "1024" ]; then
  echo "AppIcon 已符合要求: ${width}x${height}"
  exit 0
fi

tmp_icon="$(mktemp "${TMPDIR:-/tmp}/codexremote-appicon.XXXXXX.png")"
trap 'rm -f "$tmp_icon"' EXIT

echo "检测到 AppIcon 尺寸为 ${width}x${height}，正在生成 1024x1024 版本。"
/usr/bin/sips -z 1024 1024 "$ICON_PATH" --out "$tmp_icon" >/dev/null
/bin/mv "$tmp_icon" "$ICON_PATH"

updated_width="$(/usr/bin/sips -g pixelWidth "$ICON_PATH" 2>/dev/null | awk '/pixelWidth:/ {print $2}')"
updated_height="$(/usr/bin/sips -g pixelHeight "$ICON_PATH" 2>/dev/null | awk '/pixelHeight:/ {print $2}')"

echo "AppIcon 已更新为 ${updated_width}x${updated_height}"
