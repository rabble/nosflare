#!/bin/bash
# Test script for Prometheus metrics endpoint

set -e

# Configuration
RELAY_URL="${RELAY_URL:-http://localhost:8787}"
METRICS_USERNAME="${METRICS_USERNAME:-metrics}"
METRICS_PASSWORD="${METRICS_PASSWORD:-test}"

echo "Testing Prometheus metrics endpoint..."
echo "Relay URL: $RELAY_URL"
echo ""

# Test 1: Access without authentication (should fail with 401)
echo "Test 1: Accessing without authentication (should return 401)..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$RELAY_URL/metrics")
if [ "$HTTP_CODE" = "401" ]; then
    echo "✓ Correctly rejected unauthenticated request"
else
    echo "✗ Expected 401, got $HTTP_CODE"
    exit 1
fi
echo ""

# Test 2: Access with wrong credentials (should fail with 401)
echo "Test 2: Accessing with wrong credentials (should return 401)..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "wrong:credentials" "$RELAY_URL/metrics")
if [ "$HTTP_CODE" = "401" ]; then
    echo "✓ Correctly rejected wrong credentials"
else
    echo "✗ Expected 401, got $HTTP_CODE"
    exit 1
fi
echo ""

# Test 3: Access with correct credentials (should succeed)
echo "Test 3: Accessing with correct credentials..."
RESPONSE=$(curl -s -u "$METRICS_USERNAME:$METRICS_PASSWORD" "$RELAY_URL/metrics")
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$METRICS_USERNAME:$METRICS_PASSWORD" "$RELAY_URL/metrics")

if [ "$HTTP_CODE" = "200" ]; then
    echo "✓ Successfully authenticated"
else
    echo "✗ Expected 200, got $HTTP_CODE"
    exit 1
fi
echo ""

# Test 4: Verify Prometheus format
echo "Test 4: Verifying Prometheus exposition format..."
if echo "$RESPONSE" | grep -q "^# HELP"; then
    echo "✓ Found HELP comments"
else
    echo "✗ Missing HELP comments"
    exit 1
fi

if echo "$RESPONSE" | grep -q "^# TYPE"; then
    echo "✓ Found TYPE comments"
else
    echo "✗ Missing TYPE comments"
    exit 1
fi

if echo "$RESPONSE" | grep -q "^divine_nostr_"; then
    echo "✓ Found metric lines"
else
    echo "✗ Missing metric lines"
    exit 1
fi
echo ""

# Test 5: Check for expected metrics
echo "Test 5: Checking for expected metrics..."
EXPECTED_METRICS=(
    "divine_nostr_client_messages_total"
    "divine_nostr_relay_messages_total"
    "divine_nostr_events_total"
    "divine_nostr_metrics_last_update_timestamp"
)

for metric in "${EXPECTED_METRICS[@]}"; do
    if echo "$RESPONSE" | grep -q "$metric"; then
        echo "✓ Found $metric"
    else
        echo "⚠ Metric $metric not found (may be empty if no traffic yet)"
    fi
done
echo ""

# Test 6: Verify Content-Type header
echo "Test 6: Verifying Content-Type header..."
CONTENT_TYPE=$(curl -s -I -u "$METRICS_USERNAME:$METRICS_PASSWORD" "$RELAY_URL/metrics" | grep -i "content-type" | cut -d' ' -f2- | tr -d '\r')
if echo "$CONTENT_TYPE" | grep -q "text/plain"; then
    echo "✓ Correct Content-Type: $CONTENT_TYPE"
else
    echo "✗ Wrong Content-Type: $CONTENT_TYPE"
    exit 1
fi
echo ""

# Display sample output
echo "Sample metrics output:"
echo "---"
echo "$RESPONSE" | head -20
if [ $(echo "$RESPONSE" | wc -l) -gt 20 ]; then
    echo "... (truncated)"
fi
echo "---"
echo ""

echo "✓ All tests passed!"
echo ""
echo "To scrape these metrics with Prometheus, add this to your prometheus.yml:"
echo ""
echo "scrape_configs:"
echo "  - job_name: 'nosflare'"
echo "    scrape_interval: 30s"
echo "    static_configs:"
echo "      - targets: ['$(echo $RELAY_URL | sed 's|http://||' | sed 's|https://||')']"
echo "    metrics_path: /metrics"
echo "    scheme: $(echo $RELAY_URL | grep -q 'https://' && echo 'https' || echo 'http')"
echo "    basic_auth:"
echo "      username: $METRICS_USERNAME"
echo "      password: $METRICS_PASSWORD"
