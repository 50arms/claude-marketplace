#!/usr/bin/env bash
# inject-time — the model's only clock. Fires on UserPromptSubmit and PostToolUse;
# prints wall-clock time with its UTC offset plus the time since the last fire:
#   09/28/2026 01:12:03 -06:00 +0     first fire / new day -> full date
#   01:12:08 -06:00 +5s               same day -> time only
# State is per session (session_id from the stdin JSON).
#
# Parses stdin with node, never jq (absent on the Windows host, where it made
# this hook silently emit nothing). Never wire it on Stop: stdout from a Stop
# hook re-wakes the turn and loops forever.
set -euo pipefail

EVENT="${1:-UserPromptSubmit}"
PAYLOAD="$(cat)"

SID="$(printf '%s' "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)?.session_id??""))}catch{process.stdout.write("")}})' 2>/dev/null || true)"
[ -n "$SID" ] || SID="nosession"
STATE="/tmp/claude-time-hook-${SID}"

NOW="$(date +%s)"
DATE_KEY="$(date +%Y%m%d)"            # for date-change detection
FULL="$(date +'%m/%d/%Y %H:%M:%S %:z')"   # MM/DD/YYYY HH:MM:SS ±HH:MM
TIME="$(date +'%H:%M:%S %:z')"            # HH:MM:SS ±HH:MM

LAST_EPOCH=""
LAST_DATE=""
if [[ -f "$STATE" ]]; then
  read -r LAST_EPOCH LAST_DATE < "$STATE" || true
fi

# date prefix: full date on first fire or when the day rolls over, else time-only
if [[ -z "$LAST_DATE" || "$LAST_DATE" != "$DATE_KEY" ]]; then
  STAMP="$FULL"
else
  STAMP="$TIME"
fi

# duration suffix
if [[ -z "$LAST_EPOCH" ]]; then
  DUR="+0"
else
  D=$(( NOW - LAST_EPOCH ))
  (( D < 0 )) && D=0
  H=$(( D / 3600 ))
  M=$(( (D % 3600) / 60 ))
  S=$(( D % 60 ))
  if (( D < 60 )); then
    DUR="+${S}s"
  elif (( D < 3600 )); then
    DUR="+${M}m"; (( S > 0 )) && DUR="${DUR} ${S}s"
  else
    DUR="+${H}h ${M}m"; (( S > 0 )) && DUR="${DUR} ${S}s"
  fi
fi

printf '%s %s\n' "$NOW" "$DATE_KEY" > "$STATE"

printf '%s\n' "${STAMP} ${DUR}"
