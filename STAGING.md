# Staging Environment Setup

This document explains how to set up and use the staging environment for the Divine Video relay.

## Overview

The staging environment provides a completely isolated testing environment with:
- Separate D1 database (no production data contamination)
- Separate R2 bucket for event archives
- Separate Durable Objects namespace
- Different relay info (shows "STAGING" indicator)
- Independent deployment and configuration

## Architecture

```
Production:
- Worker: nosflare
- Database: nostr-relay (8beb11fa-ff53-462e-82a4-64a8a7db68a2)
- Bucket: nostr-event-archive
- Domain: relay.divine.video

Staging:
- Worker: nosflare-staging
- Database: nostr-relay-staging (needs creation)
- Bucket: nostr-event-archive-staging (needs creation)
- Domain: staging-relay.divine.video (after setup)
```

## Initial Setup

### Step 1: Create Staging Resources

#### Create D1 Database

**Option A: Via Dashboard (Recommended)**
1. Go to https://dash.cloudflare.com
2. Navigate to **Workers & Pages** → **D1**
3. Click **Create database**
4. Name: `nostr-relay-staging`
5. Click **Create**
6. Copy the database ID from the details page

**Option B: Via CLI** (requires API token with D1 permissions)
```bash
wrangler d1 create nostr-relay-staging
```

#### Create R2 Bucket

**Via Dashboard:**
1. Go to https://dash.cloudflare.com
2. Navigate to **R2**
3. Click **Create bucket**
4. Name: `nostr-event-archive-staging`
5. Click **Create bucket**

**Via CLI:**
```bash
wrangler r2 bucket create nostr-event-archive-staging
```

### Step 2: Update Configuration

Edit `wrangler.toml` and replace `<STAGING_DB_ID>` with your staging database ID:

```toml
[[env.staging.d1_databases]]
binding = "RELAY_DATABASE"
database_name = "nostr-relay-staging"
database_id = "YOUR-STAGING-DB-ID-HERE"  # Replace this
```

### Step 3: Deploy Staging Worker

```bash
npm run deploy:staging
```

This will:
- Build the worker code
- Deploy to the `nosflare-staging` worker
- Run database migrations automatically on first request
- Create the staging environment

### Step 4: Verify Deployment

Check that staging is running:

```bash
# Check NIP-11 info (should show "STAGING" in name/description)
curl -H "Accept: application/nostr+json" https://nosflare-staging.<your-subdomain>.workers.dev

# View logs
npm run tail:staging
```

### Step 5: Set Up Custom Domain (Optional)

**Via Dashboard:**
1. Add DNS record for `staging-relay.divine.video`:
   - Type: CNAME
   - Name: `staging.relay`
   - Target: `nosflare-staging.<your-subdomain>.workers.dev`
   - Proxy: Enabled (orange cloud)

2. Or add route in Cloudflare dashboard:
   - Workers & Pages → nosflare-staging → Settings → Triggers → Add Route
   - Route: `staging-relay.divine.video/*`
   - Zone: `divine.video`

## Usage

### Deployment Commands

```bash
# Deploy to staging
npm run deploy:staging

# Deploy to production
npm run deploy

# Check what would be deployed (dry-run)
npm run deploy:staging:check
npm run deploy:check

# View logs
npm run tail:staging
npm run tail
```

### Development Commands

```bash
# Run local dev server (production config)
npm run dev

# Run local dev server (staging config)
npm run dev:staging
```

### Testing Against Environments

Update your test scripts to accept environment parameter:

```bash
# Test against staging
node test-top-loops.cjs staging

# Test against production
node test-top-loops.cjs production
```

## Workflow

### Recommended Development Workflow

1. **Make changes** in a feature branch
2. **Deploy to staging** first:
   ```bash
   npm run deploy:staging
   ```
3. **Run tests** against staging:
   ```bash
   node test-basic-query.cjs staging
   node test-top-loops.cjs staging
   node test-proofmode.cjs staging
   ```
4. **Verify manually** via WebSocket or HTTP:
   ```bash
   # Check NIP-11 info
   curl -H "Accept: application/nostr+json" https://staging-relay.divine.video

   # Connect with wscat
   wscat -c wss://staging-relay.divine.video
   ```
