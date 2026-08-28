/**
 * Entry surface: Config validation and the ApiProxy adapter port.
 * grammY plumbing and the long-poll lifecycle are composition-level and are
 * exercised by the assembled deployment, not per-file unit coverage.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy, RpcResponse, WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Bot } from 'grammy'
import { COMMANDS, Config, DENIED_REPLY, TYPING_PUMP_INTERVAL_MS, createPort, startBotSession } from '../src/index.ts'

function ok<T>(value: T, requestId: RpcId = RpcId('r')): RpcResponse<T> {
  return { rpcId: requestId, result: { ok: true, value } }
}

function fail(requestId: RpcId = RpcId('r')): RpcResponse<never> {
  return { rpcId: requestId, result: { ok: false, error: { code: 'session-not-found', message: '会话不存在', details: { sessionId: SessionId('nope') } } } }
}

/** A session RPC request as the port mints it (rpcId + payload). */
interface RpcLike {
  rpcId: RpcId
  payload: unknown
}

/** Minimal fake ApiProxy covering the session ops the port uses. */
function fakeApi(): { api: ApiProxy; lastPromptRpcId: () => RpcId } {
  const calls: { kind: string; request: RpcLike }[] = []
  const api = {
    sessions: {
      async list(request: RpcLike) {
        calls.push({ kind: 'list', request })
        return ok({ items: [{ sessionId: SessionId('aaa'), updatedAt: 1, running: false, blank: false }] }, request.rpcId)
      },
      async history(request: RpcLike) {
        calls.push({ kind: 'history', request })
        return ok({ events: [], hasMore: false }, request.rpcId)
      },
      async prompt(request: RpcLike) {
        calls.push({ kind: 'prompt', request })
        return ok({ accepted: true }, request.rpcId)
      },
      async cancel(request: RpcLike) {
        calls.push({ kind: 'cancel', request })
        return ok({ accepted: true }, request.rpcId)
      },
    },
  } as unknown as ApiProxy
  return {
    api,
    lastPromptRpcId: (): RpcId => {
      for (let index = calls.length - 1; index >= 0; index--) {
        const call = calls[index]
        if (call?.kind === 'prompt') return call.request.rpcId
      }
      return RpcId('none')
    },
  }
}

describe('Config schema', () => {
  it('requires the token and allowlist, defaults nothing else', () => {
    expect(() => Config({} as never)).toThrow()
    expect(() => Config({ botToken: 't' } as never)).toThrow()
    expect(Config({ botToken: 't', allowChatIds: [1, 2] })).toEqual({ botToken: 't', allowChatIds: [1, 2] })
  })

  it('accepts an optional proxy', () => {
    expect(Config({ botToken: 't', allowChatIds: [], proxy: 'http://127.0.0.1:7890' }).proxy).toBe('http://127.0.0.1:7890')
  })

  it('rejects non-numeric chat ids', () => {
    expect(() => Config({ botToken: 't', allowChatIds: ['1' as never] })).toThrow()
  })
})

