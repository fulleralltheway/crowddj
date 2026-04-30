#!/usr/bin/env bash
# One-shot soak check for the bluegrass-stop-after-fix deploy (merge 32cc0c9
# pushed to main on 2026-04-29 ~23:32 EDT). Scheduled via LaunchAgent
# com.jonathanfuller.bluegrasssoak.plist to fire once at 2026-05-01 13:23 EDT.
#
# After a successful run, the agent unloads itself and removes its plist so
# this won't re-fire next year.
set -uo pipefail

REPO_DIR="$HOME/spotifyapp"
REPORT_DIR="$REPO_DIR/.studio/reviews"
REPORT="$REPORT_DIR/bluegrass-stop-after-fix-soak.md"
LOG="$HOME/Library/Logs/bluegrass-soak.log"
EXPECTED_COMMIT="32cc0c9"
PRIOR_COMMIT="feda5b5"
PHONE="8042455034"

mkdir -p "$REPORT_DIR"
exec >>"$LOG" 2>&1
echo "===== $(date) — soak run ====="

# Load Homebrew so vercel/gh/git resolve under launchd's stripped PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

cd "$REPO_DIR" || { echo "spotifyapp checkout missing"; exit 1; }

# 1. Confirm deploy held
git fetch origin main --quiet
HEAD_SHA=$(git log -1 origin/main --format='%H')
HEAD_SHORT=$(printf '%s' "$HEAD_SHA" | cut -c1-7)
HEAD_SUBJECT=$(git log -1 origin/main --format='%s')
echo "main HEAD: $HEAD_SHORT — $HEAD_SUBJECT"

DEPLOY_STATE="live"
if [[ "$HEAD_SHORT" == "$PRIOR_COMMIT" ]]; then
  DEPLOY_STATE="reverted"
elif ! git merge-base --is-ancestor "$EXPECTED_COMMIT" "$HEAD_SHA" 2>/dev/null; then
  DEPLOY_STATE="unknown"
fi

# 2. Production HTTP
PROD_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://crowddj.vercel.app/bluegrass || echo "000")
echo "prod HTTP: $PROD_CODE"

# Build the iMessage early so we can short-circuit if the deploy reverted.
if [[ "$DEPLOY_STATE" == "reverted" ]]; then
  MSG=$'the bluegrass fix got reverted on main\nwant me to look into why'
  ~/tools/imessage.sh send "$PHONE" "$MSG"
  cat >"$REPORT" <<EOF
# Bluegrass stop-after-fix — soak check ($(date '+%Y-%m-%d %H:%M %Z'))

**Deploy state:** REVERTED — main HEAD is $HEAD_SHORT ($HEAD_SUBJECT)
**Production HTTP:** $PROD_CODE
**Result:** STOP — no further checks run.
EOF
  exit 0
fi

# 3. Vercel logs (best effort — auth may be stale)
LOG_RAW=$(mktemp)
LOG_OK=true
if ! vercel logs https://crowddj.vercel.app --since 30h >"$LOG_RAW" 2>&1; then
  LOG_OK=false
fi
LOG_LINE_COUNT=$(wc -l <"$LOG_RAW" | tr -d ' ')

if $LOG_OK && [[ "$LOG_LINE_COUNT" -gt 0 ]]; then
  COUNT_5XX_NEW=$(grep -E '/api/bluegrass/sessions/[^ ]+/fade-transition.* (5[0-9][0-9])' "$LOG_RAW" | wc -l | tr -d ' ')
  COUNT_5XX_CRON=$(grep -E '/api/cron/bluegrass-fade-transition.* (5[0-9][0-9])' "$LOG_RAW" | wc -l | tr -d ' ')
  COUNT_TRANSITION_THREW=$(grep -c 'transition_threw' "$LOG_RAW" || true)
  COUNT_EXTERNAL=$(grep -c 'external_context' "$LOG_RAW" || true)
  COUNT_PAUSED=$(grep -c 'playback_paused' "$LOG_RAW" || true)
  COUNT_SKIP_FAILED=$(grep -c 'skip_failed' "$LOG_RAW" || true)
  COUNT_CONCURRENT=$(grep -c 'concurrent_transition_in_flight' "$LOG_RAW" || true)
else
  COUNT_5XX_NEW="?"
  COUNT_5XX_CRON="?"
  COUNT_TRANSITION_THREW="?"
  COUNT_EXTERNAL="?"
  COUNT_PAUSED="?"
  COUNT_SKIP_FAILED="?"
  COUNT_CONCURRENT="?"
fi

# Verdict
VERDICT="PASS"
if [[ "$DEPLOY_STATE" != "live" ]]; then VERDICT="FAIL — deploy state $DEPLOY_STATE"; fi
if [[ "$PROD_CODE" != "200" && "$PROD_CODE" != "302" && "$PROD_CODE" != "307" ]]; then
  VERDICT="FAIL — prod HTTP $PROD_CODE"
fi
if [[ "$COUNT_5XX_NEW" != "?" && "$COUNT_5XX_NEW" -gt 5 ]]; then
  VERDICT="FAIL — $COUNT_5XX_NEW 5xx on /fade-transition"
fi
if [[ "$COUNT_TRANSITION_THREW" != "?" && "$COUNT_TRANSITION_THREW" -gt 5 ]]; then
  VERDICT="WARN — $COUNT_TRANSITION_THREW transition_threw events"
fi

# 4. Report
cat >"$REPORT" <<EOF
# Bluegrass stop-after-fix — soak check ($(date '+%Y-%m-%d %H:%M %Z'))

## Deploy state
- main HEAD: \`$HEAD_SHORT\` — $HEAD_SUBJECT
- State: **$DEPLOY_STATE**

## Production
- \`GET /bluegrass\`: HTTP $PROD_CODE

## Vercel logs (last 30h)
- Logs available: $($LOG_OK && echo "yes ($LOG_LINE_COUNT lines)" || echo "NO — vercel CLI returned an error, see $LOG")
- 5xx on /api/bluegrass/sessions/*/fade-transition (NEW endpoint): **$COUNT_5XX_NEW**
- 5xx on /api/cron/bluegrass-fade-transition: **$COUNT_5XX_CRON**
- \`transition_threw\` (uncaught throw inside fade): **$COUNT_TRANSITION_THREW**
- \`external_context\` (user playing different playlist): $COUNT_EXTERNAL
- \`playback_paused\` (timer fired while user paused): $COUNT_PAUSED
- \`skip_failed\` (Spotify advance error): **$COUNT_SKIP_FAILED**
- \`concurrent_transition_in_flight\` (cooldown rejection — expected, low count): $COUNT_CONCURRENT

## Verdict
**$VERDICT**

EOF

# 5. iMessage Jonathan
if $LOG_OK; then
  if [[ "$VERDICT" == PASS* ]]; then
    LINE2="errors look normal"
  elif [[ "$VERDICT" == WARN* ]]; then
    LINE2="seeing $COUNT_TRANSITION_THREW fade throws, worth a look"
  else
    LINE2="seeing some errors — check the report"
  fi
else
  LINE2="couldn't pull logs, check vercel dashboard"
fi
MSG="bluegrass fix is live on prod"$'\n'"$LINE2"$'\n'"did stop-after-current resume from the right track this time"
~/tools/imessage.sh send "$PHONE" "$MSG"

# 6. Self-cleanup so this doesn't re-fire next May 1
launchctl unload "$HOME/Library/LaunchAgents/com.jonathanfuller.bluegrasssoak.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.jonathanfuller.bluegrasssoak.plist"

echo "===== done — verdict: $VERDICT ====="
exit 0
