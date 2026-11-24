#!/usr/bin/env bash
# Removes the Video Saver yt-dlp helper's browser registrations and generated files
# (macOS and Linux). Your yt-dlp and downloaded videos are not touched.
set -euo pipefail
HOST_NAME="com.videosaver.ytdlp"
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(uname -s)" = "Darwin" ]; then
  APP="$HOME/Library/Application Support"
  DIRS=("$APP/Google/Chrome/NativeMessagingHosts" "$APP/Microsoft Edge/NativeMessagingHosts" "$APP/BraveSoftware/Brave-Browser/NativeMessagingHosts" "$APP/Chromium/NativeMessagingHosts" "$APP/Vivaldi/NativeMessagingHosts" "$APP/Mozilla/NativeMessagingHosts")
else
  CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
  DIRS=("$CFG/google-chrome/NativeMessagingHosts" "$CFG/microsoft-edge/NativeMessagingHosts" "$CFG/BraveSoftware/Brave-Browser/NativeMessagingHosts" "$CFG/chromium/NativeMessagingHosts" "$CFG/vivaldi/NativeMessagingHosts" "$HOME/.mozilla/native-messaging-hosts")
fi
for d in "${DIRS[@]}"; do rm -f "$d/$HOST_NAME.json"; done
rm -f "$HOST_DIR/$HOST_NAME.json" "$HOST_DIR/$HOST_NAME.firefox.json" "$HOST_DIR/host.sh" "$HOST_DIR/config.json" "$HOST_DIR/host.log"
echo "Removed the Video Saver yt-dlp helper."
