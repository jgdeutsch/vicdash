#!/bin/bash

# --- CONFIG ---
API_KEY="${API_KEY:-YOUR_API_KEY}" # or export API_KEY in env
BASE_URL="https://api.mailshake.com/2017-04-01"
OUTPUT_FILE="${OUTPUT_FILE:-$HOME/mailshake_stats.json}"

# Accept campaigns via CLI or edit this array
CAMPAIGNS=("$@")

if [ ${#CAMPAIGNS[@]} -eq 0 ]; then
  echo "No campaign IDs provided. Usage: ./collect_mailshake_stats.sh <id1> <id2> ..."
  exit 1
fi

jq --version >/dev/null 2>&1 || { echo "jq is required"; exit 1; }

# --- HELPERS ---
get_paginated() {
  local endpoint=$1; shift
  local nextToken=""

  while :; do
    response=$(curl -s -G "$BASE_URL/$endpoint" \
      --data-urlencode "apiKey=$API_KEY" \
      --data-urlencode "perPage=100" \
      "$@" \
      --data-urlencode "nextToken=$nextToken")

    echo "$response" | jq -c '.results[]' 2>/dev/null

    nextToken=$(echo "$response" | jq -r '.nextToken')
    [ "$nextToken" == "null" -o -z "$nextToken" ] && break
    sleep 0.4
  done
}

get_campaign_info() {
  local campaign_id=$1
  curl -s -G "$BASE_URL/campaigns/get" \
    --data-urlencode "apiKey=$API_KEY" \
    --data-urlencode "campaignID=$campaign_id"
}

# --- INIT JSON ---
if [[ ! -f "$OUTPUT_FILE" ]]; then
  echo '{"campaigns": {}, "lastUpdated": ""}' > "$OUTPUT_FILE"
fi

# --- MAIN ---
for CAMPAIGN_ID in "${CAMPAIGNS[@]}"; do
  echo "Processing campaign $CAMPAIGN_ID..."

  INFO=$(get_campaign_info "$CAMPAIGN_ID")
  TITLE=$(echo "$INFO" | jq -r '.title // "Unknown Title"')
  SENDER=$(echo "$INFO" | jq -r '.sender.emailAddress // "Unknown Sender"')

  # Sends
  SENDS=$(get_paginated "activity/sent" --data-urlencode "campaignID=$CAMPAIGN_ID" | wc -l | tr -d ' ')

  # Replies (same as before, count events)
  REPLIES=$(get_paginated "activity/replies" --data-urlencode "campaignID=$CAMPAIGN_ID" --data-urlencode "replyType=reply" | wc -l | tr -d ' ')

  # Leads
  WON=$(get_paginated "leads/list" --data-urlencode "campaignID=$CAMPAIGN_ID" --data-urlencode "status=closed" | wc -l | tr -d ' ')
  LOST=$(get_paginated "leads/list" --data-urlencode "campaignID=$CAMPAIGN_ID" --data-urlencode "status=lost" | wc -l | tr -d ' ')
  OPEN_LEADS=$(get_paginated "leads/list" --data-urlencode "campaignID=$CAMPAIGN_ID" --data-urlencode "status=open" | wc -l | tr -d ' ')

  # Unique opens by recipient email (fallback to recipient/lead id if email missing)
  # Build a newline list of identifiers and uniq it.
  UNIQUE_OPENS=$(get_paginated "activity/opens" --data-urlencode "campaignID=$CAMPAIGN_ID" \
    | jq -r '(
        .recipient.emailAddress // .lead.emailAddress // .emailAddress // ("id:" + ( .recipient.id // .lead.id // .recipientID // .leadID | tostring ))
      )?'
    | grep -v '^null$' | sort -u | wc -l | tr -d ' ')

  # Update JSON
  jq --arg id "$CAMPAIGN_ID" \
     --arg title "$TITLE" \
     --arg sender "$SENDER" \
     --argjson sends "${SENDS:-0}" \
     --argjson uniqueOpens "${UNIQUE_OPENS:-0}" \
     --argjson replies "${REPLIES:-0}" \
     --argjson won "${WON:-0}" \
     --argjson lost "${LOST:-0}" \
     --argjson openleads "${OPEN_LEADS:-0}" \
     '.campaigns[$id] = {
        "title": $title,
        "sender": $sender,
        "stats": {
          "sends": $sends,
          "uniqueOpens": $uniqueOpens,
          "replies": $replies,
          "leads": { "won": $won, "lost": $lost, "open": $openleads }
        }
      }' "$OUTPUT_FILE" > tmp.$$.json && mv tmp.$$.json "$OUTPUT_FILE"
done

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq --arg time "$TIMESTAMP" '.lastUpdated = $time' "$OUTPUT_FILE" > tmp.$$.json && mv tmp.$$.json "$OUTPUT_FILE"

echo "✅ Updated $OUTPUT_FILE"


