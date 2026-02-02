import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { IdcAuthMethod } from './idc-auth-method.js'
import { KiroCliAuthMethod } from './kiro-cli-auth-method.js'

export class AuthHandler {
  private accountManager?: any
  private refreshTimer?: NodeJS.Timeout

  constructor(
    private config: any,
    private repository: AccountRepository
  ) {}

  async initialize(): Promise<void> {
    const { syncFromKiroCli } = await import('../../plugin/sync/kiro-cli.js')
    await syncFromKiroCli()

    // Start background token refresh every 15 minutes
    this.startBackgroundRefresh()
  }

  private startBackgroundRefresh(): void {
    // Clear existing timer if any
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
    }

    // Refresh every 15 minutes
    this.refreshTimer = setInterval(
      async () => {
        try {
          const logger = await import('../../plugin/logger.js')
          logger.log('Background token refresh starting...')
          const { syncFromKiroCli } = await import('../../plugin/sync/kiro-cli.js')
          await syncFromKiroCli()
          logger.log('Background token refresh completed')
        } catch (e) {
          const logger = await import('../../plugin/logger.js')
          logger.warn('Background token refresh failed', e)
        }
      },
      15 * 60 * 1000
    )
  }

  setAccountManager(am: any): void {
    this.accountManager = am
  }

  getMethods(): Array<{
    id: string
    label: string
    type: 'oauth'
    authorize: (inputs?: any) => Promise<any>
  }> {
    if (!this.accountManager) {
      return []
    }

    const idcMethod = new IdcAuthMethod(this.config, this.repository)
    const kiroCliMethod = new KiroCliAuthMethod(this.config, this.repository)

    return [
      {
        id: 'kiro-cli',
        label: 'Kiro CLI (IAM Identity Center)',
        type: 'oauth',
        authorize: () => kiroCliMethod.authorize()
      },
      {
        id: 'idc',
        label: 'AWS Builder ID (Direct)',
        type: 'oauth',
        authorize: (inputs?: any) => idcMethod.authorize(inputs)
      }
    ]
  }
}
