import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicAccountId } from '../accounts'
import * as logger from '../logger'
import type { ManagedAccount } from '../types'

interface SSOCacheEntry {
  startUrl: string
  region: string
  accessToken: string
  expiresAt: string
  clientId: string
  clientSecret: string
  registrationExpiresAt: string
  refreshToken?: string
}

export async function syncFromAwsSso(): Promise<ManagedAccount[]> {
  const accounts: ManagedAccount[] = []
  const ssoDir = join(homedir(), '.aws', 'sso', 'cache')

  try {
    const files = await readdir(ssoDir)
    const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.includes('.tmp'))

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(ssoDir, file), 'utf-8')
        const entry: SSOCacheEntry = JSON.parse(content)

        if (!entry.accessToken || !entry.refreshToken) continue

        const expiresAt = new Date(entry.expiresAt).getTime()
        if (expiresAt < Date.now()) continue

        const id = createDeterministicAccountId(
          entry.startUrl,
          'aws-sso',
          entry.clientId,
          undefined
        )

        accounts.push({
          id,
          email: entry.startUrl,
          authMethod: 'aws-sso',
          region: (entry.region || 'us-east-1') as any,
          clientId: entry.clientId,
          clientSecret: entry.clientSecret,
          refreshToken: entry.refreshToken,
          accessToken: entry.accessToken,
          expiresAt,
          rateLimitResetTime: 0,
          isHealthy: true,
          failCount: 0,
          lastUsed: Date.now(),
          usedCount: 0,
          limitCount: 0
        })
      } catch (err) {
        logger.debug('Failed to parse SSO cache file', { file, error: err })
      }
    }

    logger.log(`Synced ${accounts.length} AWS SSO accounts`)
  } catch (err) {
    logger.debug('Failed to read AWS SSO cache', { error: err })
  }

  return accounts
}
