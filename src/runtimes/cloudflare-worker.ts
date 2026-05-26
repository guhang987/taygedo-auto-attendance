import { loadRuntimeConfig } from '../config/runtime.js'
import { AttendanceService } from '../services/attendance-service.js'
import { LoginService } from '../services/login-service.js'
import { createAccountStore, createStateStore } from '../stores/factory.js'
import { TaygedoApi } from '../taygedo/api.js'
import type { LoginActionDependencies } from '../login-action.js'

type ScheduledController = Record<string, unknown>
type ExecutionContext = Record<string, unknown>

interface CloudflareEnv extends Record<string, unknown> {
  KV: {
    get(key: string): Promise<string | null>
    put(key: string, value: string): Promise<void>
  }
  TAYGEDO_TEST_API?: ConstructorParameters<typeof AttendanceService>[0]['api']
  TAYGEDO_TEST_LOGIN_API?: LoginActionDependencies['api']
}

const worker = {
  async scheduled(_event: ScheduledController, env: CloudflareEnv, _ctx: ExecutionContext): Promise<void> {
    await runCloudflareAttendance(env)
  },

  async fetch(request: Request, env: CloudflareEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/run' && url.pathname !== '/login') {
      return Response.json({ ok: true })
    }

    const config = loadRuntimeConfig(envToStrings(env))
    if (config.adminToken && request.headers.get('Authorization') !== `Bearer ${config.adminToken}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (url.pathname === '/login') {
      try {
        const result = await runCloudflareLogin(request, env)
        return Response.json({ ok: true, ...result })
      }
      catch (error) {
        if (error instanceof HttpError) {
          return Response.json({ error: error.message }, { status: error.status })
        }
        throw error
      }
    }

    const result = await runCloudflareAttendance(env)
    return Response.json({ ok: true, summary: result.summary })
  },
}

export default worker

async function runCloudflareAttendance(env: CloudflareEnv) {
  const config = loadRuntimeConfig(envToStrings(env))
  const service = new AttendanceService({
    accountStore: createAccountStore({ config, kv: env.KV }),
    stateStore: createStateStore({ config, kv: env.KV }),
    api: env.TAYGEDO_TEST_API ?? new TaygedoApi(),
    accountPasswords: config.accountPasswords,
    credentialKey: config.credentialKey,
    notificationUrls: config.notificationUrls,
    maxRetries: config.maxRetries,
  })
  return await service.run()
}

async function runCloudflareLogin(request: Request, env: CloudflareEnv) {
  const config = loadRuntimeConfig(envToStrings(env))
  const body = await readLoginBody(request)
  const mode = body.mode ?? 'password'
  if (mode === 'password' && body.password && !config.credentialKey) {
    throw new HttpError(400, 'Missing TAYGEDO_CREDENTIAL_KEY. Please add it as a Cloudflare secret first.')
  }
  const currentAccounts = await tryReadCloudflareAccounts(env, config.accountsKey, config.accountsSecret)
  const service = new LoginService({ api: env.TAYGEDO_TEST_LOGIN_API ?? new TaygedoApi() })
  await service.runLogin({
    mode,
    phone: body.phone,
    password: body.password,
    captcha: body.captcha,
    deviceId: body.deviceId,
    accountId: body.accountId ?? 'main',
    accountName: body.accountName ?? body.accountId ?? '主账号',
    accountsFile: undefined,
    accountsSecret: currentAccounts,
    credentialKey: config.credentialKey,
    writeAccounts: payload => env.KV.put(config.accountsKey, payload),
  })
  return { accountId: body.accountId ?? 'main' }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface LoginRequestBody {
  mode?: string
  phone: string
  password?: string
  captcha?: string
  deviceId?: string
  accountId?: string
  accountName?: string
}

async function readLoginBody(request: Request): Promise<LoginRequestBody> {
  if (request.method !== 'POST') {
    throw new Error('Cloudflare login requires POST')
  }
  const body = await request.json() as Partial<LoginRequestBody>
  if (!body.phone) {
    throw new Error('Missing login phone')
  }
  return body as LoginRequestBody
}

async function tryReadCloudflareAccounts(env: CloudflareEnv, key: string, fallback?: string): Promise<string | undefined> {
  return await env.KV.get(key) ?? fallback
}

function envToStrings(env: CloudflareEnv): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {
    TAYGEDO_ACCOUNT_STORE: 'cloudflare-kv',
    TAYGEDO_STATE_STORE: 'cloudflare-kv',
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      values[key] = value
    }
  }
  return values
}
