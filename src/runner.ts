import { parseAccountsSecret, type TaygedoAccount } from './config/accounts.js'
import { TaygedoApi } from './taygedo/api.js'
import { sendNotification } from './notify.js'
import { withRetries } from './utils/retry.js'
import { TAYGEDO_GAME_IDS } from './taygedo/games.js'
import { decryptPassword } from './config/credentials.js'

export interface RunnerDependencies {
  accountsSecret: string
  api?: AttendanceApi
  accountPasswords?: Record<string, string>
  credentialKey?: string
  notificationUrls?: string[]
  maxRetries?: number
  secretWriter?: (payload: string) => Promise<void>
}

type AttendanceApi = Pick<TaygedoApi, 'refreshToken' | 'getGameRoles' | 'appSignin' | 'getSigninState' | 'getSigninRewards' | 'gameSignin'>
  & Partial<Pick<TaygedoApi, 'loginWithPassword' | 'userCenterLogin'>>

export interface RunAttendanceResult {
  updatedAccounts: TaygedoAccount[]
  summary: string
}

interface AccountRunSummary {
  id: string
  name: string
  success: boolean
  appSignin?: {
    exp: number
    goldCoin: number
  }
  gameSignins: Array<{
    gameId: string
    roleName: string
    days?: number
    reward?: {
      name: string
      num: number
    }
    success: boolean
  }>
  error?: string
}