describe('createPort over ApiProxy', () => {
  it('lists sessions through the proxy', async () => {
    const { api } = fakeApi()
    const port = createPort(api)
    const items = await port.listSessions()
    expect(items).toHaveLength(1)
  })

  it('maps list refusals to UI-ready errors', async () => {
    const api = {
      sessions: { async list() { return fail() } },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listSessions()).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('maps history pages to raw events', async () => {
    const api = {
      sessions: {
        async history(request: RpcLike) {
          return ok({
            events: [{ event: { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent, hasMore: false } as never],
            hasMore: false,
          }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    const events = await port.readHistory(SessionId('aaa'))
    expect(events).toEqual([expect.objectContaining({ type: 'turn/start' })])
  })

  it('forwards mode and text to the prompt rpc', async () => {
    const { api, lastPromptRpcId } = fakeApi()
    const port = createPort(api)
    await port.sendPrompt(SessionId('aaa'), 'steer', '插话')
    expect(lastPromptRpcId()).not.toBe(RpcId('none'))
  })

  it('maps prompt refusals to errors', async () => {
    const api = { sessions: { async prompt(request: RpcLike) { return fail(request.rpcId) } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.sendPrompt(SessionId('aaa'), 'queue', 'x')).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('stops sessions through the proxy', async () => {
    const { api } = fakeApi()
    const port = createPort(api)
    await expect(port.stopSession(SessionId('aaa'))).resolves.toBeUndefined()
  })

  it('maps stop refusals to errors', async () => {
    const api = { sessions: { async cancel() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.stopSession(SessionId('aaa'))).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('maps the host-wide model catalog through the proxy', async () => {
    const api = {
      llm: { async models(request: RpcLike) { return ok({ groups: [], failures: [] }, request.rpcId) } },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listGlobalModels()).resolves.toEqual({ groups: [], failures: [] })
  })

  it('maps catalog refusals to errors', async () => {
    const api = { llm: { async models() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listGlobalModels()).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('reads the archived id set through the workspace list', async () => {
    const api = {
      workspace: {
        async list(request: RpcLike) {
          return ok({ items: [], archivedSessionIds: [SessionId('bbb')] }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listArchivedSessionIds()).resolves.toEqual([SessionId('bbb')])
  })

  it('maps archived-set refusals to errors', async () => {
    const api = { workspace: { async list() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listArchivedSessionIds()).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('persists the global default model through the shared settings section', async () => {
    const api = {
      settings: {
        async update(request: RpcLike) {
          expect(request.payload).toEqual({
            ns: 'agent-default-model',
            patch: { provider: 'deepseek', model: 'deepseek-chat' },
          })
          return ok({ ns: 'agent-default-model', revision: 1 }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.setGlobalDefaultModel('deepseek', 'deepseek-chat')).resolves.toBeUndefined()
  })

  it('maps settings rejections to errors', async () => {
    const api = { settings: { async update() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.setGlobalDefaultModel('p', 'm')).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('creates sessions through the proxy', async () => {
    const api = {
      sessions: {
        async create(request: RpcLike) {
          expect(request.payload).toEqual({})
          return ok({ sessionId: SessionId('new-id') }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.createSession()).resolves.toBe('new-id')
  })

  it('maps create refusals to errors', async () => {
    const api = { sessions: { async create() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.createSession()).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('renames sessions through the proxy with the accepted title', async () => {
    const api = {
      sessions: {
        async rename(request: RpcLike) {
          expect(request.payload).toEqual({ sessionId: 'aaa', title: '新标题' })
          return ok({ title: '新标题', seq: 3 }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.renameSession(SessionId('aaa'), '新标题')).resolves.toBe('新标题')
  })

  it('maps rename refusals to errors', async () => {
    const api = { sessions: { async rename() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.renameSession(SessionId('aaa'), 'x')).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('forks sessions through the proxy with the child id', async () => {
    const api = {
      sessions: {
        async fork(request: RpcLike) {
          expect(request.payload).toEqual({ sessionId: 'aaa' })
          return ok({ sessionId: 'child-id' }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.forkSession(SessionId('aaa'))).resolves.toBe('child-id')
  })

  it('maps fork refusals to errors', async () => {
    const api = { sessions: { async fork() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.forkSession(SessionId('aaa'))).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('answers a question through respond with the session-scoped answer batch', async () => {
    let responded: unknown
    const api = {
      async respond(message: unknown) {
        responded = message
        return { accepted: true }
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.answerQuestion('ask-1', SessionId('aaa'), {
      answers: [{ id: 'q1', selected: ['core'] }],
    })).resolves.toBeUndefined()
    expect(responded).toEqual({
      type: 'client-response',
      rpcId: 'ask-1',
      result: { ok: true, value: { sessionId: 'aaa', answer: { answers: [{ id: 'q1', selected: ['core'] }] } } },
    })
  })

  it('answers a multi-select question alongside custom text', async () => {
    let responded: unknown
    const api = {
      async respond(message: unknown) {
        responded = message
        return { accepted: true }
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await port.answerQuestion('ask-2', SessionId('aaa'), {
      answers: [{ id: 'q2', selected: ['检索', '网页'], custom: '还要文档' }],
    })
    expect(responded).toEqual({
      type: 'client-response',
      rpcId: 'ask-2',
      result: {
        ok: true,
        value: { sessionId: 'aaa', answer: { answers: [{ id: 'q2', selected: ['检索', '网页'], custom: '还要文档' }] } },
      },
    })
  })

  it('conveys respond refusals of an answer as UI-ready errors', async () => {
    const api = {
      async respond() {
        return { accepted: false, reason: 'not-pending' }
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.answerQuestion('ask-3', SessionId('aaa'), { answers: [] }))
      .rejects.toThrow('提问回答被拒绝（not-pending）')
  })

  it('cancels a question as a refused client response', async () => {
    let responded: unknown
    const api = {
      async respond(message: unknown) {
        responded = message
        return { accepted: true }
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.cancelQuestion('ask-4')).resolves.toBeUndefined()
    expect(responded).toEqual({
      type: 'client-response',
      rpcId: 'ask-4',
      result: {
        ok: false,
        error: {
          code: 'cancelled',
          message: 'the user closed this question request',
          details: {},
        },
      },
    })
  })

  it('conveys respond refusals of a cancel as UI-ready errors', async () => {
    const api = {
      async respond() {
        return { accepted: false, reason: 'unknown-rpc' }
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.cancelQuestion('ask-5')).rejects.toThrow('提问取消失败（unknown-rpc）')
  })

  it('reads the todo projection from the history tail page', async () => {
    const api = {
      sessions: {
        async history(request: RpcLike) {
          expect(request.payload).toEqual({ sessionId: 'aaa', maxMessages: 20 })
          return ok({
            events: [],
            hasMore: false,
            projections: { asOfSeq: 5, values: { todos: [{ content: '写报告', status: 'in_progress' }] } },
          }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listTodos(SessionId('aaa'))).resolves.toEqual([{ content: '写报告', status: 'in_progress' }])
  })

  it('falls back to the latest todo/write event without a projection', async () => {
    const api = {
      sessions: {
        async history() {
          return ok({
            events: [
              { event: { type: 'todo/write', time: 1, seq: 1, data: { todos: [{ content: '甲', status: 'pending' }] } } },
              { event: { type: 'todo/write', time: 2, seq: 2, data: { todos: [{ content: '乙', status: 'completed' }] } } },
            ],
            hasMore: false,
          }, RpcId('r'))
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listTodos(SessionId('aaa'))).resolves.toEqual([{ content: '乙', status: 'completed' }])
  })

  it('returns null for a session with no todo projection and no todo/write events', async () => {
    const api = {
      sessions: {
        async history() {
          return ok({ events: [], hasMore: false, projections: { asOfSeq: -1, values: {} } }, RpcId('r'))
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listTodos(SessionId('aaa'))).resolves.toBeNull()
  })

  it('maps todo history refusals to errors', async () => {
    const api = { sessions: { async history() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listTodos(SessionId('aaa'))).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('lists presets through the proxy in roster order', async () => {
    const api = {
      agentPresets: {
        async list(request: RpcLike) {
          expect(request.payload).toEqual({})
          return ok({
            presets: [{ id: 'standard', name: '标准模式', trust: 'system', isDefault: true }],
            authorable: false,
            hasDocument: false,
          }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listPresets()).resolves.toEqual([{
      id: 'standard', name: '标准模式', trust: 'system', isDefault: true,
    }])
  })

  it('maps preset-list refusals to errors', async () => {
    const api = { agentPresets: { async list() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.listPresets()).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('selects a preset for a session through the proxy', async () => {
    const api = {
      agentPresets: {
        async select(request: RpcLike) {
          expect(request.payload).toEqual({ sessionId: 'aaa', agentPreset: 'code' })
          return ok({ agentPreset: 'code' }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.selectPreset(SessionId('aaa'), 'code')).resolves.toBeUndefined()
  })

  it('maps preset-select refusals to errors', async () => {
    const api = { agentPresets: { async select() { return fail() } } } as unknown as ApiProxy
    const port = createPort(api)
    await expect(port.selectPreset(SessionId('aaa'), 'code')).rejects.toThrow('会话不存在（session-not-found）')
  })

  it('passes a staged agentPreset through session creation', async () => {
    const api = {
      sessions: {
        async create(request: RpcLike) {
          expect(request.payload).toEqual({ workspaceId: 'ws-1', agentPreset: 'code' })
          return ok({ sessionId: 'child', agentPreset: 'code' }, request.rpcId)
        },
      },
    } as unknown as ApiProxy
    const port = createPort(api)
    const created = await port.createSession({ workspaceId: 'ws-1' as WorkspaceId, agentPreset: 'code' })
    expect(created).toBe('child')
  })
})

describe('entry constants', () => {
  it('keeps the access-control reply fixed and the pump cadence sane', () => {
    expect(DENIED_REPLY).toBe('⛔ 无权访问。')
    expect(TYPING_PUMP_INTERVAL_MS).toBe(5_000)
  })
})

describe('command menu', () => {
  it('publishes /keyboard, /attach, and the typing-only console commands under a Telegram-safe name and a Chinese description', () => {
    // /keyboard leads the / menu (the keyboard-area recovery), then /attach
    // (the binding entry); keyboard-covered commands
    // (create/operate/new/fork/archive/stop/curTasks/close) stay out of it.
    expect(COMMANDS.map(entry => entry.command)).toEqual([
      'keyboard', 'attach', 'status', 'model', 'delete', 'rename', 'preset', 'start',
    ])
    for (const entry of COMMANDS) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/)
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeLessThanOrEqual(256)
    }
  })
})

/** A grammY stand-in capturing startup wiring; no network is touched. */
function fakeBot() {
  const deleteMyCommands = vi.fn().mockResolvedValue(true)
  const setMyCommands = vi.fn().mockResolvedValue(true)
  const stop = vi.fn().mockResolvedValue(undefined)
  const startOptions: { onStart?: (botInfo: { username: string }) => void } = {}
  const bot = {
    api: { deleteMyCommands, setMyCommands },
    catch: vi.fn(),
    on: vi.fn(),
    start(options: { onStart?: (botInfo: { username: string }) => void }): Promise<void> {
      if (options.onStart !== undefined) {
        startOptions.onStart = options.onStart
      }
      return Promise.resolve()
    },
    stop,
  } as unknown as Bot
  return { bot, deleteMyCommands, setMyCommands, startOptions, stop }
}

function fakeLogger(): Context['logger'] {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Context['logger']
}

/** A cordis context that only serves the session/event registration (no-op). */
function fakeEvents(): Context {
  return { on: () => () => {} } as unknown as Context
}

describe('startBotSession command registration', () => {
  it('registers the command table at startup and reports the bot as listening', async () => {
    const { bot, setMyCommands, startOptions, stop } = fakeBot()
    const onListened = vi.fn()
    const config: Config = { botToken: 'token:fake', allowChatIds: [1] }
    const session = startBotSession({
      config,
      api: fakeApi().api,
      events: fakeEvents(),
      logger: fakeLogger(),
      onListened,
      createBot: () => bot,
    })
    expect(startOptions.onStart).toBeDefined()
    startOptions.onStart?.({ username: 'fakebot' })
    // The menu sync runs asynchronously behind the scope teardown, so the
    // registration lands on a later tick.
    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledWith(COMMANDS)
    })
    expect(onListened).toHaveBeenCalledWith(config, 'fakebot')
    await session.stop()
    expect(stop).toHaveBeenCalled()
  })

  it('logs a warning but stays listening when command registration fails', async () => {
    const { bot, startOptions } = fakeBot()
    const api = bot.api as unknown as { setMyCommands: (commands: unknown) => Promise<never> }
    api.setMyCommands = vi.fn().mockRejectedValue(new Error('network down'))
    const logger = fakeLogger()
    const warn = logger.warn as ReturnType<typeof vi.fn>
    const onListened = vi.fn()
    const session = startBotSession({
      config: { botToken: 'token:fake', allowChatIds: [1] },
      api: fakeApi().api,
      events: fakeEvents(),
      logger,
      onListened,
      createBot: () => bot,
    })
    startOptions.onStart?.({ username: 'fakebot' })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled()
    })
    expect(String(warn.mock.calls[0]?.[0])).toContain('command menu registration failed')
    expect(onListened).toHaveBeenCalled()
    await session.stop()
  })
})
