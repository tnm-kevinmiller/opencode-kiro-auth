# AWS SSO Integration - Implementation Summary

## Overview
Added AWS SSO authentication support to the opencode-kiro-auth plugin, allowing automatic credential import from `~/.aws/sso/cache`.

## Changes Made

### 1. New AWS SSO Sync Module
**File**: `src/plugin/sync/aws-sso.ts`
- Reads AWS SSO cache files from `~/.aws/sso/cache`
- Parses JSON cache entries containing access tokens, refresh tokens, and client credentials
- Filters expired tokens
- Creates deterministic account IDs based on startUrl and clientId
- Returns array of `ManagedAccount` objects ready for storage

### 2. Type System Updates
**File**: `src/plugin/types.ts`
- Added `'aws-sso'` to `KiroAuthMethod` type union
- Now supports: `'idc' | 'desktop' | 'aws-sso'`

### 3. Configuration Schema
**File**: `src/plugin/config/schema.ts`
- Added `auto_sync_aws_sso: z.boolean().default(true)` to config schema
- Updated default config object to include the new option
- Enabled by default for seamless integration

### 4. Auth Handler Integration
**File**: `src/core/auth/auth-handler.ts`
- Modified `initialize()` method to call AWS SSO sync
- Imports accounts from SSO cache on startup
- Adds synced accounts to AccountManager
- Persists accounts to database
- Respects `auto_sync_aws_sso` config flag

### 5. Token Refresh Logic
**File**: `src/plugin/token.ts`
- Updated `refreshAccessToken()` to handle AWS SSO tokens
- AWS SSO uses same OIDC endpoint as IDC: `https://oidc.{region}.amazonaws.com/token`
- Requires clientId and clientSecret for refresh
- Uses same user-agent as IDC: `'aws-sdk-js/1.0.0'`

### 6. Documentation
**File**: `README.md`
- Updated Features section to mention AWS SSO support
- Added Setup section #2 for AWS SSO authentication
- Updated Configuration section with `auto_sync_aws_sso` option
- Added configuration example showing the new option

## How It Works

1. **On Plugin Initialization**:
   - Plugin checks `auto_sync_aws_sso` config (default: true)
   - Scans `~/.aws/sso/cache/*.json` files
   - Parses valid, non-expired SSO sessions
   - Creates accounts with auth method `'aws-sso'`
   - Stores in `kiro.db` alongside other accounts

2. **Account Selection**:
   - AWS SSO accounts participate in normal account rotation
   - Subject to same health checks and rate limiting
   - Can be mixed with IDC and desktop accounts

3. **Token Refresh**:
   - When AWS SSO token expires, uses OIDC refresh flow
   - Same endpoint as IDC authentication
   - Requires stored clientId/clientSecret from cache

4. **Storage**:
   - Accounts stored in existing `kiro.db` SQLite database
   - Uses deterministic ID: `sha256(startUrl:aws-sso:clientId:)`
   - Tracks usage, health, and rate limits like other accounts

## Benefits

- **Zero Configuration**: Works automatically if AWS SSO is already configured
- **Multi-Account Support**: Can use multiple AWS SSO profiles simultaneously
- **Seamless Integration**: Uses existing account management infrastructure
- **Automatic Sync**: Picks up new SSO sessions without manual intervention
- **Unified Experience**: AWS SSO accounts work identically to other auth methods

## Testing Recommendations

1. Verify SSO cache parsing with various AWS profiles
2. Test token refresh for expired AWS SSO tokens
3. Confirm account rotation includes AWS SSO accounts
4. Validate deterministic ID generation prevents duplicates
5. Test with `auto_sync_aws_sso: false` to ensure opt-out works