export async function runAttendance(deps: RunnerDependencies): Promise<RunAttendanceResult> {
  const accounts = parseAccountsSecret(deps.accountsSecret)
  const api = deps.api ?? new TaygedoApi()
  const updatedAccounts: TaygedoAccount[] = []
  let secretUpdateCount = 0
  const failedAccounts: string[] = []
  const accountSummaries: AccountRunSummary[] = []

  for (const account of accounts) {
    try {
      const accountRun = await withRetries(async () => {
        return await runAccount(api, account, deps.accountPasswords ?? {}, deps.credentialKey)
      }, deps.maxRetries ?? 3)

      if (accountRun.shouldUpdateSecret) {
        secretUpdateCount++
      }
      updatedAccounts.push(accountRun.updatedAccount)
      accountSummaries.push(accountRun.summary)
    }
    catch (error) {
      updatedAccounts.push({ ...account })
      failedAccounts.push(account.id)
      accountSummaries.push({
        id: account.id,
        name: account.name,
        success: false,
        gameSignins: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (secretUpdateCount > 0 && deps.secretWriter) {
    await deps.secretWriter(JSON.stringify(updatedAccounts, null, 2))
  }

  const summary = buildSummary(accountSummaries)
  console.log(summary)

  if (deps.notificationUrls?.length) {
    await sendNotification({
      urls: deps.notificationUrls,
      title: '塔吉多每日签到',
      content: summary,
    })
  }

  return {
    updatedAccounts,
    summary,
  }
}

interface AccountRunResult {
  updatedAccount: TaygedoAccount
  shouldUpdateSecret: boolean
  summary: AccountRunSummary
}

async function runAccount(
  api: AttendanceApi,
  account: TaygedoAccount,
  accountPasswords: Record<string, string>,
  credentialKey?: string,
): Promise<AccountRunResult> {
  if (account.accessToken) {
    try {
      return await signWithSession(api, account, account.accessToken, false)
    }
    catch (error) {
      if (!isAuthError(error)) {
        throw error
      }
    }
  }

  const session = await refreshOrRebuildSession(api, account, accountPasswords, credentialKey)
  return await signWithSession(api, session.account, session.accessToken, true)
}

async function refreshOrRebuildSession(
  api: Pick<TaygedoApi, 'refreshToken'> & Partial<Pick<TaygedoApi, 'loginWithPassword' | 'userCenterLogin'>>,
  account: TaygedoAccount,
  accountPasswords: Record<string, string>,
  credentialKey?: string,
): Promise<{ account: TaygedoAccount, accessToken: string }> {
  const password = resolveAccountPassword(account, accountPasswords, credentialKey)
  if (account.phone && password && api.loginWithPassword && api.userCenterLogin) {
    try {
      const login = await api.loginWithPassword(account.phone, password, account.deviceId)
      const rebuilt = await api.userCenterLogin(login.token, login.userId, account.deviceId)
      const updatedAccount = withSession(account, {
        accessToken: rebuilt.accessToken,
        refreshToken: rebuilt.refreshToken,
        uid: rebuilt.uid,
        laohuToken: login.token,
        laohuUserId: login.userId,
      })
      return {
        account: updatedAccount,
        accessToken: rebuilt.accessToken,
      }
    }
    catch {
      // Fall back to refreshToken / stored laohu credentials below.
    }
  }

  try {
    const refreshed = await api.refreshToken(account.refreshToken, account.deviceId)
    const updatedAccount = withSession(account, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      uid: refreshed.uid,
    })
    return {
      account: updatedAccount,
      accessToken: refreshed.accessToken,
    }
  }
  catch (error) {
    if (!isRefreshRejected(error) || !account.laohuToken || !account.laohuUserId || !api.userCenterLogin) {
      throw error
    }
  }

  const rebuilt = await api.userCenterLogin(account.laohuToken, account.laohuUserId, account.deviceId)
  const updatedAccount = withSession(account, {
    accessToken: rebuilt.accessToken,
    refreshToken: rebuilt.refreshToken,
    uid: rebuilt.uid,
  })
  return {
    account: updatedAccount,
    accessToken: rebuilt.accessToken,
  }
}

function resolveAccountPassword(
  account: TaygedoAccount,
  accountPasswords: Record<string, string>,
  credentialKey?: string,
): string | undefined {
  const envPassword = accountPasswords[account.id] ?? accountPasswords[account.phone ?? ''] ?? accountPasswords.default
  if (envPassword) {
    return envPassword
  }
  if (account.encryptedPassword && credentialKey) {
    return decryptPassword(account.encryptedPassword, credentialKey)
  }
  return undefined
}

async function signWithSession(
  api: Pick<TaygedoApi, 'getGameRoles' | 'appSignin' | 'getSigninState' | 'getSigninRewards' | 'gameSignin'>,
  account: TaygedoAccount,
  accessToken: string,
  shouldUpdateSecret: boolean,
): Promise<AccountRunResult> {
  const gameRoles = await getAllGameRoles(api, accessToken, account.uid, account.deviceId)
  const firstRole = gameRoles[0]
  const roleId = firstRole?.roleId ?? account.roleId

  const appSignin = await api.appSignin(accessToken, account.uid, account.deviceId)
  const gameSignins: AccountRunSummary['gameSignins'] = []
  for (const role of gameRoles) {
    const signinState = await api.getSigninState(accessToken, role.gameId)
    const signinRewards = await api.getSigninRewards(accessToken, role.gameId)
    await api.gameSignin(accessToken, role.roleId, role.gameId)
    gameSignins.push({
      gameId: role.gameId,
      roleName: role.roleName ?? role.roleId,
      days: signinState.days,
      reward: signinRewards[signinState.days - 1],
      success: true,
    })
  }

  const updatedAccount = {
    ...account,
  }
  if (roleId) {
    updatedAccount.roleId = roleId
  }
  if (firstRole?.roleName ?? account.roleName) {
    updatedAccount.roleName = firstRole?.roleName ?? account.roleName
  }

  return {
    updatedAccount,
    shouldUpdateSecret,
    summary: {
      id: account.id,
      name: account.name,
      success: true,
      appSignin,
      gameSignins,
    },
  }
}

function withSession(
  account: TaygedoAccount,
  session: { accessToken: string, refreshToken: string, uid?: string, laohuToken?: string, laohuUserId?: string },
): TaygedoAccount {
  const updatedAccount: TaygedoAccount = {
    ...account,
    uid: session.uid ?? account.uid,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    tokenUpdatedAt: new Date().toISOString(),
  }
  if (session.laohuToken) {
    updatedAccount.laohuToken = session.laohuToken
  }
  if (session.laohuUserId) {
    updatedAccount.laohuUserId = session.laohuUserId
  }
  return updatedAccount
}

function isRefreshRejected(error: unknown): boolean {
  return error instanceof Error && error.message.includes('REFRESH_REJECTED_402')
}

function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /AUTH_EXPIRED|HTTP 40[123]|登录|token|未授权|请先|过期|失效|invalid_token/i.test(error.message)
}

async function getAllGameRoles(
  api: Pick<TaygedoApi, 'getGameRoles'>,
  accessToken: string,
  uid: string,
  deviceId: string,
): Promise<Array<{ gameId: string, roleId: string, roleName?: string }>> {
  const roles: Array<{ gameId: string, roleId: string, roleName?: string }> = []
  const seenRoleIds = new Set<string>()

  for (const gameId of TAYGEDO_GAME_IDS) {
    const gameRoleList = await api.getGameRoles(accessToken, uid, deviceId, gameId)
    for (const role of gameRoleList.roles) {
      if (!role.roleId || seenRoleIds.has(role.roleId)) {
        continue
      }
      seenRoleIds.add(role.roleId)
      roles.push({
        gameId,
        roleId: role.roleId,
        roleName: role.roleName,
      })
    }
  }

  return roles
}

function buildSummary(accounts: AccountRunSummary[]): string {
  const successCount = accounts.filter(account => account.success).length
  const failedCount = accounts.length - successCount
  const lines = [
    '塔吉多每日签到结果',
    `总账号：${accounts.length}，成功：${successCount}，失败：${failedCount}`,
    '',
  ]

  for (const account of accounts) {
    lines.push(`${account.name}（${account.id}）：${account.success ? '成功' : '失败'}`)
    if (account.appSignin) {
      lines.push(`- APP 签到：获得 ${account.appSignin.goldCoin} 金币，${account.appSignin.exp} 经验`)
    }
    for (const gameSignin of account.gameSignins) {
      const reward = gameSignin.reward ? `，奖励 ${gameSignin.reward.name} x${gameSignin.reward.num}` : ''
      const days = gameSignin.days === undefined ? '' : `，本月第 ${gameSignin.days} 天`
      lines.push(`- 游戏 ${gameSignin.gameId} / ${gameSignin.roleName}：签到成功${days}${reward}`)
    }
    if (account.error) {
      lines.push(`- 失败原因：${account.error}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}
