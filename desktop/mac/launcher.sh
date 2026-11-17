#!/bin/bash
# Medicus Vitae for macOS (the app's Contents/MacOS/Medicus Vitae; scripts/package.mjs puts it there).
#
# Opening the app starts the server in the background if it isn't running yet, waits until
# it answers, and opens Medicus in the default browser. The app itself exits right away:
# the server keeps running until you press Quit in Medicus's sidebar (or log out), and
# opening the app again just opens the browser.
#
# Data and settings live outside the app, in ~/Library/Application Support/Medicus Vitae
# (data/, .env, logs/), so replacing the app with a newer version keeps everything.

set -u
NAME="Medicus Vitae"
CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
APP="$CONTENTS/Resources/app"
NODE="$APP/runtime/node"
SUPPORT="$HOME/Library/Application Support/$NAME"
ENV_FILE="$SUPPORT/.env"
LOGS="$SUPPORT/logs"
LOG="$LOGS/server.log"

mkdir -p "$LOGS"

alert() {
	/usr/bin/osascript - "$NAME" "$1" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
	display alert (item 1 of argv) message (item 2 of argv) as critical
end run
APPLESCRIPT
}

# A value from the .env file, or empty.
setting() {
	[ -f "$ENV_FILE" ] || return 0
	sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 | tr -d '"\r' | sed 's/[[:space:]]*$//'
}

PORT="$(setting PORT)"
PORT="${PORT:-8080}"
URL="http://localhost:$PORT/"
HEALTH="http://127.0.0.1:$PORT/api/health"

healthy() {
	/usr/bin/curl -fsS -m 2 "$HEALTH" 2>/dev/null | grep -q '"medicus-vitae"'
}

if healthy; then
	open "$URL"
	exit 0
fi

DATA="$(setting CORTEX_DATA_DIR)"
case "$DATA" in
	/*) ;;                                # an absolute path from .env
	"") DATA="$SUPPORT/data" ;;
	*) DATA="$SUPPORT/$DATA" ;;           # relative paths are relative to Application Support
esac

# Keep the log from growing without end.
if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
	mv -f "$LOG" "$LOG.old"
fi

export CORTEX_ENV_FILE="$ENV_FILE"
export CORTEX_DATA_DIR="$DATA"
# The browser extension (Jack Westin import) is loaded from a folder that stays put.
export CORTEX_EXTENSION_DIR="$SUPPORT/browser-extension"
export CORTEX_LAUNCHER="mac"

cd "$APP" || { alert "The app is incomplete. Download Medicus Vitae again."; exit 1; }
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting from $APP" >>"$LOG"
# nohup: the server keeps running after this script exits (a non-interactive shell leaves
# background jobs alone when it ends, and they ignore the hangup signal).
nohup "$NODE" "$APP/server/index.js" </dev/null >>"$LOG" 2>&1 &
PID=$!

# Wait up to two minutes for the server (the first start sets up a new database).
for _ in $(seq 1 240); do
	if healthy; then
		open "$URL"
		exit 0
	fi
	if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
		wait "$PID" 2>/dev/null
		CODE=$?
		PID=""
		case "$CODE" in
			3)
				alert "Port $PORT is already used by another program. Add a line PORT=8090 (or another free number) to $ENV_FILE, then open Medicus Vitae again."
				exit 1
				;;
			4)
				# Already starting from an earlier click: keep waiting for it.
				;;
			*)
				alert "Medicus Vitae stopped while starting (code $CODE). The details are in $LOG."
				open -R "$LOG"
				exit 1
				;;
		esac
	fi
	sleep 0.5
done

alert "Medicus Vitae is taking unusually long to start. The details are in $LOG."
exit 1
