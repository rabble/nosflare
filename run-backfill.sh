#!/bin/bash
# ABOUTME: Runs the backfill worker in chunks until complete
# ABOUTME: Each chunk processes 2000 events

URL="https://nosflare-backfill-fts5.protestnet.workers.dev"
MAX_ITERATIONS=100  # Safety limit

echo "Starting backfill process..."
echo "================================"

for ((i=1; i<=MAX_ITERATIONS; i++)); do
  echo ""
  echo "Iteration $i..."

  # Run backfill
  response=$(curl -s -X POST "$URL/backfill")

  # Check if successful
  success=$(echo "$response" | jq -r '.success')

  if [ "$success" != "true" ]; then
    echo "ERROR: Backfill failed"
    echo "$response" | jq '.'
    exit 1
  fi

  # Extract stats
  type=$(echo "$response" | jq -r '.type')
  processed=$(echo "$response" | jq -r '.processed')
  duration=$(echo "$response" | jq -r '.duration')
  complete=$(echo "$response" | jq -r '.complete')
  message=$(echo "$response" | jq -r '.message')

  echo "  Type: $type"
  echo "  Processed: $processed events"
  echo "  Duration: $duration"
  echo "  Status: $message"

  # Check if complete
  if [ "$complete" = "true" ]; then
    echo ""
    echo "================================"
    echo "BACKFILL COMPLETE!"
    echo "Total iterations: $i"

    # Get final status
    echo ""
    echo "Final Status:"
    curl -s "$URL/status" | jq '.'
    exit 0
  fi

  # Small delay between requests
  sleep 1
done

echo ""
echo "WARNING: Reached max iterations ($MAX_ITERATIONS)"
echo "Backfill may not be complete"
