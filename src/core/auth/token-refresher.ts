import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError } from '../../plugin/errors'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface TokenRefresherConfig {
  token_expiry_buffer_ms: number
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

export class TokenRefresher {
  private lastSyncTime = 0
  private readonly SYNC_COOLDOWN_MS = 5000 // Only sync once per 5 seconds

  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, shouldContinue: false }
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, shouldContinue: false }
    } catch (e: any) {
      return await this.handleRefreshError(e, account, showToast)
    }
  }

  private async handleRefreshError(
    error: any,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    // Only sync if cooldown period has passed
    const now = Date.now()
    if (this.config.auto_sync_kiro_cli && now - this.lastSyncTime > this.SYNC_COOLDOWN_MS) {
      this.lastSyncTime = now

      // Force kiro-cli to refresh its token first
      try {
        const { exec } = await import('node:child_process')
        await new Promise<void>((resolve) => {
          exec('kiro-cli whoami', (error) => {
            resolve() // Continue even if it fails
          })
        })
      } catch (e) {
        // Silent fail - continue with sync anyway
      }

      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const stillAcc = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (
      stillAcc &&
      !accessTokenExpired(
        this.accountManager.toAuthDetails(stillAcc),
        this.config.token_expiry_buffer_ms
      )
    ) {
      // Reset health status since we have fresh credentials
      stillAcc.isHealthy = true
      stillAcc.failCount = 0
      stillAcc.unhealthyReason = undefined
      await this.repository.batchSave([stillAcc])
      showToast('Credentials recovered from Kiro CLI sync.', 'info')
      return { account: stillAcc, shouldContinue: false }
    }

    if (
      error instanceof KiroTokenRefreshError &&
      (error.code === 'ExpiredTokenException' ||
        error.code === 'InvalidTokenException' ||
        error.code === 'HTTP_401' ||
        error.message.includes('Invalid refresh token provided'))
    ) {
      this.accountManager.markUnhealthy(account, error.message)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, shouldContinue: true }
    }

    // For HTTP_403, only mark unhealthy after multiple failures
    if (error instanceof KiroTokenRefreshError && error.code === 'HTTP_403') {
      account.failCount = (account.failCount || 0) + 1
      if (account.failCount >= 3) {
        this.accountManager.markUnhealthy(account, error.message)
      }
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, shouldContinue: true }
    }

    throw error
  }
}
