import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { createDeterministicAccountId } from '../accounts'
import * as logger from '../logger'
import { kiroDb } from '../storage/sqlite'
import { fetchUsageLimits } from '../usage'
import {
  findClientCredsRecursive,
  getCliDbPath,
  makePlaceholderEmail,
  normalizeExpiresAt,
  safeJsonParse
} from './kiro-cli-parser'

export async function syncFromKiroCli() {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath, { readonly: true })
    cliDb.run('PRAGMA busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]

    // Get profile ARN from state table
    let profileArn: string | undefined
    let profileRegion: string | undefined
    try {
      const stateRow = cliDb
        .prepare("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'")
        .get() as any
      if (stateRow?.value) {
        const profileData = safeJsonParse(stateRow.value)
        profileArn = profileData?.arn
        // Extract region from ARN: arn:aws:codewhisperer:REGION:...
        if (profileArn) {
          const arnParts = profileArn.split(':')
          if (arnParts.length >= 4) {
            profileRegion = arnParts[3]
          }
        }
      }
    } catch (e) {
      logger.debug('Could not read profile from state table', e)
    }

    const deviceRegRow = rows.find(
      (r) => typeof r?.key === 'string' && r.key.includes('device-registration')
    )
    const deviceReg = safeJsonParse(deviceRegRow?.value)
    const regCreds = deviceReg ? findClientCredsRecursive(deviceReg) : {}

    for (const row of rows) {
      if (row.key.includes(':token')) {
        const data = safeJsonParse(row.value)
        if (!data) continue

        const tokenExpiresAt =
          normalizeExpiresAt(data.expires_at ?? data.expiresAt) || Date.now() + 3600000

        // Skip expired tokens
        if (tokenExpiresAt < Date.now()) {
          logger.debug('Kiro CLI sync: skipping expired token', { key: row.key })
          continue
        }

        const isIdc = row.key.includes('odic')
        const authMethod = isIdc ? 'idc' : 'desktop'
        const region = profileRegion || data.region || 'us-east-1'
        const tokenProfileArn = data.profile_arn || data.profileArn || profileArn

        const accessToken = data.access_token || data.accessToken || ''
        const refreshToken = data.refresh_token || data.refreshToken
        if (!refreshToken) continue

        const clientId = data.client_id || data.clientId || (isIdc ? regCreds.clientId : undefined)
        const clientSecret =
          data.client_secret || data.clientSecret || (isIdc ? regCreds.clientSecret : undefined)

        if (authMethod === 'idc' && (!clientId || !clientSecret)) {
          logger.warn('Kiro CLI sync: missing IDC device credentials; skipping token import')
          continue
        }

        let usedCount = 0
        let limitCount = 0
        let email: string | undefined
        let usageOk = false

        try {
          const authForUsage: any = {
            refresh: '',
            access: accessToken,
            expires: tokenExpiresAt,
            authMethod,
            region,
            profileArn: tokenProfileArn,
            clientId,
            clientSecret,
            email: ''
          }
          const u = await fetchUsageLimits(authForUsage)
          usedCount = u.usedCount || 0
          limitCount = u.limitCount || 0
          if (typeof u.email === 'string' && u.email) {
            email = u.email
            usageOk = true
          }
        } catch (e) {
          logger.warn('Kiro CLI sync: failed to fetch usage/email; falling back', {
            authMethod,
            region
          })
          logger.debug('Kiro CLI sync: usage fetch error', e)
        }

        const all = kiroDb.getAccounts()
        if (!email) {
          let existing: any | undefined
          if (tokenProfileArn) {
            existing = all.find(
              (a) => a.auth_method === authMethod && a.profile_arn === tokenProfileArn
            )
          }
          if (!existing && authMethod === 'idc' && clientId) {
            existing = all.find((a) => a.auth_method === 'idc' && a.client_id === clientId)
          }
          if (existing && typeof existing.email === 'string' && existing.email) {
            email = existing.email
          } else {
            email = makePlaceholderEmail(authMethod, region, clientId, tokenProfileArn)
          }
        }

        const resolvedEmail =
          email || makePlaceholderEmail(authMethod, region, clientId, tokenProfileArn)

        const id = createDeterministicAccountId(
          resolvedEmail,
          authMethod,
          clientId,
          tokenProfileArn
        )
        const existingById = all.find((a) => a.id === id)
        if (
          existingById &&
          existingById.is_healthy === 1 &&
          existingById.expires_at >= tokenExpiresAt
        )
          continue

        if (usageOk) {
          const placeholderEmail = makePlaceholderEmail(
            authMethod,
            region,
            clientId,
            tokenProfileArn
          )
          const placeholderId = createDeterministicAccountId(
            placeholderEmail,
            authMethod,
            clientId,
            tokenProfileArn
          )
          if (placeholderId !== id) {
            const placeholderRow = all.find((a) => a.id === placeholderId)
            if (placeholderRow) {
              await kiroDb.upsertAccount({
                id: placeholderId,
                email: placeholderRow.email,
                authMethod,
                region: placeholderRow.region || region,
                clientId,
                clientSecret,
                profileArn: tokenProfileArn,
                refreshToken: placeholderRow.refresh_token || refreshToken,
                accessToken: placeholderRow.access_token || accessToken,
                expiresAt: placeholderRow.expires_at || tokenExpiresAt,
                rateLimitResetTime: 0,
                isHealthy: false,
                failCount: 10,
                unhealthyReason: 'Replaced by real email',
                recoveryTime: Date.now() + 31536000000,
                usedCount: placeholderRow.used_count || 0,
                limitCount: placeholderRow.limit_count || 0,
                lastSync: Date.now()
              })
            }
          }
        }

        // Encode refresh token with client credentials for IDC
        const { encodeRefreshToken } = await import('../../kiro/auth.js')
        const encodedRefreshToken = encodeRefreshToken({
          refreshToken,
          clientId,
          clientSecret,
          authMethod: 'idc'
        })

        await kiroDb.upsertAccount({
          id,
          email: resolvedEmail,
          authMethod,
          region,
          clientId,
          clientSecret,
          profileArn: tokenProfileArn,
          refreshToken: encodedRefreshToken,
          accessToken,
          expiresAt: tokenExpiresAt,
          rateLimitResetTime: 0,
          isHealthy: true,
          failCount: 0,
          usedCount,
          limitCount,
          lastSync: Date.now()
        })
      }
    }
    cliDb.close()
  } catch (e) {
    logger.error('Sync failed', e)
  }
}

export async function writeToKiroCli(acc: any) {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath)
    cliDb.run('PRAGMA busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]
    const targetKey = acc.authMethod === 'idc' ? 'kirocli:odic:token' : 'kirocli:social:token'
    const row = rows.find((r) => r.key === targetKey || r.key.endsWith(targetKey))
    if (row) {
      const data = JSON.parse(row.value)
      data.access_token = acc.accessToken
      data.refresh_token = acc.refreshToken
      data.expires_at = new Date(acc.expiresAt).toISOString()
      cliDb.prepare('UPDATE auth_kv SET value = ? WHERE key = ?').run(JSON.stringify(data), row.key)
    }
    cliDb.close()
  } catch (e) {
    logger.warn('Write back failed', e)
  }
}