5. **Check logs** for errors:
   ```bash
   npm run tail:staging
   ```
6. **If all good, deploy to production**:
   ```bash
   npm run deploy
   ```

### Database Migrations

Migrations run automatically on first request to each environment. To check migration status:

```bash
# Staging migrations
wrangler d1 execute nostr-relay-staging --command="SELECT * FROM schema_migrations ORDER BY version"

# Production migrations
wrangler d1 execute nostr-relay --command="SELECT * FROM schema_migrations ORDER BY version"
```

### Cleaning Up Test Data

Create test cleanup script if needed:

```bash
wrangler d1 execute nostr-relay-staging --command="
DELETE FROM events WHERE content LIKE '%TEST%' OR content LIKE '%test%';
DELETE FROM videos WHERE event_id NOT IN (SELECT id FROM events);
DELETE FROM video_hashtags WHERE event_id NOT IN (SELECT id FROM events);
DELETE FROM video_mentions WHERE event_id NOT IN (SELECT id FROM events);
DELETE FROM video_references WHERE event_id NOT IN (SELECT id FROM events);
VACUUM;
"
```

## Environment Differences

| Aspect | Production | Staging |
|--------|-----------|---------|
| Worker Name | nosflare | nosflare-staging |
| Relay Name | Divine Video Relay | Divine Video Relay (STAGING) |
| Description | Production description | 🚧 STAGING - Testing environment... |
| Contact | relay@divine.video | staging@divine.video |
| Domain | relay.divine.video | staging-relay.divine.video |
| Database | nostr-relay | nostr-relay-staging |
| R2 Bucket | nostr-event-archive | nostr-event-archive-staging |
| Cron Schedule | Every 30 min | Every 2 hours |
| Data | Production data | Test data only |

## Troubleshooting

### Staging worker not found

If you get errors about nosflare-staging not existing:
1. Ensure you've deployed with `npm run deploy:staging` at least once
2. Check deployment status: `wrangler deployments list --env staging`

### Database not initialized

If you get database errors:
1. Trigger migrations by accessing the relay: `curl https://staging-relay.divine.video`
2. Check migration status: `wrangler d1 execute nostr-relay-staging --command="SELECT * FROM schema_migrations"`

### Different behavior than production

Remember:
- Staging has separate Durable Objects (WebSocket state is independent)
- Staging has fresh database (no production data)
- Staging cron runs less frequently (every 2 hours vs 30 min)

### API Token Issues

If you get authentication errors:
1. Ensure your CLOUDFLARE_API_TOKEN has these permissions:
   - Account → Workers Scripts → Edit
   - Account → D1 → Edit
   - Account → Account Settings → Read
2. Update token at: https://dash.cloudflare.com/profile/api-tokens

## Rollback

If staging deployment breaks something:

```bash
# List recent deployments
wrangler deployments list --env staging

# Rollback to previous version
wrangler rollback --env staging [deployment-id]
```

Or redeploy from a previous git commit:

```bash
git checkout <previous-commit>
npm run deploy:staging
git checkout main
```

## Best Practices

1. **Always test in staging first** before deploying to production
2. **Keep staging config close to production** - only difference should be database/bucket IDs and environment indicator
3. **Clean up test data regularly** - staging database can accumulate junk
4. **Monitor staging logs** - catch errors before they hit production
5. **Use staging for beta testing** - give beta testers the staging URL
6. **Document environment-specific behavior** - if something only works in one environment, document why

## Security Notes

- Staging and production are completely isolated (separate Durable Objects, databases, buckets)
- Staging uses same authentication/validation as production
- Don't put real user data in staging
- Staging secrets must be set separately: `wrangler secret put SECRET_NAME --env staging`

## Cost Considerations

Running staging will approximately double your costs for:
- Workers execution time
- D1 database storage/queries
- R2 storage
- Durable Objects storage/requests

Staging cron runs less frequently (every 2 hours) to reduce costs.

## Support

If you encounter issues:
1. Check logs: `npm run tail:staging`
2. Verify configuration in `wrangler.toml`
3. Check Cloudflare dashboard for worker status
4. Review this document for troubleshooting steps
