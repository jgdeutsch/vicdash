#!/bin/bash

# --- Setup ---
API_KEY="907a994a-2828-420e-aa95-d66d13d71513"
SEARCH_TERM="[VB]"
BASE_URL="https://api.mailshake.com/2017-04-01"

echo "Searching for campaigns with title containing: \"$SEARCH_TERM\""
echo "---"

# --- Loop through all pages ---
NEXT_TOKEN=""
PAGE_NUM=1
FOUND_COUNT=0

while true; do
    # Base parameters for curl
    declare -a PARAMS
    PARAMS+=("-d" "apiKey=$API_KEY")
    PARAMS+=("-d" "perPage=100") # Get max 100 per page
    PARAMS+=("-d" "search=$SEARCH_TERM")
    
    # Add nextToken if it exists from the previous loop
    if [ -n "$NEXT_TOKEN" ] && [ "$NEXT_TOKEN" != "null" ]; then
        PARAMS+=("-d" "nextToken=$NEXT_TOKEN")
    fi
    
    # Make the API call
    RESPONSE=$(curl -s -G "$BASE_URL/campaigns/list" "${PARAMS[@]}")
    
    # Use jq to extract and print the ID and Title
    # This filters the results and formats them
    echo "$RESPONSE" | jq -r '.results[] | "ID: \(.id)\tName: \(.title)"'
    
    # Get the count of results on this page
    PAGE_COUNT=$(echo "$RESPONSE" | jq '.results | length')
    FOUND_COUNT=$((FOUND_COUNT + PAGE_COUNT))
    
    # Get the next token for the next loop
    NEXT_TOKEN=$(echo "$RESPONSE" | jq -r '.nextToken')
    
    # If there's no next token or count is 0, we're done.
    if [ -z "$NEXT_TOKEN" ] || [ "$NEXT_TOKEN" == "null" ] || [ "$PAGE_COUNT" -eq 0 ]; then
        break
    fi
    
    PAGE_NUM=$((PAGE_NUM + 1))
done

echo "---"
echo "Search complete. Found $FOUND_COUNT matching campaigns."
