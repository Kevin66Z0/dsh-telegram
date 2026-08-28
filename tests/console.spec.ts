/**
 * Console orchestration over fake port and transport: command routing,
 * session binding, prompt forwarding, and realtime push.
 */

import { describe, expect, it, vi } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { ModelCatalogFailure, ModelProviderGroup, SessionSummary, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy'
import type { TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import { ATTACH_READ_LIMIT, MODEL_KEYBOARD_LIMIT, TURN_ERROR_REASON_MAX, TelegramConsole, interpretInput } from '../src/console.ts'
import type { ConsoleTransport, SessionConsolePort } from '../src/console.ts'
import {
  ATTACH_ARCHIVED_DATA, ATTACH_UNGROUPED_DATA, QUEUE_ACK_MAX, TELEGRAM_CHUNK_MAX, TELEGRAM_VERSION, attachSessionData, attachWorkspaceData,
  questionCancelData, questionCustomData, questionOptionData, questionSubmitData, sessionStatusData, sessionStopData, startClockLabel,
  type AnswerButton,
} from '../src/render.ts'

const ID_A = SessionId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const ID_B = SessionId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const ID_C = SessionId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
/** The deterministic child id the FakePort returns for the first fork. */
const FORK_ID_1 = SessionId('dddddddd-dddd-4ddd-8ddd-000000000001')
/** The start-time label the fixed console clock (`() => 2_000`) renders for event time 0. */
const replyClock = startClockLabel(0, 2_000)

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: ID_A,
    updatedAt: 1_000,
    running: false,
    blank: false,
    ...over,
  }
}

function workspace(over: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: 'ws-1' as WorkspaceView['workspaceId'],
    path: '/srv/a',
    title: '项目A',
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** Recording port with a scripted behavior table. */
class FakePort implements SessionConsolePort {
  sessions: SessionSummary[] = []
  history = new Map<string, SessionEvent[]>()
  promptCalls: { sessionId: string; mode: string; text: string }[] = []
  stopCalls: string[] = []
  promptError: Error | undefined
  historyError: Error | undefined
  listError: Error | undefined
  stopError: Error | undefined
  listCalls = 0
  renameCalls: { sessionId: string; title: string }[] = []
  renameError: Error | undefined
  createError: Error | undefined
  createdSession: SessionId = ID_C
  workspaces: WorkspaceView[] = []
  archivedSessionIds: SessionId[] = []
  createCalls: { workspaceId?: string; cwd?: string; agentPreset?: string }[] = []
  createWorkspaceCalls: string[] = []
  archiveCalls: string[] = []
  createWorkspaceError: Error | undefined
  archiveError: Error | undefined
  catalog: { groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] } = { groups: [], failures: [] }
  catalogError: Error | undefined
  setDefaultCalls: { provider: string; model: string }[] = []
  setDefaultError: Error | undefined

  async listSessions(): Promise<SessionSummary[]> {
    this.listCalls++
    if (this.listError !== undefined) throw this.listError
    return this.sessions
  }

  historyReads: { sessionId: string; maxMessages?: number }[] = []

  async readHistory(sessionId: SessionId, maxMessages?: number): Promise<readonly SessionEvent[]> {
    if (this.historyError !== undefined) throw this.historyError
    this.historyReads.push({ sessionId, ...(maxMessages === undefined ? {} : { maxMessages }) })
    return this.history.get(sessionId) ?? []
  }

  async sendPrompt(sessionId: SessionId, mode: 'queue' | 'steer', text: string): Promise<void> {
    if (this.promptError !== undefined) throw this.promptError
    this.promptCalls.push({ sessionId, mode, text })
  }

  async stopSession(sessionId: SessionId): Promise<void> {
    if (this.stopError !== undefined) throw this.stopError
    this.stopCalls.push(sessionId)
  }

  async listGlobalModels(): Promise<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }> {
    if (this.catalogError !== undefined) throw this.catalogError
    return { groups: this.catalog.groups, failures: this.catalog.failures }
  }

  async setGlobalDefaultModel(provider: string, model: string): Promise<void> {
    if (this.setDefaultError !== undefined) throw this.setDefaultError
    this.setDefaultCalls.push({ provider, model })
  }

  async createSession(options?: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<SessionId> {
    if (this.createError !== undefined) throw this.createError
    this.createCalls.push({ ...options })
    return this.createdSession
  }

  async listWorkspaces(): Promise<WorkspaceView[]> {
    return this.workspaces
  }

  async listArchivedSessionIds(): Promise<SessionId[]> {
    return this.archivedSessionIds
  }

  async createWorkspace(path: string): Promise<WorkspaceView> {
    if (this.createWorkspaceError !== undefined) throw this.createWorkspaceError
    this.createWorkspaceCalls.push(path)
    const workspace = this.workspaces.find(item => item.path === path)
    if (workspace !== undefined) return workspace
    const created = {
      workspaceId: `ws-${this.createWorkspaceCalls.length}` as WorkspaceView['workspaceId'],
      path,
      title: path.split('/').pop() ?? path,
      sessionIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    this.workspaces.push(created)
    return created
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    if (this.archiveError !== undefined) throw this.archiveError
    this.archiveCalls.push(sessionId)
  }

  async renameSession(sessionId: SessionId, title: string): Promise<string> {
    if (this.renameError !== undefined) throw this.renameError
    this.renameCalls.push({ sessionId, title })
    return title
  }

  forkCalls: SessionId[] = []
  forkError: Error | undefined
  nextForkId = 0

  async forkSession(sessionId: SessionId): Promise<SessionId> {
    if (this.forkError !== undefined) throw this.forkError
    this.forkCalls.push(sessionId)
    this.nextForkId += 1
    return SessionId(`dddddddd-dddd-4ddd-8ddd-${String(this.nextForkId).padStart(12, '0')}`)
  }

  answerCalls: { rpcId: string; sessionId: string; answer: { answers: { id: string; selected: string[]; custom?: string }[] } }[] = []
  cancelCalls: string[] = []
  answerError: Error | undefined
  cancelError: Error | undefined

  async answerQuestion(
    rpcId: string,
    sessionId: SessionId,
    answer: { answers: { id: string; selected: string[]; custom?: string }[] },
  ): Promise<void> {
    if (this.answerError !== undefined) throw this.answerError
    this.answerCalls.push({ rpcId, sessionId, answer })
  }

  async cancelQuestion(rpcId: string): Promise<void> {
    if (this.cancelError !== undefined) throw this.cancelError
    this.cancelCalls.push(rpcId)
  }

  todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] | null = null
  todosError: Error | undefined
  todosCalls: SessionId[] = []

  async listTodos(sessionId: SessionId): Promise<{ content: string; status: 'pending' | 'in_progress' | 'completed' }[] | null> {
    if (this.todosError !== undefined) throw this.todosError
    this.todosCalls.push(sessionId)
    return this.todos
  }

  presets: { id: string; name?: string; trust: 'system' | 'user'; isDefault: boolean }[] = []
  presetsError: Error | undefined
  presetsCalls = 0

  async listPresets(): Promise<{ id: string; name?: string; trust: 'system' | 'user'; isDefault: boolean }[]> {
    if (this.presetsError !== undefined) throw this.presetsError
    this.presetsCalls++
    return this.presets
  }

  selectCalls: { sessionId: string; agentPreset: string }[] = []
  selectError: Error | undefined

  async selectPreset(sessionId: SessionId, agentPreset: string): Promise<void> {
    if (this.selectError !== undefined) throw this.selectError
    this.selectCalls.push({ sessionId, agentPreset })
  }
}

/** Recording transport; message ids minted per send, edits recorded. */
class FakeTransport implements ConsoleTransport {
  messages: { chatId: number; text: string; messageId: number }[] = []
  edits: { chatId: number; messageId: number; text: string }[] = []
  htmlMessages: { chatId: number; html: string; messageId: number }[] = []
  htmlEdits: { chatId: number; messageId: number; html: string }[] = []
  actions: { chatId: number; action: string }[] = []
  replyKeyboards: { chatId: number; text: string; messageId: number; rows: string[][] }[] = []
  removeKeyboardCalls: { chatId: number; text: string }[] = []
  editError: Error | undefined
  sendError: Error | undefined
  htmlEditError: Error | undefined
  htmlSendError: Error | undefined
  #nextMessageId = 1

  async sendMessage(chatId: number, text: string): Promise<number> {
    if (this.sendError !== undefined) throw this.sendError
    const messageId = this.#nextMessageId++
    this.messages.push({ chatId, text, messageId })
    return messageId
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    if (this.editError !== undefined) throw this.editError
    this.edits.push({ chatId, messageId, text })
  }

  async sendMessageHtml(chatId: number, html: string): Promise<number> {
    if (this.htmlSendError !== undefined) throw this.htmlSendError
    const messageId = this.#nextMessageId++
    this.htmlMessages.push({ chatId, html, messageId })
    return messageId
  }

  async editMessageHtml(chatId: number, messageId: number, html: string): Promise<void> {
    if (this.htmlEditError !== undefined) throw this.htmlEditError
    this.htmlEdits.push({ chatId, messageId, html })
  }

  async sendReplyKeyboard(chatId: number, text: string, rows: ReadonlyArray<ReadonlyArray<string>>): Promise<number> {
    const messageId = this.#nextMessageId++
    this.replyKeyboards.push({
      chatId,
      text,
      messageId,
      rows: rows.map(row => [...row]),
    })
    return messageId
  }

  async removeKeyboard(chatId: number, text: string): Promise<number> {
    const messageId = this.#nextMessageId++
    this.removeKeyboardCalls.push({ chatId, text })
    return messageId
  }

  inlineKeyboards: { chatId: number; text: string; messageId: number; rows: AnswerButton[][] }[] = []
  inlineKeyboardEdits: { chatId: number; messageId: number; text: string; rows: AnswerButton[][] }[] = []

  async sendInlineKeyboard(chatId: number, text: string, rows: AnswerButton[][]): Promise<number> {
    if (this.sendError !== undefined) throw this.sendError
    const messageId = this.#nextMessageId++
    this.inlineKeyboards.push({ chatId, text, messageId, rows })
    return messageId
  }

  async editInlineKeyboard(chatId: number, messageId: number, text: string, rows: AnswerButton[][]): Promise<void> {
    if (this.editError !== undefined) throw this.editError
    this.inlineKeyboardEdits.push({ chatId, messageId, text, rows })
  }

  async sendChatAction(chatId: number, action: 'typing'): Promise<void> {
    this.actions.push({ chatId, action })
  }
}

function userEvent(text: string, source: UserMessage['source'] = { kind: 'user' }): SessionEvent {
  return ({
    type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text }], source },
  } as unknown as SessionEvent)
}

function assistantEvent(text: string, usage?: TokenUsage): SessionEvent {
  return ({
    type: 'assistant/message', seq: 0, time: 0,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] }, ...(usage === undefined ? {} : { usage }) },
  } as unknown as SessionEvent)
}

function assistantToolEvent(text: string, calls: { name: string; arguments?: string }[], usage?: TokenUsage): SessionEvent {
  return ({
    type: 'assistant/message', seq: 0, time: 0,
    data: {
      turn: 1, step: 1,
      message: { content: [{ type: 'text', text }, ...calls.map(call => ({ type: 'tool-call', id: 'c-' + call.name, name: call.name, arguments: call.arguments ?? '{}' }))] },
      ...(usage === undefined ? {} : { usage }),
    },
  } as unknown as SessionEvent)
}

function assistantReasonEvent(text: string): SessionEvent {
  return ({
    type: 'assistant/message', seq: 0, time: 0,
    data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text }] } },
  } as unknown as SessionEvent)
}

function toolCallEvent(name: string): SessionEvent {
  return ({
    type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: `c-${name}`, name, arguments: '{}' },
  } as unknown as SessionEvent)
}

function toolResultEvent(name: string): SessionEvent {
  return ({
    type: 'tool/result', seq: 0, time: 0, data: { turn: 1, step: 1, callId: `c-${name}`, name, message: {} },
  } as unknown as SessionEvent)
}

function turnStart(): SessionEvent {
  return { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }
}

function turnEnd(reason: { kind: string }): SessionEvent {
  return ({ type: 'turn/end', seq: 0, time: 0, data: { turn: 1, reason } } as unknown as SessionEvent)
}

function turnEndError(message: string): SessionEvent {
  return ({
    type: 'turn/end', seq: 0, time: 0,
    data: { turn: 1, reason: { kind: 'error', error: { message, code: 'UNKNOWN' } } },
  } as unknown as SessionEvent)
}

function askedEvent(rpcId: string, questions: unknown[]): SessionEvent {
  return ({
    type: 'question/asked', seq: 0, time: 0, data: { id: rpcId, questions },
  } as unknown as SessionEvent)
}

function decidedEvent(rpcId: string, outcome: 'answered' | 'cancelled'): SessionEvent {
  return ({
    type: 'question/decided', seq: 0, time: 0, data: { id: rpcId, outcome },
  } as unknown as SessionEvent)
}

function setup(over: { port?: Partial<FakePort> } = {}): { console: TelegramConsole; port: FakePort; transport: FakeTransport } {
  const port = new FakePort()
  const transport = new FakeTransport()
  Object.assign(port, over.port)
  const console = new TelegramConsole(port, transport, () => 2_000)
  return { console, port, transport }
}

function replyTexts(transport: FakeTransport): string {
  return transport.messages.map(message => message.text).join('\n')
}

function htmlTexts(transport: FakeTransport): string {
  return transport.htmlMessages.map(message => message.html).join('\n')
}

/** The message the open turn creates at turn/start, resolving its real id. */
function streamMessage(transport: FakeTransport): { chatId: number; messageId: number; text: string } {
  const message = transport.messages.at(-1)
  if (message === undefined) throw new Error('turn/start must open the stream message')
  return message
}

/** A small two-provider host-wide catalog with intact defaults. */
function catalogFixture(over: Partial<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }> = {}): {
  groups: ModelProviderGroup[]
  failures: ModelCatalogFailure[]
} {
  return {
    groups: [
      {
        id: 'deepseek', name: 'DeepSeek', models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
      },
      { id: 'glm', name: 'GLM', models: [{ id: 'glm-4', name: 'GLM-4' }] },
    ],
    failures: [],
    ...over,
  }
}

/** The shared action rows every reply keyboard leads with. */
const ACTION_ROWS: string[][] = [
  ['/create', '/archive', '/attach'],
  ['/stop', '/close'],
]

describe('interpretInput', () => {
  it('parses commands, stripping @bot suffixes and lowercasing', () => {
    expect(interpretInput('/Attach@mybot 5')).toEqual({ name: 'attach', args: '5' })
    expect(interpretInput('/view x')).toEqual({ name: 'view', args: 'x' })
  })

  it('treats a bare slash as an empty-name command', () => {
    expect(interpretInput('/')).toEqual({ name: '', args: '' })
  })

  it('works with the default clock when no now is injected', async () => {
    const port = new FakePort()
    const transport = new FakeTransport()
    port.sessions = [summary({ sessionId: ID_A, cwd: '/w', updatedAt: 1_000 })]
    const console = new TelegramConsole(port, transport)
    await console.handleMessage(10, '/attach')
    expect(transport.inlineKeyboards.at(-1)?.text).toContain('选择会话范围')
    // A scoped list reads the default clock for the age column; a finished
    // (non-blank idle) session shows the ✅ glyph.
    await console.handleMessage(10, '/attach none')
    expect(transport.inlineKeyboards.at(-1)?.text).toContain('1) ✅')
  })

  it('passes plain text and backslash-escaped text through', () => {
    expect(interpretInput('你好')).toEqual({ kind: 'prompt', text: '你好' })
    expect(interpretInput('\\/model')).toEqual({ kind: 'prompt', text: '/model' })
    expect(interpretInput('a / b')).toEqual({ kind: 'prompt', text: 'a / b' })
  })
})

describe('prompt forwarding', () => {
  it('asks to open a session first when none is bound', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '你好')
    expect(replyTexts(transport)).toContain('还没有绑定会话')
  })

  it('acks a queued prompt with its pending content and keeps steering silent', async () => {
    const { console, port, transport } = setup()
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '第一句')
    expect(transport.messages.map(message => message.text)).toEqual(['📥 已加入队列：第一句'])
    await console.onSessionEvent(ID_A, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
    transport.messages = []
    await console.handleMessage(10, '第二句')
    expect(transport.messages).toEqual([])
    expect(port.promptCalls).toEqual([
      { sessionId: ID_A, mode: 'queue', text: '第一句' },
      { sessionId: ID_A, mode: 'steer', text: '第二句' },
    ])
  })

  it('caps the queue ack text at the acknowledgement budget', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    const long = '长'.repeat(500)
    await console.handleMessage(10, long)
    expect(transport.messages.map(message => message.text)).toEqual([`📥 已加入队列：${'长'.repeat(QUEUE_ACK_MAX)}…`])
  })

  it('surfaces prompt refusals as ⛔ replies', async () => {
    const { console, port, transport } = setup()
    await console.handleMessage(10, `/attach ${ID_A}`)
    port.promptError = new Error('会话不存在（session-not-found）')
    await console.handleMessage(10, '你好')
    expect(replyTexts(transport)).toContain('⛔ 会话不存在（session-not-found）')
  })

  it('ignores whitespace-only prompts', async () => {
    const { console, port, transport } = setup()
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '   ')
    await console.handleMessage(10, '\\')
    expect(port.promptCalls).toEqual([])
    expect(transport.messages).toEqual([])
  })
})

describe('/attach scope picker', () => {
  it('offers workspaces, ungrouped, and archived scopes; a workspace tap lists its sessions then binds', async () => {
    const { console, port, transport } = setup()
    const ID_D = SessionId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
    port.sessions = [
      summary({ sessionId: ID_A, running: true, cwd: '/w/a', updatedAt: 1_800, projections: { asOfSeq: 0, values: { title: '会话甲' } } }),
      summary({ sessionId: ID_B, cwd: '/w/b', updatedAt: 1_200, projections: { asOfSeq: 0, values: { title: '会话乙' } } }),
      summary({ sessionId: ID_C, cwd: '/w/c' }),
      summary({ sessionId: ID_C, origin: 'subagent', cwd: '/w/d' }),
      summary({ sessionId: ID_D, cwd: '/w/e' }),
    ]
    port.archivedSessionIds = [ID_D]
    port.workspaces = [{ ...workspace(), workspaceId: 'ws-1' as WorkspaceView['workspaceId'], title: '项目A', sessionIds: [ID_A, ID_B] }]
    await console.handleMessage(10, '/attach')
    const picker = transport.inlineKeyboards.at(-1)
    expect(picker?.text).toContain('选择会话范围')
    expect(picker?.text).toContain('1) 📁 项目A')
    expect(picker?.text).toContain('/attach none（未分组）')
    expect(picker?.text).toContain('/attach arc（归档）')
    expect(picker?.rows).toEqual([
      [{ text: '📁 项目A', data: attachWorkspaceData('ws-1') }],
      [{ text: '未分组', data: ATTACH_UNGROUPED_DATA }],
      [{ text: '归档', data: ATTACH_ARCHIVED_DATA }],
    ])
    // The attach keyboard installs with the picker itself: running first,
    // then the recent completed, global across scopes — the archived /w/e
    // stays out of the keyboard area (it surfaces through the arc scope).
    expect(transport.replyKeyboards).toHaveLength(1)
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · 🟢 会话甲'],
      ['/attach 2 · ✅ 会话乙'],
      ['/attach 3 · ✅ /w/c'],
    ])
    // A workspace picker tap lists every member of that workspace, newest first.
    await console.handleCallback(10, attachWorkspaceData('ws-1'))
    const list = transport.inlineKeyboards.at(-1)
    expect(list?.text).toContain('工作区「项目A」的会话')
    expect(list?.rows).toEqual([
      [{ text: '🟢 会话甲', data: attachSessionData(ID_A) }],
      [{ text: '✅ 会话乙', data: attachSessionData(ID_B) }],
    ])
    await console.handleMessage(10, '/attach 1')
    expect(port.historyReads).toContainEqual({ sessionId: ID_A, maxMessages: ATTACH_READ_LIMIT })
    // A bind-button tap binds through the callback path, no typing.
    await console.handleCallback(10, attachSessionData(ID_A))
    expect(port.historyReads).toContainEqual({ sessionId: ID_A, maxMessages: ATTACH_READ_LIMIT })
    transport.messages = []
    await console.handleMessage(10, '随后')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '随后' }])
  })

  it('none lists ungrouped sessions only; archived membership hides a session from its workspace', async () => {
    const { console, port, transport } = setup()
    // A is the newest completed session but archived, so it stays out of the
    // keyboard; the keyboard's global rows back numeric /attach selectors.
    port.sessions = [summary({ sessionId: ID_A, updatedAt: 2_000 }), summary({ sessionId: ID_B })]
    port.archivedSessionIds = [ID_A]
    port.workspaces = [{ ...workspace(), workspaceId: 'ws-1' as WorkspaceView['workspaceId'], title: '项目A', sessionIds: [ID_A] }]
    await console.handleMessage(10, '/attach none')
    const ungrouped = transport.inlineKeyboards.at(-1)
    expect(ungrouped?.rows).toEqual([[{ text: '✅ bbbbbbbb…bb', data: attachSessionData(ID_B) }]])
    // The keyboard-area attach list installs with the list: running first,
    // then the recent completed, global across scopes — archived excluded.
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.text).toContain('快捷绑定')
    expect(keyboard?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · ✅ bbbbbbbb…bb'],
    ])
    await console.handleMessage(10, '/attach 1')
    expect(port.historyReads).toContainEqual({ sessionId: ID_B, maxMessages: ATTACH_READ_LIMIT })
    // The archived member is hidden from its workspace group, so its
    // workspace now shows an empty list.
    await console.handleMessage(10, '/attach')
    // The keyboard owns the numeric selector now: browsing a workspace is a
    // tap on the picker's scope button (the archived member hides from it).
    await console.handleCallback(10, attachWorkspaceData('ws-1'))
    expect(replyTexts(transport)).toContain('工作区「项目A」的会话：（暂无会话）')
    // The archived session still binds through its own arc scope: it lists
    // there, never in the keyboard area, and binds once the keyboard is
    // dismissed (so the number resolves inside the inline list rows).
    await console.handleMessage(10, '/attach arc')
    const archived = transport.inlineKeyboards.at(-1)
    expect(archived?.text).toContain('归档会话')
    expect(archived?.rows).toEqual([[{ text: '✅ aaaaaaaa…aa', data: attachSessionData(ID_A) }]])
    expect(transport.replyKeyboards.at(-1)?.rows.join(' ')).not.toContain('aaaaaaaa')
    await console.handleMessage(10, '/close')
    await console.handleMessage(10, '/close')
    await console.handleMessage(10, '/attach 1')
    expect(port.historyReads).toContainEqual({ sessionId: ID_A, maxMessages: ATTACH_READ_LIMIT })
  })

  it('reports an empty scope and rejects a stale workspace index while the picker is live', async () => {
    const { console, port, transport } = setup()
    await console.handleMessage(10, '/attach')
    await console.handleMessage(10, '/attach 9')
    expect(replyTexts(transport)).toContain('工作区序号 9 超出范围')
    port.sessions = []
    await console.handleMessage(10, '/attach none')
    expect(replyTexts(transport)).toContain('未分组会话：（暂无会话）')
    expect(transport.replyKeyboards).toHaveLength(0)
  })

  it('rejects a stale workspace button tap while the picker is live', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/attach')
    await console.handleCallback(10, attachWorkspaceData('ws-gone'))
    expect(replyTexts(transport)).toContain('⛔ 该工作区已失效，请重新 /attach。')
  })

  it('binds a full session id directly even while the scope picker is live', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, '/attach')
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(htmlTexts(transport)).toContain('🔗 已绑定')
    expect(port.historyReads).toContainEqual({ sessionId: ID_A, maxMessages: ATTACH_READ_LIMIT })
  })

  it('surfaces list failures', async () => {
    const { console, port, transport } = setup()
    port.listError = new Error('内部错误')
    await console.handleMessage(10, '/attach none')
    expect(replyTexts(transport)).toContain('⛔ 内部错误')
  })

  it('renders non-Error failures verbatim', async () => {
    const { console, port, transport } = setup()
    port.listError = '纯字符串失败' as unknown as Error
    await console.handleMessage(10, '/attach none')
    expect(replyTexts(transport)).toContain('⛔ 纯字符串失败')
    port.promptError = '拒绝发送' as unknown as Error
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '你好')
    expect(replyTexts(transport)).toContain('⛔ 拒绝发送')
    port.stopError = '拒绝停止' as unknown as Error
    await console.handleMessage(10, '/stop')
    expect(replyTexts(transport)).toContain('⛔ 拒绝停止')
  })
})

describe('/attach', () => {
  it('binds after a successful read and shows the last two assistant replies', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [
      userEvent('一轮一'), assistantEvent('甲'),
      userEvent('一轮二'), assistantEvent('乙'),
      { type: 'tool/call', seq: 0, time: 0, data: { callId: 'c1', name: 'read_file', arguments: '{"path":"/a"}' } } as unknown as SessionEvent,
      userEvent('二轮'), assistantEvent('丙'),
    ])
    await console.handleMessage(10, `/attach ${ID_A}`)
    const text = htmlTexts(transport)
    expect(text).toContain('🔗 已绑定')
    expect(text).toContain('最近 2 轮对话：')
    expect(text).toContain('🤖 乙')
    expect(text).toContain('🤖 丙')
    expect(text).not.toContain('🤖 甲')
    expect(text).not.toContain('🔧 read_file')
    // The page tail is an open turn (an unpaired tool call), so the bind
    // reconciled the chat's typing state to running: a follow-up interjects
    // (steer) instead of queueing behind the turn.
    await console.handleMessage(10, '随后')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'steer', text: '随后' }])
  })

  it('never renders user messages in the attach dialogue preview', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [
      userEvent('工作区指令', { kind: 'agent-instructions', form: 'instructions', changes: [] }),
      userEvent('一轮'), assistantEvent('甲'),
    ])
    await console.handleMessage(10, `/attach ${ID_A}`)
    const text = htmlTexts(transport)
    expect(text).toContain('🤖 甲')
    expect(text).not.toContain('🧑')
    expect(text).not.toContain('工作区指令')
  })

  it('offers the scope picker as inline buttons when no target is given', async () => {
    const { console, port, transport } = setup()
    port.workspaces = [{ ...workspace(), workspaceId: 'ws-1' as WorkspaceView['workspaceId'], title: '项目A', sessionIds: [] }]
    await console.handleMessage(10, '/attach')
    const keyboard = transport.inlineKeyboards.at(-1)
    expect(keyboard?.text).toContain('选择会话范围')
    expect(keyboard?.text).not.toContain('未分组')
    expect(keyboard?.text).not.toContain('归档')
    expect(keyboard?.rows).toEqual([[{ text: '📁 项目A', data: attachWorkspaceData('ws-1') }]])
    expect(transport.replyKeyboards).toHaveLength(0)
  })

  it('walks the picker to a scoped list and binds from an inline tap', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '会话甲' } } })]
    port.workspaces = [{ ...workspace(), workspaceId: 'ws-1' as WorkspaceView['workspaceId'], title: '项目A', sessionIds: [ID_A] }]
    await console.handleMessage(10, '/attach')
    // The attach keyboard installs with the bare /attach itself.
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · ✅ 会话甲'],
    ])
    // A picker tap walks into the scoped list.
    await console.handleCallback(10, attachWorkspaceData('ws-1'))
    const list = transport.inlineKeyboards.at(-1)
    expect(list?.text).toContain('工作区「项目A」的会话')
    // A tap on the bind button binds through the callback path, no typing.
    await console.handleCallback(10, attachSessionData(ID_A))
    expect(port.historyReads).toContainEqual({ sessionId: ID_A, maxMessages: ATTACH_READ_LIMIT })
  })

  it('keeps an existing binding when the read fails', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.history.set(ID_B, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    port.historyError = new Error('打不开')
    await console.handleMessage(10, `/attach ${ID_B}`)
    expect(replyTexts(transport)).toContain('⛔ 打不开')
    transport.messages = []
    await console.handleMessage(10, '你好')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '你好' }])
  })

  it('previews blank sessions as 空白会话', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(htmlTexts(transport)).toContain('（空白会话）')
  })

  it('chunks a preview that exceeds the per-message budget', async () => {
    const { console, port, transport } = setup()
    const long = '很长'.repeat(4_000) // 8000 code points, over TELEGRAM_CHUNK_MAX
    port.history.set(ID_A, [turnStart(), assistantEvent(long)])
    await console.handleMessage(10, `/attach ${ID_A}`)
    const html = transport.htmlMessages.map(message => message.html)
    expect(html.length).toBeGreaterThan(1)
    for (const message of html) {
      expect(Array.from(message).length, message).toBeLessThanOrEqual(TELEGRAM_CHUNK_MAX)
    }
    expect(html.join('')).toContain(long)
  })

  it('shows open tool calls as action lines in an expandable blockquote when attaching mid-turn', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [turnStart(), assistantToolEvent('正在读文件', [{ name: 'read_file' }]), toolCallEvent('read_file')])
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(transport.htmlMessages.at(-1)?.html).toBe(`🔧 进行中：\n<blockquote expandable>${replyClock}🔧 read_file — {}</blockquote>`)
  })

  it('keeps the action blockquote while a running turn composes its reply', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [
      turnStart(),
      assistantToolEvent('读一下', [{ name: 'read_file' }]),
      toolCallEvent('read_file'),
      toolResultEvent('read_file'),
      assistantEvent('正在写正文'),
    ])
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(transport.htmlMessages.at(-1)?.html).toBe(`🔧 进行中：\n<blockquote expandable>${replyClock}🔧 read_file — {}</blockquote>`)
  })

  it('shows a bare in-progress marker for an open turn with no actions yet', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [turnStart()])
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(transport.htmlMessages.at(-1)?.html).toBe('⏳ 进行中…')
  })

  it('drives the typing pump after attaching to a running turn', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [turnStart(), assistantToolEvent('读一下', [{ name: 'read_file' }]), toolCallEvent('read_file')])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.pumpTyping()
    expect(transport.actions).toEqual([{ chatId: 10, action: 'typing' }])
  })

  it('stops a leftover typing pump from a previous binding when attaching to a finished session', async () => {
    const { console, port, transport } = setup()
    // Chat 10 watches ID_A while its turn runs (typing on), then re-attaches
    // to the idle ID_B: the open turn's later events no longer reach this
    // chat, so without the attach-time reconciliation the pump would keep
    // typing forever although the bound session is idle.
    port.history.set(ID_A, [])
    port.history.set(ID_B, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    await console.handleMessage(10, `/attach ${ID_B}`)
    transport.actions = []
    await console.pumpTyping()
    expect(transport.actions).toEqual([])
  })

  it('drops a stale stream from the previous binding on attach', async () => {
    const { console, port, transport } = setup()
    // ID_A's open turn left a live stream message; re-attaching to ID_B must
    // not keep editing it, so ID_B's first pushed reply lands on a fresh
    // message.
    port.history.set(ID_A, [])
    port.history.set(ID_B, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stale = streamMessage(transport)
    await console.handleMessage(10, `/attach ${ID_B}`)
    transport.messages = []
    transport.edits = []
    await console.onSessionEvent(ID_B, assistantEvent('来自 B'))
    expect(transport.edits).toEqual([])
    expect(transport.messages).toHaveLength(1)
    const [sent] = transport.messages
    expect(sent?.chatId).toBe(10)
    expect(sent?.text).toContain('🤖 来自 B')
    expect(sent?.messageId).toBeTypeOf('number')
    expect(stale).toBeDefined()
  })

  it('skips the action blockquote once the turn ends', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [turnStart(), assistantToolEvent('读一下', [{ name: 'read_file' }]), toolCallEvent('read_file'), turnEnd({ kind: 'completed' })])
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(transport.htmlMessages.at(-1)?.html).toContain(`🔗 已绑定 ${ID_A}`)
    expect(transport.htmlMessages.at(-1)?.html).toContain('🤖 读一下')
    expect(transport.htmlMessages.at(-1)?.html).not.toContain('🧭 最近动作')
    expect(htmlTexts(transport)).not.toContain('read_file')
  })

  it('closes the preview of a finished session with its last turn token-usage footer', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [
      turnStart(),
      assistantEvent('甲', { inputTokens: 500, outputTokens: 100, cacheReadTokens: 300 }),
      assistantEvent('乙', { inputTokens: 700, outputTokens: 200, cacheReadTokens: 300 }),
      turnEnd({ kind: 'completed' }),
    ])
    await console.handleMessage(10, `/attach ${ID_A}`)
    const footer = transport.htmlMessages.at(-1)?.html
    expect(footer).toContain('<pre>⚡ 本轮: ↑1.2k ↓300 · 缓存命中 33%</pre>')
    expect(htmlTexts(transport)).toContain('🤖 乙')
    expect(htmlTexts(transport)).not.toContain('🧭 最近动作')
  })

  it('omits the token footer while the turn is still running', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [
      turnStart(),
      assistantEvent('甲', { inputTokens: 500, outputTokens: 100 }),
    ])
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(htmlTexts(transport)).not.toContain('⚡ 本轮')
  })

  it('omits the token footer when the finished turn carried no usage accounting', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [turnStart(), assistantEvent('甲'), turnEnd({ kind: 'completed' })])
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(htmlTexts(transport)).not.toContain('⚡ 本轮')
  })

  it('omits the token footer for a blank session', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(htmlTexts(transport)).not.toContain('⚡ 本轮')
    expect(htmlTexts(transport)).toContain('（空白会话）')
  })

  it('re-renders a pending ask when attaching to a waiting session', async () => {
    const { console, port, transport } = setup()
    const questions = [{ id: 'q1', question: '这次改哪个模块？', options: [{ label: 'core' }, { label: 'api' }, { label: 'web' }] }]
    const rpcId = '11111111-2222-4333-8444-555555555555'
    port.history.set(ID_A, [turnStart(), askedEvent(rpcId, questions)])
    await console.handleMessage(10, `/attach ${ID_A}`)
    const ask = transport.inlineKeyboards.at(-1)
    expect(ask?.text).toContain('这次改哪个模块？')
    if (ask === undefined) throw new Error('ask must send an inline keyboard')
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    expect(port.answerCalls).toEqual([{ rpcId, sessionId: ID_A, answer: { answers: [{ id: 'q1', selected: ['core'] }] } }])
  })

  it('rejects out-of-range indexes before touching the binding', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/attach 42')
    expect(replyTexts(transport)).toContain('序号 42 超出范围')
    await console.handleMessage(10, '你好')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '你好' }])
  })

  it('rejects unknown ids only after the target resolves', async () => {
    const { console, port, transport } = setup()
    port.historyError = new Error('会话不存在（session-not-found）')
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(replyTexts(transport)).toContain('⛔ 会话不存在')
  })

  it('conveys read failures', async () => {
    const { console, port, transport } = setup()
    port.historyError = new Error('读取失败')
    await console.handleMessage(10, `/attach ${ID_A}`)
    expect(replyTexts(transport)).toContain('⛔ 读取失败')
  })
})

describe('/close', () => {
  it('dismisses the keyboard only on the second /close, keeping the session binding', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/close')
    // The first /close only arms the confirmation; nothing is dismissed yet.
    expect(transport.removeKeyboardCalls).toEqual([])
    expect(replyTexts(transport)).toContain('⚠️ 确认收起快捷键盘？再次发送 /close 确认')
    await console.handleMessage(10, '/close')
    expect(transport.removeKeyboardCalls).toEqual([{ chatId: 10, text: '已收起快捷键盘，会话绑定不变。' }])
    await console.handleMessage(10, '你好')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '你好' }])
  })

  it('a different command cancels the armed /close and runs normally', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/close')
    await console.handleMessage(10, '/status')
    expect(transport.removeKeyboardCalls).toEqual([])
    await console.handleMessage(10, '/close')
    // The arm was cancelled: the next /close arms again instead of dismissing.
    expect(transport.removeKeyboardCalls).toEqual([])
  })

  it('free text cancels the armed /close and forwards as a prompt', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/close')
    await console.handleMessage(10, '别收')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '别收' }])
    expect(transport.removeKeyboardCalls).toEqual([])
    await console.handleMessage(10, '/close')
    // Still only an arm: the free text cancelled the previous confirmation.
    expect(transport.removeKeyboardCalls).toEqual([])
  })
})

describe('keyboard reset', () => {
  it('restores the shared action rows after /attach when a picker keyboard is showing', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.presets = [{ id: 'standard', name: '标准模式', trust: 'system' as const, isDefault: true }]
    await console.handleMessage(10, '/preset')
    expect(transport.replyKeyboards).toHaveLength(1)
    await console.handleMessage(10, '/attach')
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.text).toContain('已回到常用操作')
    expect(keyboard?.rows).toEqual([...ACTION_ROWS.map(row => [...row])])
  })

  it('does not pop a keyboard when none is showing', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/attach')
    expect(transport.replyKeyboards).toEqual([])
  })

  it('replaces a live /delete list with the attach keyboard when /attach runs', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '会话甲' } } })]
    await console.handleMessage(10, '/delete')
    expect(transport.replyKeyboards).toHaveLength(1)
    await console.handleMessage(10, '/attach')
    // Bare /attach brings its own keyboard, replacing the delete list.
    expect(transport.replyKeyboards).toHaveLength(2)
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · ✅ 会话甲'],
    ])
  })

  it('replaces the /create sub-menu with the action rows when /attach runs', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/create')
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([['/new', '/fork']])
    await console.handleMessage(10, '/attach')
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([...ACTION_ROWS.map(row => [...row])])
    expect(transport.replyKeyboards.at(-1)?.text).toContain('已回到常用操作')
  })

  it('resets stale picker rows when /stop runs on the bound session', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.replyKeyboards = []
    port.presets = [{ id: 'standard', name: '标准模式', trust: 'system' as const, isDefault: true }]
    await console.handleMessage(10, '/preset')
    expect(transport.replyKeyboards).toHaveLength(1)
    await console.handleMessage(10, '/stop')
    expect(port.stopCalls).toEqual([ID_A])
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([...ACTION_ROWS.map(row => [...row])])
  })
})

describe('/attach keyboard', () => {
  it('lists running sessions first, then the recent five completed — global across scopes', async () => {
    const { console, port, transport } = setup()
    const sid = (n: string) => SessionId(`11111111-1111-4111-8111-${n}`)
    const done = (n: string, updatedAt: number, title: string) =>
      summary({ sessionId: sid(n), updatedAt, projections: { asOfSeq: 0, values: { title } } })
    port.sessions = [
      done('000000000006', 400, '完成6'), // oldest completed — dropped from the recent five
      done('000000000001', 900, '完成1'),
      summary({ sessionId: sid('0000000000a1'), running: true, updatedAt: 100, projections: { asOfSeq: 0, values: { title: '运行一' } } }),
      done('000000000002', 800, '完成2'),
      done('000000000003', 700, '完成3'),
      done('000000000004', 600, '完成4'),
      done('000000000005', 500, '完成5'),
      summary({ sessionId: sid('0000000000b2'), running: true, updatedAt: 50, projections: { asOfSeq: 0, values: { title: '运行二' } } }),
    ]
    await console.handleMessage(10, '/attach')
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.text).toContain('运行中的全部会话，加最近完成的 5 个')
    expect(keyboard?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · 🟢 运行一'],
      ['/attach 2 · 🟢 运行二'],
      ['/attach 3 · ✅ 完成1'],
      ['/attach 4 · ✅ 完成2'],
      ['/attach 5 · ✅ 完成3'],
      ['/attach 6 · ✅ 完成4'],
      ['/attach 7 · ✅ 完成5'],
    ])
    expect(keyboard?.rows.join(' ')).not.toContain('完成6')
    // Picking a scope keeps the keyboard — no re-send for the same global list.
    await console.handleMessage(10, '/attach none')
    expect(transport.replyKeyboards).toHaveLength(1)
    // A typed selector and a tapped button bind the keyboard's own rows.
    await console.handleMessage(10, '/attach 3')
    expect(port.historyReads).toContainEqual({ sessionId: sid('000000000001'), maxMessages: ATTACH_READ_LIMIT })
    await console.handleMessage(10, '/attach 2')
    expect(port.historyReads).toContainEqual({ sessionId: sid('0000000000b2'), maxMessages: ATTACH_READ_LIMIT })
  })

  it('excludes archived sessions from the keyboard-area attach list', async () => {
    const { console, port, transport } = setup()
    const sid = (n: string) => SessionId(`11111111-1111-4111-8111-${n}`)
    const done = (n: string, updatedAt: number, title: string) =>
      summary({ sessionId: sid(n), updatedAt, projections: { asOfSeq: 0, values: { title } } })
    port.sessions = [
      done('000000000001', 900, '完成1'),
      done('000000000002', 800, '归档完成2'),
      summary({ sessionId: sid('0000000000a1'), running: true, updatedAt: 100, projections: { asOfSeq: 0, values: { title: '运行一' } } }),
      done('000000000003', 700, '完成3'),
    ]
    port.archivedSessionIds = [sid('000000000002')]
    await console.handleMessage(10, '/attach')
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · 🟢 运行一'],
      ['/attach 2 · ✅ 完成1'],
      ['/attach 3 · ✅ 完成3'],
    ])
    expect(keyboard?.rows.join(' ')).not.toContain('归档完成2')
    // The archived session still lists (and binds) under its own arc scope.
    await console.handleMessage(10, '/attach arc')
    const archived = transport.inlineKeyboards.at(-1)
    expect(archived?.rows).toEqual([
      [{ text: '✅ 归档完成2', data: attachSessionData(sid('000000000002')) }],
    ])
  })

  it('refreshes the attach keyboard on a fresh bare /attach so a newly running session leads the list', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_B, projections: { asOfSeq: 0, values: { title: '会话乙' } } })]
    await console.handleMessage(10, '/attach')
    expect(transport.replyKeyboards).toHaveLength(1)
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · ✅ 会话乙'],
    ])
    // A session starts running after the first install: the next bare /attach
    // must re-install the keyboard, running sessions first.
    port.sessions = [
      summary({ sessionId: ID_A, running: true, projections: { asOfSeq: 0, values: { title: '会话甲' } } }),
      summary({ sessionId: ID_B, projections: { asOfSeq: 0, values: { title: '会话乙' } } }),
    ]
    await console.handleMessage(10, '/attach')
    expect(transport.replyKeyboards).toHaveLength(2)
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · 🟢 会话甲'],
      ['/attach 2 · ✅ 会话乙'],
    ])
    // The refreshed keyboard's rows back the numeric selector: a number binds, not a workspace.
    await console.handleMessage(10, '/attach 1')
    expect(port.historyReads).toContainEqual({ sessionId: ID_A, maxMessages: ATTACH_READ_LIMIT })
  })

  it('re-opens the keyboard area with /keyboard when no attach keyboard is installed', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/keyboard')
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual(ACTION_ROWS.map(row => [...row]))
  })

  it('refreshes the installed attach keyboard with /keyboard', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '会话甲' } } })]
    await console.handleMessage(10, '/attach')
    expect(transport.replyKeyboards).toHaveLength(1)
    await console.handleMessage(10, '/keyboard')
    expect(transport.replyKeyboards).toHaveLength(2)
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · ✅ 会话甲'],
    ])
    // The refreshed keyboard's rows still back the numeric selector.
    await console.handleMessage(10, '/attach 1')
    expect(port.historyReads).toContainEqual({ sessionId: ID_A, maxMessages: ATTACH_READ_LIMIT })
  })

  it('is replaced by the /delete keyboard, whose rows take over the numeric path', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A }), summary({ sessionId: ID_B })]
    await console.handleMessage(10, '/attach none')
    expect(transport.replyKeyboards).toHaveLength(1)
    await console.handleMessage(10, '/delete')
    expect(transport.replyKeyboards).toHaveLength(2)
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/delete 1 · ✅ aaaaaaaa…aa'],
      ['/delete 2 · ✅ bbbbbbbb…bb'],
    ])
    // The attach keyboard is gone: a number now resolves inside the delete list.
    await console.handleMessage(10, '/attach 2')
    expect(port.historyReads).toContainEqual({ sessionId: ID_B, maxMessages: ATTACH_READ_LIMIT })
  })

  it('survives /status: /attach <n> still binds its rows while /status <n> uses the inline list', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, running: true }), summary({ sessionId: ID_B })]
    await console.handleMessage(10, '/attach none')
    await console.handleMessage(10, '/status')
    // The status list is inline — no new reply keyboard, the attach keyboard stays.
    expect(transport.replyKeyboards).toHaveLength(1)
    await console.handleMessage(10, '/status 2')
    expect(replyTexts(transport)).toContain('版本:')
    // /attach <n> still binds the attach keyboard's own rows (running first).
    await console.handleMessage(10, '/attach 1')
    expect(port.historyReads).toContainEqual({ sessionId: ID_A, maxMessages: ATTACH_READ_LIMIT })
  })

  it('is dismissed by /close, leaving the inline list rows for typed selectors', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '会话甲' } } })]
    await console.handleMessage(10, '/attach none')
    expect(transport.replyKeyboards).toHaveLength(1)
    // The confirmation flow needs two /close sends.
    await console.handleMessage(10, '/close')
    await console.handleMessage(10, '/close')
    expect(transport.removeKeyboardCalls).toHaveLength(1)
    // The attach keyboard is gone: a number resolves inside the inline list rows.
    await console.handleMessage(10, '/attach 1')
    expect(port.historyReads).toContainEqual({ sessionId: ID_A, maxMessages: ATTACH_READ_LIMIT })
  })
})

describe('/stop', () => {
  it('stops the bound session and refuses arguments', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A }), summary({ sessionId: ID_B })]
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/stop')
    expect(port.stopCalls).toEqual([ID_A])
    await console.handleMessage(10, '/stop 2')
    expect(port.stopCalls).toEqual([ID_A])
    expect(replyTexts(transport)).toContain('⛔ /stop 不需要参数：它停止当前绑定的会话。')
  })

  it('offers an inline stop list when nothing is bound', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '会话甲' } } })]
    await console.handleMessage(10, '/stop')
    const keyboard = transport.inlineKeyboards.at(-1)
    expect(keyboard?.text).toContain('没有打开会话。点下方按钮停止对应会话：')
    expect(keyboard?.rows?.[0]).toEqual([{ text: '⏹ ✅ 会话甲', data: sessionStopData(ID_A) }])
    expect(transport.replyKeyboards).toEqual([])
    await console.handleCallback(10, sessionStopData(ID_A))
    expect(port.stopCalls).toEqual([ID_A])
  })

  it('degrades to a hint on an empty session list', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/stop')
    expect(replyTexts(transport)).toContain('当前没有可用会话。用 /new 创建一个。')
  })

  it('surfaces port refusals on the bound session', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    port.stopError = new Error('拒绝停止')
    await console.handleMessage(10, '/stop')
    expect(replyTexts(transport)).toContain('⛔ 拒绝停止')
    port.stopError = '拒绝停止' as unknown as Error
    transport.messages = []
    await console.handleMessage(10, '/stop')
    expect(replyTexts(transport)).toContain('⛔ 拒绝停止')
  })
})

describe('/status', () => {
  it('reports the bound session from a fresh list', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, running: true, cwd: '/w/a', updatedAt: 1_800, agentPreset: 'code' })]
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/status')
    const text = replyTexts(transport)
    expect(text).toContain(`版本: ${TELEGRAM_VERSION}`)
    expect(text).toContain('🟢 运行中')
    expect(text).toContain('目录: /w/a')
    expect(text).toContain('预设: code')
    expect(text).toContain('消息: 用户 0 · 助手 0 · 工具调用 0')
    expect(text).toContain('上下文 ~0 字符（近 0 条消息）')
    // The status tail is usage statistics now, never the attach hint.
    expect(text).not.toContain('使用 /attach')
  })

  it('offers an inline status list when unbound and reports missing ids', async () => {
    const { console, port, transport } = setup()
    // Unbound with sessions available → an inline list with status buttons.
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '会话甲' } } })]
    await console.handleMessage(10, '/status')
    const keyboard = transport.inlineKeyboards.at(-1)
    expect(keyboard?.text).toContain('没有打开会话。点下方按钮查看会话详情：')
    expect(keyboard?.rows?.[0]).toEqual([{ text: '📊 ✅ 会话甲', data: sessionStatusData(ID_A) }])
    expect(transport.replyKeyboards).toEqual([])
    // The typed selector resolves inside the listed rows.
    await console.handleMessage(10, '/status 1')
    expect(replyTexts(transport)).toContain('会话甲')
    // A session id absent from the list still reports 不存在.
    port.sessions = []
    await console.handleMessage(10, `/status ${ID_C}`)
    expect(replyTexts(transport)).toContain('不存在')
  })

  it('reports an idle session with all-absent metadata and a null title', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: null } } })]
    await console.handleMessage(10, `/status ${ID_A}`)
    const text = replyTexts(transport)
    expect(text).toContain('⚪ 空闲')
    expect(text).toContain('目录: （未记录）')
    expect(text).toContain('预设: 默认')
    expect(text).not.toContain('标题:')
  })

  it('renders the title projection when one exists', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '拉取数据' } } })]
    await console.handleMessage(10, `/status ${ID_A}`)
    expect(replyTexts(transport)).toContain('标题: 拉取数据')
  })

  it('reports a bound session that vanished from the registry', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A })]
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    port.sessions = []
    await console.handleMessage(10, '/status')
    expect(replyTexts(transport)).toContain('不存在')
  })

  it('rejects out-of-range selectors', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/status 42')
    expect(replyTexts(transport)).toContain('序号 42 超出范围')
  })

  it('leads with the last assistant output when every tool call has its result', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A })]
    port.history.set(ID_A, [
      assistantEvent('第一步结果'),
      toolCallEvent('bash'),
      { type: 'tool/result', seq: 0, time: 0, data: { turn: 1, step: 1, message: {} } } as unknown as SessionEvent,
      assistantEvent('最终答案在这里'),
    ])
    await console.handleMessage(10, `/status ${ID_A}`)
    const text = replyTexts(transport)
    expect(text).toContain('🤖 最终答案在这里')
    expect(text).not.toContain('工具调用中')
  })

  it('reports an unpaired tool call at the history tail as in-progress', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A })]
    port.history.set(ID_A, [assistantEvent('我来看一下'), toolCallEvent('bash')])
    await console.handleMessage(10, `/status ${ID_A}`)
    expect(replyTexts(transport)).toContain('🔧 工具调用中: bash')
  })

  it('reports user/assistant/tool counts and the character estimate from the fetched page', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A })]
    port.history.set(ID_A, [
      userEvent('你好'),
      assistantEvent('你好！'),
      toolCallEvent('bash'),
      { type: 'tool/result', seq: 0, time: 0, data: { turn: 1, step: 1, message: {} } } as unknown as SessionEvent,
      assistantEvent('完成'),
    ])
    await console.handleMessage(10, `/status ${ID_A}`)
    const text = replyTexts(transport)
    expect(text).toContain('消息: 用户 1 · 助手 2 · 工具调用 1')
    // 你好=2 + 你好！=3 + {} args=2 + 完成=2 → 9 code points over 3 messages.
    expect(text).toContain('上下文 ~9 字符（近 3 条消息）')
    expect(text).not.toContain('使用 /attach')
  })

  it('excludes workspace-instruction context from the status statistics', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A })]
    port.history.set(ID_A, [
      userEvent('工作区指令', { kind: 'agent-instructions', form: 'instructions', changes: [] }),
      userEvent('你好'),
      assistantEvent('完成'),
    ])
    await console.handleMessage(10, `/status ${ID_A}`)
    const text = replyTexts(transport)
    // Only the human 你好 counts as a user: users 1; chars = 你好 (2) + 完成 (2).
    expect(text).toContain('消息: 用户 1 · 助手 1 · 工具调用 0')
    expect(text).toContain('上下文 ~4 字符（近 2 条消息）')
    expect(text).not.toContain('工作区指令')
  })

  it('hints at a blank session page', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A })]
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/status ${ID_A}`)
    const text = replyTexts(transport)
    expect(text).toContain('（空白会话，还没有消息）')
    expect(text).toContain('⚪ 空闲')
  })
})

describe('help and unknown commands', () => {
  it('prints help for /start and rejects the removed /help command', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/start')
    expect(replyTexts(transport)).toContain('会话遥控台')
    transport.messages = []
    await console.handleMessage(10, '/help')
    expect(replyTexts(transport)).toContain('未知命令 /help。发送 /start 查看可用命令。')
  })

  it('advertises the attach, model, new, close, and delete commands in help', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/start')
    const text = replyTexts(transport)
    expect(text).toContain('/attach [序号|id|none|arc] — 绑定会话并显示最近 2 轮对话')
    expect(text).toContain('/model [模型名] — 设置全局默认模型（无参数弹出模型键盘选择）')
    expect(text).toContain('/create — 创建会话菜单')
    expect(text).toContain('/operate — 操作会话菜单')
    expect(text).toContain('/new [路径|序号|none] — 创建会话')
    expect(text).toContain('/archive [序号|id] — 归档会话加入归档区')
    expect(text).toContain('/delete [序号|id] — 删除（归档）会话')
    expect(text).toContain('/rename [标题] — 重命名会话：无参数交互输入标题')
    expect(text).toContain('/stop — 停止进行中的回合（作用于当前绑定会话；未绑定会话时点下方按钮选择）')
    expect(text).toContain('/status [序号|id] — 会话详情（无参数作用于当前会话；未绑定会话时点下方按钮选择）')
    expect(text).toContain('/close — 收起快捷键盘（需再次发送 /close 确认；会话绑定不变）')
    expect(text).toContain('/ 命令菜单从 /keyboard 开始（一键唤醒键盘区），接着 /attach（绑定入口），其余只保留键盘上没有的命令：/status、/model、/delete、/rename、/preset、/start。')
    expect(text).toContain('运行 /attach、/status、/stop 等不带键盘的命令后，快捷键盘会回到常用操作行（/create /archive /attach /close）。')
    expect(text).not.toContain('/view')
    expect(text).not.toContain('/open')
    expect(text).not.toContain('/workspaces')
  })

  it('rejects deleted commands as unknown', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/view 1')
    expect(replyTexts(transport)).toContain('未知命令 /view')
    transport.messages = []
    await console.handleMessage(10, '/open 1')
    expect(replyTexts(transport)).toContain('未知命令 /open')
    transport.messages = []
    await console.handleMessage(10, '/workspaces')
    expect(replyTexts(transport)).toContain('未知命令 /workspaces')
  })

  it('rejects unknown commands with a hint', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/nope')
    expect(replyTexts(transport)).toContain('未知命令 /nope')
  })

  it('conveys unexpected failures as ⛔ replies', async () => {
    const { console, port, transport } = setup()
    port.listError = new Error('调研失败')
    await console.handleMessage(10, '/attach none')
    expect(replyTexts(transport)).toContain('⛔ 调研失败')
  })
})

describe('realtime push', () => {
  it('streams a turn on one live message and drops the replying marker on completion', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, userEvent('对方问好', { kind: 'user' }))
    await console.onSessionEvent(ID_A, assistantEvent('回复你'))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    // User messages are never pushed; only the live assistant stream appears.
    expect(transport.messages.map(message => message.text)).toEqual(['🤔 thinking…'])
    // While running, the stream edit carries the replying marker; the completed
    // turn's final edit restores the bare reply — no `✅ done` trailing label —
    // and the next turn opens a fresh placeholder.
    expect(transport.edits).toEqual([
      { chatId: 10, messageId: stream.messageId, text: `${replyClock}\n🤖 回复你\n\n⏳ 回复中…` },
      { chatId: 10, messageId: stream.messageId, text: `${replyClock}\n🤖 回复你` },
    ])
    await console.onSessionEvent(ID_A, turnStart())
    expect(streamMessage(transport).messageId).not.toBe(stream.messageId)
  })

  it('closes an empty completed stream with the bare outcome label', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    // No assistant text was published: the spinner closes with the label so
    // the placeholder never goes stale.
    expect(transport.edits).toEqual([{ chatId: 10, messageId: stream.messageId, text: '✅ done' }])
  })

  it('edits the stream message in place for assistant steps within the budget', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    const first = '好'.repeat(3_000)
    await console.onSessionEvent(ID_A, assistantEvent(first))
    await console.onSessionEvent(ID_A, assistantEvent('，继续'))
    const suffix = '\n\n⏳ 回复中…'
    expect(transport.edits).toEqual([
      { chatId: 10, messageId: stream.messageId, text: `${replyClock}\n🤖 ${first}${suffix}` },
      { chatId: 10, messageId: stream.messageId, text: `${replyClock}\n🤖 ${first}，继续${suffix}` },
    ])
  })

  it('spills assistant text onto a fresh chunked message past the budget', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, turnStart())
    await console.onSessionEvent(ID_A, assistantEvent('长'.repeat(3_500)))
    expect(transport.messages.length).toBeGreaterThan(1)
    expect(transport.messages.every(message => Array.from(message.text).length <= 3_500)).toBe(true)
    const tail = transport.messages.at(-1)
    if (tail === undefined) throw new Error('overflow must send messages')
    await console.onSessionEvent(ID_A, assistantEvent('续'))
    // The tail chunk carries the replying marker; the stored body strips it,
    // so the follow-up edit re-appends the marker after the extended text.
    const bare = tail.text.replace(/\n\n⏳ 回复中…$/, '')
    expect(transport.edits.at(-1)).toEqual({
      chatId: 10,
      messageId: tail.messageId,
      text: `${bare}续\n\n⏳ 回复中…`,
    })
  })

  it('falls back to a fresh message when the stream edit fails', async () => {
    const { console: telegram, port, transport } = setup()
    port.history.set(ID_A, [])
    await telegram.handleMessage(10, `/attach ${ID_A}`)
    await telegram.onSessionEvent(ID_A, turnStart())
    await telegram.onSessionEvent(ID_A, assistantEvent('正文'))
    const warn = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => {})
    try {
      transport.editError = new Error('消息太旧不能编辑')
      await telegram.onSessionEvent(ID_A, assistantEvent('，续写'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stream edit failed'))
      const tail = transport.messages.at(-1)
      if (tail === undefined) throw new Error('fallback must send a message')
      // The fallback chunk still shows the replying marker (the turn is open).
      expect(tail.text).toBe(`${replyClock}\n🤖 正文，续写\n\n⏳ 回复中…`)
      // The failure is transient: the re-armed stream edits the fallback message.
      transport.editError = undefined
      await telegram.onSessionEvent(ID_A, assistantEvent('，再续'))
      expect(transport.edits.at(-1)).toEqual({ chatId: 10, messageId: tail.messageId, text: `${replyClock}\n🤖 正文，续写，再续\n\n⏳ 回复中…` })
    } finally {
      warn.mockRestore()
    }
  })

  it('sends the turn label as a plain message when no stream is open', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'aborted' }))
    expect(replyTexts(transport)).toContain('⏹ stopped')
  })

  it('rethrows a turn-label send failure when no stream is open', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.sendError = new Error('发送失败')
    await expect(console.onSessionEvent(ID_A, turnEnd({ kind: 'aborted' }))).rejects.toThrow('发送失败')
  })

  it('labels an error turn with a blank reason as the plain outcome', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, turnEndError('   '))
    expect(transport.edits).toEqual([{ chatId: 10, messageId: stream.messageId, text: '❌ failed' }])
  })

  it('finalizes an empty stream with the bare outcome label, no leading newline', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'error' }))
    expect(transport.edits).toEqual([{ chatId: 10, messageId: stream.messageId, text: '❌ failed' }])
  })

  it('appends the outcome label under a streamed reply for non-completed turns', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, assistantEvent('正文'))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'aborted' }))
    expect(transport.edits.at(-1)).toEqual({
      chatId: 10,
      messageId: stream.messageId,
      text: `${replyClock}\n🤖 正文\n⏹ stopped`,
    })
  })

  it('appends the token-usage footer to a completed reply through an HTML edit', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, assistantEvent('好了', {
      inputTokens: 4_000, outputTokens: 300, cacheReadTokens: 6_000,
    }))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    // A completed reply keeps its text alone; only the HTML footer is added.
    expect(transport.htmlEdits).toEqual([{
      chatId: 10,
      messageId: stream.messageId,
      html: `${replyClock}\n🤖 好了\n\n<pre>⚡ 本轮: ↑4k ↓300 · 缓存命中 60%</pre>`,
    }])
  })

  it('appends a collapsible per-action blockquote to the live reply', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    await console.onSessionEvent(ID_A, assistantToolEvent('让我读文件', [{ name: 'read_file', arguments: '{"path":"/x"}' }, { name: 'bash' }], { inputTokens: 10, outputTokens: 20 }))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    const html = transport.htmlEdits.at(-1)?.html ?? ''
    expect(html).toContain('🤖 让我读文件')
    expect(html).toContain(`<blockquote expandable>${replyClock}🔧 read_file — /x\n${replyClock}🔧 bash — {}</blockquote>`)
    expect(html).toContain('<pre>⚡ 本轮: ↑10 ↓20</pre>')
  })

  it('renders each action on its own line across steps, without a usage footer', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    await console.onSessionEvent(ID_A, assistantToolEvent('先读', [{ name: 'read_file', arguments: '{"path":"/a"}' }]))
    await console.onSessionEvent(ID_A, assistantToolEvent('再写', [{ name: 'write', arguments: '{"path":"/b"}' }]))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    const html = transport.htmlEdits.at(-1)?.html ?? ''
    expect(html).toContain(`<blockquote expandable>${replyClock}🔧 read_file — /a\n${replyClock}🔧 write — /b</blockquote>`)
    expect(html).not.toContain('<pre>')
  })

  it('shows a reasoning pass as a Think action line in the live blockquote', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    await console.onSessionEvent(ID_A, assistantReasonEvent('先想清楚，再调用工具。'))
    await console.onSessionEvent(ID_A, assistantToolEvent('动手', [{ name: 'bash' }]))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    const html = transport.htmlEdits.at(-1)?.html ?? ''
    expect(html).toContain(`<blockquote expandable>${replyClock}💭 Think — 先想清楚，再调用工具。\n${replyClock}🔧 bash — {}</blockquote>`)
  })

  it('does not carry tool calls into the next turn', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    await console.onSessionEvent(ID_A, assistantToolEvent('带工具', [{ name: 'bash' }]))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    await console.onSessionEvent(ID_A, turnStart())
    await console.onSessionEvent(ID_A, assistantEvent('无工具', { inputTokens: 1, outputTokens: 1 }))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    const html = transport.htmlEdits.at(-1)?.html ?? ''
    expect(html).toContain('🤖 无工具')
    expect(html).not.toContain('<blockquote')
  })

  it('escapes assistant text in the HTML footer edit', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, assistantEvent('<b>强调</b> & 注释', { inputTokens: 100, outputTokens: 50 }))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    expect(transport.htmlEdits.at(-1)).toEqual({
      chatId: 10,
      messageId: stream.messageId,
      html: `${replyClock}\n🤖 &lt;b&gt;强调&lt;/b&gt; &amp; 注释\n\n<pre>⚡ 本轮: ↑100 ↓50</pre>`,
    })
  })

  it('accumulates usage across the turn\'s steps', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    await console.onSessionEvent(ID_A, assistantEvent('甲', { inputTokens: 1_000, outputTokens: 100 }))
    await console.onSessionEvent(ID_A, assistantEvent('乙', {
      inputTokens: 500, outputTokens: 200, cacheWriteTokens: 2_500,
    }))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    expect(transport.htmlEdits.at(-1)?.html).toContain('⚡ 本轮: ↑1.5k ↓300 · 缓存写 2.5k')
  })

  it('appends the footer under the outcome label of a non-completed turn', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, assistantEvent('正文', { inputTokens: 800, outputTokens: 0 }))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'aborted' }))
    expect(transport.htmlEdits.at(-1)).toEqual({
      chatId: 10,
      messageId: stream.messageId,
      html: `${replyClock}\n🤖 正文\n⏹ stopped\n\n<pre>⚡ 本轮: ↑800 ↓0</pre>`,
    })
  })

  it('footers an empty completed stream with the bare outcome label', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, assistantEvent('', { inputTokens: 200, outputTokens: 10 }))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    expect(transport.htmlEdits.at(-1)).toEqual({
      chatId: 10,
      messageId: stream.messageId,
      html: '✅ done\n\n<pre>⚡ 本轮: ↑200 ↓10</pre>',
    })
  })

  it('sends the footer as a fresh HTML message when no stream is open', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    // No turn/start: the chat attached mid-turn and only a usage-bearing
    // text-free step arrived, so no live message exists to finalize.
    await console.onSessionEvent(ID_A, assistantEvent('', { inputTokens: 300, outputTokens: 40 }))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'aborted' }))
    expect(transport.messages).toEqual([])
    const footer = transport.htmlMessages.at(-1)
    if (footer === undefined) throw new Error('the footer must be sent as an HTML message')
    expect(footer.chatId).toBe(10)
    expect(footer.html).toBe('⏹ stopped\n\n<pre>⚡ 本轮: ↑300 ↓40</pre>')
    expect(typeof footer.messageId).toBe('number')
  })

  it('falls back to a fresh HTML send when the footer edit fails', async () => {
    const { console: telegram, port, transport } = setup()
    port.history.set(ID_A, [])
    await telegram.handleMessage(10, `/attach ${ID_A}`)
    await telegram.onSessionEvent(ID_A, turnStart())
    transport.htmlEditError = new Error('消息太旧不能编辑')
    const warn = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => {})
    try {
      await telegram.onSessionEvent(ID_A, assistantEvent('正文', { inputTokens: 100, outputTokens: 1 }))
      await telegram.onSessionEvent(ID_A, turnEnd({ kind: 'aborted' }))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn footer edit failed'))
      expect(transport.htmlMessages.at(-1)?.html).toBe(
        `${replyClock}\n🤖 正文\n⏹ stopped\n\n<pre>⚡ 本轮: ↑100 ↓1</pre>`,
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('rethrows an HTML send failure when no stream is open', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, assistantEvent('', { inputTokens: 30, outputTokens: 3 }))
    transport.htmlSendError = new Error('发送失败')
    await expect(console.onSessionEvent(ID_A, turnEnd({ kind: 'aborted' }))).rejects.toThrow('发送失败')
  })

  it('resets the usage accounting at the next turn\'s start', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    await console.onSessionEvent(ID_A, assistantEvent('一轮', { inputTokens: 900, outputTokens: 90 }))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    expect(transport.htmlEdits.at(-1)?.html).toContain('⚡ 本轮: ↑900 ↓90')
    // The next turn carries no usage: its end goes back to the plain edit.
    await console.onSessionEvent(ID_A, turnStart())
    const next = streamMessage(transport)
    await console.onSessionEvent(ID_A, assistantEvent('二轮'))
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    expect(transport.edits.at(-1)).toEqual({ chatId: 10, messageId: next.messageId, text: `${replyClock}\n🤖 二轮` })
  })

  it('falls back to a fresh label message when the turn/end edit fails', async () => {
    const { console: telegram, port, transport } = setup()
    port.history.set(ID_A, [])
    await telegram.handleMessage(10, `/attach ${ID_A}`)
    await telegram.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    transport.messages = []
    transport.editError = new Error('消息太旧不能编辑')
    const warn = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => {})
    try {
      await telegram.onSessionEvent(ID_A, turnEnd({ kind: 'aborted' }))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn label edit failed'))
      expect(transport.messages.map(message => message.text)).toEqual(['⏹ stopped'])
      // The stream state is cleared despite the failed edit: the next turn
      // opens a fresh placeholder instead of editing the dead message.
      await telegram.onSessionEvent(ID_A, turnStart())
      expect(streamMessage(transport).messageId).not.toBe(stream.messageId)
    } finally {
      warn.mockRestore()
    }
  })

  it('carries the structured failure reason on an error turn label', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    await console.onSessionEvent(ID_A, turnEndError('tool call timed out after 30000ms'))
    expect(transport.edits).toEqual([{
      chatId: 10,
      messageId: stream.messageId,
      text: '❌ failed\ntool call timed out after 30000ms',
    }])
  })

  it('truncates an over-long failure reason to the label cap', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    const long = '错'.repeat(TURN_ERROR_REASON_MAX + 300)
    await console.onSessionEvent(ID_A, turnEndError(long))
    expect(transport.edits).toEqual([{
      chatId: 10,
      messageId: stream.messageId,
      text: `❌ failed\n${'错'.repeat(TURN_ERROR_REASON_MAX)}…`,
    }])
  })


  it('never pushes user messages, whatever their source or text', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, userEvent('我自己发的', { kind: 'user', rpcId: RpcId('rpc-1') }))
    await console.onSessionEvent(ID_A, userEvent('工作区指令', { kind: 'agent-instructions', form: 'instructions', changes: [] }))
    await console.onSessionEvent(ID_A, userEvent(''))
    expect(transport.messages).toEqual([])
  })

  it('skips text-free assistant steps and unrelated sessions', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, {
      type: 'assistant/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { content: [] } },
    } as unknown as SessionEvent)
    await console.onSessionEvent(ID_B, userEvent('别的会话'))
    expect(transport.messages).toEqual([])
  })

  it('turns the typing pump on only for chats with an open turn', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(11, `/attach ${ID_A}`)
    expect(transport.actions).toEqual([])
    await console.onSessionEvent(ID_A, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
    await console.pumpTyping()
    expect(transport.actions).toEqual([
      { chatId: 10, action: 'typing' },
      { chatId: 11, action: 'typing' },
    ])
    await console.onSessionEvent(ID_A, { type: 'turn/end', seq: 0, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    transport.actions = []
    await console.pumpTyping()
    expect(transport.actions).toEqual([])
  })

  it('clears the typing pump before turn/end ask edits, so a failed edit cannot stick it', async () => {
    const { console, port, transport } = setup()
    const questions = [{ id: 'q1', question: '这次改哪个模块？', options: [{ label: 'core' }, { label: 'api' }, { label: 'web' }] }]
    const rpcId = '11111111-2222-4333-8444-555555555555'
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, turnStart())
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    const ask = transport.inlineKeyboards.at(-1)
    if (ask === undefined) throw new Error('ask must send an inline keyboard')
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    await console.onSessionEvent(ID_A, decidedEvent(rpcId, 'answered'))
    // The ask-keyboard edit at the turn boundary now fails: the typing pump
    // must already be off, so a network hiccup can never leave "typing" up on
    // an ended turn.
    transport.editError = new Error('网络错误')
    await expect(console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))).rejects.toThrow('网络错误')
    transport.actions = []
    await console.pumpTyping()
    expect(transport.actions).toEqual([])
  })

  it('chunks long pushes', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    const long = '长'.repeat(4_000)
    await console.onSessionEvent(ID_A, {
      type: 'assistant/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: long }] } },
    } as unknown as SessionEvent)
    expect(transport.messages.length).toBeGreaterThan(1)
    expect(transport.messages.every(message => Array.from(message.text).length <= 3_501)).toBe(true)
  })

  it('ignores other event types', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, { type: 'todo/write', seq: 0, time: 0, data: { todos: [] } })
    await console.onSessionEvent(ID_A, { type: 'request/header', seq: 0, time: 0, data: {} } as unknown as SessionEvent)
    expect(transport.messages).toEqual([])
  })

  it('serializes per-chat pushes so turn/end never races the assistant edit', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, turnStart())
    const stream = streamMessage(transport)
    // Every edit settles one macrotask late: without per-chat serialization the
    // immediately-following turn/end would read the pre-edit empty stream and
    // stamp the completed reply with a stale done label. The chain keeps the
    // events in order: the running edit carries the replying marker and the
    // turn/end edit drops it, leaving only the assistant text.
    const originalEdit = transport.editMessage.bind(transport)
    transport.editMessage = async (chatId, messageId, text) => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      await originalEdit(chatId, messageId, text)
    }
    const assistant = console.onSessionEvent(ID_A, assistantEvent('回复你'))
    const ended = console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    await Promise.all([assistant, ended])
    expect(transport.edits).toEqual([
      { chatId: 10, messageId: stream.messageId, text: `${replyClock}\n🤖 回复你\n\n⏳ 回复中…` },
      { chatId: 10, messageId: stream.messageId, text: `${replyClock}\n🤖 回复你` },
    ])
  })
})

describe('realtime questions', () => {
  const questions = [
    { id: 'q1', question: '这次改哪个模块？', options: [{ label: 'core' }, { label: 'api' }, { label: 'web' }] },
  ]
  const rpcId = '11111111-2222-4333-8444-555555555555'

  function boundConsole(over: { port?: Partial<FakePort> } = {}): { console: TelegramConsole; port: FakePort; transport: FakeTransport } {
    const value = setup(over)
    value.port.history.set(ID_A, [])
    return value
  }

  it('renders an ask with option and action buttons; 回答中 on decided, 已回答 on turn end', async () => {
    const { console, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    const ask = transport.inlineKeyboards.at(-1)
    expect(ask?.text).toContain('这次改哪个模块？')
    if (ask === undefined) throw new Error('ask must send an inline keyboard')
    expect(ask.rows).toEqual([
      [{ text: 'core', data: questionOptionData(rpcId, 0, 0) }],
      [{ text: 'api', data: questionOptionData(rpcId, 0, 1) }],
      [{ text: 'web', data: questionOptionData(rpcId, 0, 2) }],
      [{ text: '✍️ 自定义回答', data: questionCustomData(rpcId, 0) }],
      [{ text: '✅ 提交回答', data: questionSubmitData(rpcId) }],
      [{ text: '🚫 取消', data: questionCancelData(rpcId) }],
    ])
    await console.onSessionEvent(ID_A, decidedEvent(rpcId, 'answered'))
    // The ask is answered but the agent's turn keeps running: the keyboard
    // shows the in-progress label until turn/end finalizes it.
    expect(transport.inlineKeyboardEdits.at(-1)).toEqual({
      chatId: 10, messageId: ask.messageId, text: '⏳ 回答中…', rows: [],
    })
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    expect(transport.inlineKeyboardEdits.at(-1)).toEqual({
      chatId: 10, messageId: ask.messageId, text: '✅ 已回答。', rows: [],
    })
  })

  it('auto-answers a single-select one-question ask on the tapped option', async () => {
    const { console, port, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    const ask = transport.inlineKeyboards.at(-1)
    if (ask === undefined) throw new Error('ask must send an inline keyboard')
    await console.handleCallback(10, questionOptionData(rpcId, 0, 1))
    expect(port.answerCalls).toEqual([{
      rpcId,
      sessionId: ID_A,
      answer: { answers: [{ id: 'q1', selected: ['api'] }] },
    }])
    // The tap answered directly: no reply text and no keyboard re-render.
    expect(transport.messages).toEqual([])
    expect(transport.inlineKeyboardEdits).toEqual([])
  })

  it('collects a multi-select batch until submit', async () => {
    const { console, port, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    const multi = [{
      id: 'q2', question: '要哪些能力？', multiSelect: true,
      options: [{ label: '检索' }, { label: '代码' }, { label: '网页' }],
    }]
    await console.onSessionEvent(ID_A, askedEvent(rpcId, multi))
    const ask = transport.inlineKeyboards.at(-1)
    if (ask === undefined) throw new Error('ask must send an inline keyboard')
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    await console.handleCallback(10, questionOptionData(rpcId, 0, 1))
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    expect(transport.inlineKeyboardEdits.at(-1)?.rows[0]).toEqual([
      { text: '检索', data: questionOptionData(rpcId, 0, 0) },
    ])
    await console.handleCallback(10, questionSubmitData(rpcId))
    expect(port.answerCalls).toEqual([{
      rpcId,
      sessionId: ID_A,
      answer: { answers: [{ id: 'q2', selected: ['代码'] }] },
    }])
  })

  it('answers a multi-question batch with per-question picks', async () => {
    const { console, port, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    const two = [
      { id: 'q1', question: '改哪个模块？', options: [{ label: 'core' }] },
      { id: 'q2', question: '改哪里？', options: [{ label: 'src' }, { label: 'tests' }] },
    ]
    await console.onSessionEvent(ID_A, askedEvent(rpcId, two))
    const ask = transport.inlineKeyboards.at(-1)
    if (ask === undefined) throw new Error('ask must send an inline keyboard')
    expect(ask.text).toContain('【1】')
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    await console.handleCallback(10, questionOptionData(rpcId, 1, 1))
    await console.handleCallback(10, questionSubmitData(rpcId))
    expect(port.answerCalls).toEqual([{
      rpcId,
      sessionId: ID_A,
      answer: { answers: [{ id: 'q1', selected: ['core'] }, { id: 'q2', selected: ['tests'] }] },
    }])
  })

  it('arms a custom answer and consumes the next free text', async () => {
    const { console, port, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    await console.handleCallback(10, questionCustomData(rpcId, 0))
    expect(transport.messages.at(-1)?.text).toContain('请直接输入')
    await console.handleMessage(10, '性能问题')
    // The free text became the custom answer, not a prompt.
    expect(port.promptCalls).toEqual([])
    await console.handleCallback(10, questionSubmitData(rpcId))
    expect(port.answerCalls).toEqual([{
      rpcId,
      sessionId: ID_A,
      answer: { answers: [{ id: 'q1', selected: [], custom: '性能问题' }] },
    }])
  })

  it('rejects an incomplete batch with a hint and does not answer', async () => {
    const { console, port, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    const two = [
      { id: 'q1', question: '改哪个模块？', options: [{ label: 'core' }] },
      { id: 'q2', question: '改哪里？', options: [{ label: 'src' }] },
    ]
    await console.onSessionEvent(ID_A, askedEvent(rpcId, two))
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    await console.handleCallback(10, questionSubmitData(rpcId))
    expect(port.answerCalls).toEqual([])
    expect(transport.messages.at(-1)?.text).toContain('还有问题')
  })

  it('cancels through the port and clears the arm', async () => {
    const { console, port, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    await console.handleCallback(10, questionCancelData(rpcId))
    expect(port.cancelCalls).toEqual([rpcId])
    await console.onSessionEvent(ID_A, decidedEvent(rpcId, 'cancelled'))
    const settled = transport.inlineKeyboardEdits.at(-1)
    expect(settled?.chatId).toBe(10)
    expect(settled?.text).toBe('🚫 已取消。')
    expect(settled?.rows).toEqual([])
  })

  it('reports unknown and stale callbacks', async () => {
    const { console, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    await console.handleCallback(10, 'foreign:data')
    expect(transport.messages.at(-1)?.text).toContain('未知按钮')
    await console.handleCallback(10, questionOptionData(rpcId, 0, 9))
    expect(transport.messages.at(-1)?.text).toContain('已失效')
    await console.handleCallback(10, questionOptionData('other-rpc', 0, 0))
    expect(transport.messages.at(-1)?.text).toContain('已失效')
  })

  it('answered elsewhere: the decided event shows 回答中, finalizes on turn end, and later taps go stale', async () => {
    const { console, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    await console.onSessionEvent(ID_A, decidedEvent(rpcId, 'answered'))
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    expect(transport.messages.at(-1)?.text).toContain('已失效')
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    expect(transport.inlineKeyboardEdits.at(-1)?.text).toBe('✅ 已回答。')
  })

  it('leaves an unanswered ask pending when the turn dies without a decision', async () => {
    const { console, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    transport.messages = []
    // The agent's turn aborts before the host decides the ask: the ask is
    // neither cancelled nor answered, so turn/end must skip it in place.
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'aborted' }))
    expect(transport.messages.map(message => message.text)).toEqual(['⏹ stopped'])
    expect(transport.inlineKeyboardEdits).toEqual([])
    // The ask stays tappable: answering it still goes through.
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    expect(transport.messages.at(-1)?.text).not.toContain('已失效')
  })

  it('drops pending asks when the binding changes or splits chats', async () => {
    const { console, port, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    expect(transport.inlineKeyboards).toHaveLength(1)
    // A second chat bound to the same session gets its own live render, and
    // a new ask renders on every bound chat.
    await console.handleMessage(11, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent('22222222-3333-4444-8555-666666666666', questions))
    expect(transport.inlineKeyboards.filter(keyboard => keyboard.chatId === 10)).toHaveLength(2)
    expect(transport.inlineKeyboards.filter(keyboard => keyboard.chatId === 11)).toHaveLength(1)
    // Rebinding chat 10 to another session clears its pending asks.
    await console.handleMessage(10, `/attach ${ID_B}`)
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    expect(transport.messages.at(-1)?.text).toContain('已失效')
    expect(port.answerCalls).toEqual([])
  })

  it('reports out-of-range option taps and ignores out-of-range custom taps', async () => {
    const { console, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    await console.handleCallback(10, questionOptionData(rpcId, 9, 9))
    expect(transport.messages.at(-1)?.text).toContain('该提问已失效')
    const before = transport.messages.length
    await console.handleCallback(10, questionCustomData(rpcId, 9))
    expect(transport.messages.length).toBe(before)
  })

  it('keeps collected multi-select options when arming a custom answer', async () => {
    const { console, port } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    const multi = [{
      id: 'q2', question: '要哪些能力？', multiSelect: true,
      options: [{ label: '检索' }, { label: '代码' }],
    }]
    await console.onSessionEvent(ID_A, askedEvent(rpcId, multi))
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    await console.handleCallback(10, questionCustomData(rpcId, 0))
    await console.handleMessage(10, '还要文档')
    await console.handleCallback(10, questionSubmitData(rpcId))
    expect(port.answerCalls).toEqual([{
      rpcId,
      sessionId: ID_A,
      answer: { answers: [{ id: 'q2', selected: ['检索'], custom: '还要文档' }] },
    }])
  })

  it('cancels the custom-answer arm on blank text and via the cancel button', async () => {
    const { console, port, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    await console.handleCallback(10, questionCustomData(rpcId, 0))
    await console.handleMessage(10, '   ')
    expect(transport.messages.at(-1)?.text).toContain('已取消自定义回答')
    // The arm cleared: the next free text is a prompt again.
    await console.handleMessage(10, '再发一句')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '再发一句' }])
    // Arming again, then cancelling the ask, clears the arm too.
    await console.handleCallback(10, questionCustomData(rpcId, 0))
    await console.handleCallback(10, questionCancelData(rpcId))
    expect(port.cancelCalls).toEqual([rpcId])
  })

  it('clears the custom-answer arm when the ask settles elsewhere', async () => {
    const { console, port, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    await console.handleCallback(10, questionCustomData(rpcId, 0))
    await console.onSessionEvent(ID_A, decidedEvent(rpcId, 'answered'))
    await console.handleMessage(10, '晚了')
    // The decided event cleared the arm with the pending entry: the late text
    // forwards as a prompt instead of being consumed as an answer.
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '晚了' }])
    const settled = transport.inlineKeyboardEdits.at(-1)
    expect(settled?.chatId).toBe(10)
    expect(settled?.text).toBe('⏳ 回答中…')
    expect(settled?.rows).toEqual([])
    await console.onSessionEvent(ID_A, turnEnd({ kind: 'completed' }))
    expect(transport.inlineKeyboardEdits.at(-1)?.text).toBe('✅ 已回答。')
  })

  it('reports port refusals of a question settlement as errors', async () => {
    const { console, transport } = boundConsole({
      port: { answerError: new Error('提问已失效（not-pending）') },
    })
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    expect(transport.messages.at(-1)?.text).toContain('提问已失效')
  })

  it('renders non-Error question settlement refusals verbatim', async () => {
    const { console, transport } = boundConsole({
      port: { answerError: 'raw refusal' } as never,
    })
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.onSessionEvent(ID_A, askedEvent(rpcId, questions))
    await console.handleCallback(10, questionOptionData(rpcId, 0, 0))
    expect(transport.messages.at(-1)?.text).toContain('raw refusal')
  })

  it('ignores a decided event with no matching pending ask', async () => {
    const { console, transport } = boundConsole()
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.inlineKeyboardEdits = []
    await console.onSessionEvent(ID_A, decidedEvent(rpcId, 'cancelled'))
    expect(transport.inlineKeyboardEdits).toEqual([])
  })
})

describe('/model', () => {
  it('shows the configured model list as a reply keyboard without any open session', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture()
    await console.handleMessage(10, '/model')
    expect(transport.messages).toEqual([])
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.text).toContain('🎛 设置全局默认模型')
    expect(keyboard?.rows).toEqual([
      ['/model deepseek/deepseek-chat'],
      ['/model deepseek/deepseek-reasoner'],
      ['/model glm/glm-4'],
    ])
  })

  it('applies a tapped model to the global default, confirms, and dismisses the keyboard', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture()
    await console.handleMessage(10, '/model')
    await console.handleMessage(10, '/model deepseek/deepseek-reasoner')
    expect(port.setDefaultCalls).toEqual([{ provider: 'deepseek', model: 'deepseek-reasoner' }])
    expect(transport.removeKeyboardCalls).toEqual([{ chatId: 10, text: '✅ 已设置全局默认模型 DeepSeek/DeepSeek Reasoner' }])
  })

  it('resolves an exact provider/model route rather than a shared prefix', async () => {
    const { console, port } = setup()
    port.catalog = catalogFixture({
      groups: [
        { id: 'glm', name: 'GLM', models: [{ id: 'glm-4', name: 'GLM-4' }, { id: 'glm-4-turbo', name: 'GLM-4 Turbo' }] },
      ],
    })
    await console.handleMessage(10, '/model glm/glm-4')
    expect(port.setDefaultCalls).toEqual([{ provider: 'glm', model: 'glm-4' }])
  })

  it('still selects by id or display-name prefix, case-insensitively', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture()
    await console.handleMessage(10, '/model deepseek chat')
    expect(port.setDefaultCalls).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
    transport.removeKeyboardCalls = []
    await console.handleMessage(10, '/model GLM')
    expect(port.setDefaultCalls).toEqual([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'glm', model: 'glm-4' },
    ])
  })

  it('caps the model keyboard and notes the omitted count', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture({
      groups: [
        { id: 'p', name: 'P', models: Array.from({ length: 25 }, (_, index) => ({ id: `m-${index + 1}`, name: `M ${index + 1}` })) },
      ],
    })
    await console.handleMessage(10, '/model')
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.rows).toHaveLength(MODEL_KEYBOARD_LIMIT)
    expect(keyboard?.text).toContain('还有 5 个模型未显示。')
  })

  it('keeps failure summaries whole in the keyboard text', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture({ failures: [{ id: 'down', name: 'Down', message: '上游超时' }] })
    await console.handleMessage(10, '/model')
    expect(transport.replyKeyboards.at(-1)?.text).toContain('Down（上游超时）')
  })

  it('reports a catalog with no models', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture({ groups: [] })
    await console.handleMessage(10, '/model')
    expect(transport.replyKeyboards).toHaveLength(0)
    expect(replyTexts(transport)).toContain('暂无可用模型。')
  })

  it('reports unmatched names', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture()
    await console.handleMessage(10, '/model nope')
    expect(port.setDefaultCalls).toEqual([])
    expect(replyTexts(transport)).toContain('没有找到模型 nope')
  })

  it('reports a route whose provider carries no such model', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture()
    await console.handleMessage(10, '/model deepseek/glm-4')
    expect(port.setDefaultCalls).toEqual([])
    expect(replyTexts(transport)).toContain('没有找到模型 deepseek/glm-4')
  })

  it('conveys catalog and set failures', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture()
    port.catalogError = new Error('目录加载失败（catalog-down）')
    await console.handleMessage(10, '/model')
    expect(replyTexts(transport)).toContain('⛔ 目录加载失败（catalog-down）')
    port.catalogError = undefined
    port.setDefaultError = new Error('写入失败（settings-rejected）')
    await console.handleMessage(10, '/model deepseek-chat')
    expect(replyTexts(transport)).toContain('⛔ 写入失败（settings-rejected）')
  })

  it('renders non-Error set failures verbatim', async () => {
    const { console, port, transport } = setup()
    port.catalog = catalogFixture()
    port.setDefaultError = '拒绝写入' as unknown as Error
    await console.handleMessage(10, '/model deepseek-chat')
    expect(replyTexts(transport)).toContain('⛔ 拒绝写入')
  })
})

describe('/create', () => {
  it('opens a sub-menu keyboard with /new and /fork buttons', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/create')
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.text).toContain('创建会话')
    expect(keyboard?.rows).toEqual([['/new', '/fork']])
  })

  it('routes the /new button into the workspace picker', async () => {
    const { console, port, transport } = setup()
    port.workspaces = [workspace()]
    await console.handleMessage(10, '/create')
    await console.handleMessage(10, '/new')
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/new 1 · 项目A'],
      ['/new none · 未分类'],
    ])
  })

  it('routes the /fork button into the fork flow', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/create')
    await console.handleMessage(10, '/fork')
    expect(replyTexts(transport)).toContain('没有打开的会话。带参数使用 /fork <序号|id> 指定会话。')
  })
})

describe('/operate', () => {
  it('opens a sub-menu keyboard with /archive, /stop, and /curTasks buttons', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/operate')
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.text).toContain('操作会话')
    expect(keyboard?.rows).toEqual([['/archive'], ['/stop'], ['/curTasks']])
  })

  it('routes the /archive button into the archive flow', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/operate')
    await console.handleMessage(10, '/archive')
    expect(replyTexts(transport)).toContain('没有打开的会话。带参数使用 /archive <序号|id> 指定会话。')
  })

  it('routes the /curTasks button into the todo list flow', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/operate')
    await console.handleMessage(10, '/curTasks')
    expect(replyTexts(transport)).toContain('还没有绑定会话')
  })
})

describe('/new', () => {
  it('opens the workspace keyboard without arguments, creates ungrouped on none, and clears stale selectors', async () => {
    const { console, port, transport } = setup()
    port.workspaces = [workspace()]
    await console.handleMessage(10, '/new')
    expect(port.createCalls).toEqual([])
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.text).toContain('在哪个工作区创建会话')
    expect(keyboard?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/new 1 · 项目A'],
      ['/new none · 未分类'],
    ])
    await console.handleMessage(10, '/new none')
    expect(port.createCalls).toEqual([{}])
    expect(replyTexts(transport)).toContain('🔗 已创建新会话 cccccccc-cccc-4ccc-8ccc-cccccccccccc（cccccccc…cc）')
    expect(replyTexts(transport)).toContain('未分类')
    await console.handleMessage(10, '/attach 1')
    expect(replyTexts(transport)).toContain('序号 1 超出范围')
    transport.messages = []
    await console.handleMessage(10, '你好')
    expect(port.promptCalls).toEqual([{ sessionId: ID_C, mode: 'queue', text: '你好' }])
  })

  it('reports an empty workspace registry on a bare /new', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/new')
    expect(replyTexts(transport)).toContain('还没有工作区')
  })

  it('creates inside a workspace picked by keyboard index', async () => {
    const { console, port, transport } = setup()
    port.workspaces = [workspace(), workspace({ workspaceId: 'ws-2' as WorkspaceView['workspaceId'], path: '/srv/b', title: '项目B' })]
    await console.handleMessage(10, '/new')
    transport.messages = []
    await console.handleMessage(10, '/new 2 · 项目B')
    expect(port.createCalls).toEqual([{ workspaceId: 'ws-2' }])
    expect(replyTexts(transport)).toContain('工作区「项目B」')
  })

  it('registers a server directory as a workspace and creates inside it', async () => {
    const { console, port, transport } = setup()
    await console.handleMessage(10, '/new /srv/fresh')
    expect(port.createWorkspaceCalls).toEqual(['/srv/fresh'])
    expect(port.createCalls).toEqual([{ workspaceId: 'ws-1' }])
    expect(replyTexts(transport)).toContain('工作区「fresh」')
    // 已存在的路径幂等复用，不再重复注册
    await console.handleMessage(10, '/new /srv/fresh')
    expect(port.createWorkspaceCalls).toEqual(['/srv/fresh', '/srv/fresh'])
    expect(port.createCalls.length).toBe(2)
  })

  it('clears the workspace index cache after a successful create', async () => {
    const { console, port, transport } = setup()
    port.workspaces = [workspace()]
    await console.handleMessage(10, '/new')
    await console.handleMessage(10, '/new 1')
    expect(port.createCalls).toEqual([{ workspaceId: 'ws-1' }])
    transport.messages = []
    await console.handleMessage(10, '/new 1')
    expect(replyTexts(transport)).toContain('工作区序号 1 超出范围')
  })

  it('conveys create refusals', async () => {
    const { console, port, transport } = setup()
    port.createError = new Error('创建失败（agent-busy）')
    await console.handleMessage(10, '/new none')
    expect(replyTexts(transport)).toContain('⛔ 创建失败（agent-busy）')
  })

  it('conveys workspace-path refusals', async () => {
    const { console, port, transport } = setup()
    port.createWorkspaceError = new Error('cannot create a workspace at "/nope"')
    await console.handleMessage(10, '/new /nope')
    expect(replyTexts(transport)).toContain('⛔ cannot create a workspace at "/nope"')
    expect(port.createCalls).toEqual([])
  })

  it('renders non-Error create failures verbatim', async () => {
    const { console, port, transport } = setup()
    port.createError = '创建被拒' as unknown as Error
    await console.handleMessage(10, '/new none')
    expect(replyTexts(transport)).toContain('⛔ 创建被拒')
  })
})

describe('/delete', () => {
  it('opens the session keyboard without arguments', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '会话甲' } } })]
    await console.handleMessage(10, '/delete')
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.text).toContain('点下方按钮删除对应会话')
    expect(keyboard?.rows?.[2]).toEqual(['/delete 1 · ✅ 会话甲'])
    await console.handleMessage(10, '/delete 1 · ✅ 会话甲')
    expect(port.archiveCalls).toEqual([ID_A])
    expect(replyTexts(transport)).toContain('🗑 已删除会话 aaaaaaaa…aa')
  })

  it('archives by id and unbinds when the target is the bound session', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, `/delete ${ID_A}`)
    expect(port.archiveCalls).toEqual([ID_A])
    transport.messages = []
    await console.handleMessage(10, '你好')
    expect(port.promptCalls).toEqual([])
    expect(replyTexts(transport)).toContain('还没有绑定会话')
  })

  it('keeps the binding when an unrelated session is deleted', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.sessions = [summary({ sessionId: ID_A }), summary({ sessionId: ID_B })]
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/attach none')
    await console.handleMessage(10, '/delete 2')
    expect(port.archiveCalls).toEqual([ID_B])
    transport.messages = []
    await console.handleMessage(10, '你好')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '你好' }])
  })

  it('conveys archive refusals', async () => {
    const { console, port, transport } = setup()
    port.archiveError = new Error('拒绝删除（session-not-found）')
    await console.handleMessage(10, `/delete ${ID_A}`)
    expect(replyTexts(transport)).toContain('⛔ 拒绝删除（session-not-found）')
  })

  it('rejects out-of-range selectors', async () => {
    const { console, port, transport } = setup()
    await console.handleMessage(10, '/delete 42')
    expect(port.archiveCalls).toEqual([])
    expect(replyTexts(transport)).toContain('序号 42 超出范围')
  })

  it('renders non-Error archive failures verbatim', async () => {
    const { console, port, transport } = setup()
    port.archiveError = '拒绝删除' as unknown as Error
    await console.handleMessage(10, `/delete ${ID_A}`)
    expect(replyTexts(transport)).toContain('⛔ 拒绝删除')
  })

  it('refreshes the visible session list in place after a delete shrinks it', async () => {
    const { console, port, transport } = setup()
    port.sessions = [
      summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '会话甲' } } }),
      summary({ sessionId: ID_B, projections: { asOfSeq: 0, values: { title: '会话乙' } } }),
    ]
    await console.handleMessage(10, '/delete')
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/delete 1 · ✅ 会话甲'],
      ['/delete 2 · ✅ 会话乙'],
    ])
    port.sessions = [summary({ sessionId: ID_B, projections: { asOfSeq: 0, values: { title: '会话乙' } } })]
    await console.handleMessage(10, '/delete 1')
    expect(port.archiveCalls).toEqual([ID_A])
    expect(replyTexts(transport)).toContain('🗑 已删除会话 aaaaaaaa…aa')
    const refreshed = transport.replyKeyboards.at(-1)
    expect(refreshed?.rows).toEqual([...ACTION_ROWS.map(row => [...row]), ['/delete 1 · ✅ 会话乙']])
    expect(refreshed?.text).toContain('点下方按钮删除对应会话')
  })

  it('degrades to the create hint when a delete empties the visible list', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A })]
    await console.handleMessage(10, '/delete')
    expect(transport.replyKeyboards).toHaveLength(1)
    port.sessions = []
    await console.handleMessage(10, '/delete 1')
    expect(port.archiveCalls).toEqual([ID_A])
    expect(replyTexts(transport)).toContain('当前没有可用会话。用 /new 创建一个。')
    // The emptied list degrades to the hint; no stale keyboard re-emits.
    expect(transport.replyKeyboards).toHaveLength(1)
  })

  it('refreshes a scoped workspace list after deleting one of its sessions', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A }), summary({ sessionId: ID_B })]
    port.workspaces = [{ ...workspace(), workspaceId: 'ws-1' as WorkspaceView['workspaceId'], title: '项目A', sessionIds: [ID_A, ID_B] }]
    await console.handleMessage(10, '/attach')
    // The keyboard owns digits at the picker: browse a workspace by tapping
    // its scope button, then delete inside the scoped list.
    await console.handleCallback(10, attachWorkspaceData('ws-1'))
    expect(transport.inlineKeyboards.at(-1)?.text).toContain('工作区「项目A」的会话')
    port.sessions = [summary({ sessionId: ID_B })]
    await console.handleMessage(10, '/delete 1')
    expect(port.archiveCalls).toEqual([ID_A])
    const refreshed = transport.inlineKeyboards.at(-1)
    expect(refreshed?.text).toContain('工作区「项目A」的会话')
    expect(refreshed?.rows).toEqual([[{ text: '✅ bbbbbbbb…bb', data: attachSessionData(ID_B) }]])
    // Deleting the last member empties the re-derived bucket: the scoped
    // list degrades to its empty hint instead of a stale keyboard.
    port.sessions = []
    await console.handleMessage(10, '/delete 1')
    expect(port.archiveCalls).toEqual([ID_A, ID_B])
    expect(replyTexts(transport)).toContain('工作区「项目A」的会话：（暂无会话）')
    // Picker, first list, and its refresh — the emptied re-list stays a hint, no fourth keyboard.
    expect(transport.inlineKeyboards).toHaveLength(3)
  })

  it('refreshes the re-derived archived scope after a delete', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A }), summary({ sessionId: ID_B })]
    port.archivedSessionIds = [ID_A, ID_B]
    await console.handleMessage(10, '/attach arc')
    expect(transport.inlineKeyboards.at(-1)?.rows).toEqual([
      [{ text: '✅ aaaaaaaa…aa', data: attachSessionData(ID_A) }],
      [{ text: '✅ bbbbbbbb…bb', data: attachSessionData(ID_B) }],
    ])
    port.sessions = [summary({ sessionId: ID_B })]
    await console.handleMessage(10, '/delete 1')
    expect(port.archiveCalls).toEqual([ID_A])
    const refreshed = transport.inlineKeyboards.at(-1)
    expect(refreshed?.text).toContain('归档会话')
    expect(refreshed?.rows).toEqual([[{ text: '✅ bbbbbbbb…bb', data: attachSessionData(ID_B) }]])
  })

  it('replaces a picker keyboard with the action rows instead of refreshing a stale session list', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    // A binding shows history, not a session list: the delete stays a reply.
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, `/delete ${ID_A}`)
    expect(port.archiveCalls).toEqual([ID_A])
    expect(transport.replyKeyboards).toHaveLength(0)
    // A model keyboard supersedes a session list: the delete targets a
    // listed row, resets the stale picker to the action rows, and must not
    // re-emit the stale session list over it.
    port.catalog = catalogFixture()
    port.sessions = [summary({ sessionId: ID_B })]
    await console.handleMessage(10, '/attach none')
    await console.handleMessage(10, '/model')
    await console.handleMessage(10, '/delete 1')
    expect(port.archiveCalls).toEqual([ID_A, ID_B])
    expect(transport.replyKeyboards.at(-1)?.text).toContain('已回到常用操作')
    expect(transport.replyKeyboards.at(-1)?.rows).toEqual([...ACTION_ROWS.map(row => [...row])])
  })
})

describe('/archive', () => {
  it('archives the bound session only on the second /archive and unbinds the chat', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/archive')
    // The first /archive only arms the confirmation; nothing is archived yet.
    expect(port.archiveCalls).toEqual([])
    expect(replyTexts(transport)).toContain('⚠️ 确认归档会话 aaaaaaaa…aa？再次发送 /archive 确认')
    await console.handleMessage(10, '/archive')
    expect(port.archiveCalls).toEqual([ID_A])
    expect(replyTexts(transport)).toContain('📦 已归档会话 aaaaaaaa…aa')
    transport.messages = []
    await console.handleMessage(10, '你好')
    expect(port.promptCalls).toEqual([])
    expect(replyTexts(transport)).toContain('还没有绑定会话')
  })

  it('archives a selector target on the second send without unbinding an unrelated session', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.sessions = [summary({ sessionId: ID_A }), summary({ sessionId: ID_B })]
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/attach none')
    await console.handleMessage(10, '/archive 2')
    expect(port.archiveCalls).toEqual([])
    await console.handleMessage(10, '/archive 2')
    expect(port.archiveCalls).toEqual([ID_B])
    transport.messages = []
    await console.handleMessage(10, '你好')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '你好' }])
  })

  it('re-arms instead of switching targets when the second /archive selects a different session', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.sessions = [summary({ sessionId: ID_A }), summary({ sessionId: ID_B })]
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/attach none')
    await console.handleMessage(10, '/archive 2')
    await console.handleMessage(10, '/archive 1')
    expect(replyTexts(transport)).toContain('⚠️ 已改选会话')
    expect(port.archiveCalls).toEqual([])
    await console.handleMessage(10, '/archive 1')
    expect(port.archiveCalls).toEqual([ID_A])
  })

  it('asks to bind before archiving without a bound session or selector', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/archive')
    expect(replyTexts(transport)).toContain('没有打开的会话。带参数使用 /archive <序号|id> 指定会话。')
  })

  it('a different command cancels the armed /archive', async () => {
    const { console, port } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/archive')
    await console.handleMessage(10, '/status')
    expect(port.archiveCalls).toEqual([])
    await console.handleMessage(10, '/archive')
    // The arm was cancelled: the next /archive arms again instead of archiving.
    expect(port.archiveCalls).toEqual([])
  })

  it('free text cancels the armed /archive and forwards as a prompt', async () => {
    const { console, port } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/archive')
    await console.handleMessage(10, '先别归档')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '先别归档' }])
    expect(port.archiveCalls).toEqual([])
    await console.handleMessage(10, '/archive')
    expect(port.archiveCalls).toEqual([])
  })

  it('conveys archive refusals on the confirming send', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/archive')
    port.archiveError = new Error('拒绝归档（session-not-found）')
    await console.handleMessage(10, '/archive')
    expect(replyTexts(transport)).toContain('⛔ 拒绝归档（session-not-found）')
  })
})

describe('/rename', () => {
  it('bare /rename without a bound session asks to attach first, leaving no pending state', async () => {
    const { console, port, transport } = setup()
    await console.handleMessage(10, '/rename')
    expect(replyTexts(transport)).toContain('当前无激活会话。请先绑定会话（如 /attach），再发 /rename 重命名。')
    // The next text still flows into the prompt path — no rename pending.
    await console.handleMessage(10, '你好')
    expect(port.renameCalls).toEqual([])
    expect(port.promptCalls).toEqual([])
    expect(replyTexts(transport)).toContain('还没有绑定会话。发 /attach（无参数先选工作区/未分组/归档）选择并绑定一个会话。')
  })

  it('bare /rename with a bound session prompts for the title and the next text renames', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/rename')
    expect(replyTexts(transport)).toContain('/rename：请再次输入标题，当前会话将重命名为（即重命名当前绑定会话）。')
    await console.handleMessage(10, '我的 新标题')
    expect(port.renameCalls).toEqual([{ sessionId: ID_A, title: '我的 新标题' }])
    expect(port.promptCalls).toEqual([])
    expect(replyTexts(transport)).toContain('✅ 已重命名为 我的 新标题')
    // The pending state cleared: the next text forwards as a prompt.
    await console.handleMessage(10, '继续')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '继续' }])
  })

  it('the pending rename is per-chat', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename')
    transport.messages = []
    await console.handleMessage(11, '另外一聊的标题')
    expect(port.renameCalls).toEqual([])
    expect(port.promptCalls).toEqual([])
    expect(replyTexts(transport)).toContain('还没有绑定会话。发 /attach（无参数先选工作区/未分组/归档）选择并绑定一个会话。')
    // Chat 10 still owns the pending rename.
    await console.handleMessage(10, '标题甲')
    expect(port.renameCalls).toEqual([{ sessionId: ID_A, title: '标题甲' }])
  })

  it('a /command cancels a pending rename and runs normally', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename')
    transport.messages = []
    // /close now needs its own second confirmation to dismiss.
    await console.handleMessage(10, '/close')
    await console.handleMessage(10, '/close')
    expect(transport.removeKeyboardCalls.length).toBe(1)
    // No pending rename survives: the next text forwards as a prompt.
    await console.handleMessage(10, '标题乙')
    expect(port.renameCalls).toEqual([])
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '标题乙' }])
  })

  it('backslash-escaped text counts as the pending title, not a command', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename')
    transport.messages = []
    await console.handleMessage(10, '\\/model')
    expect(port.renameCalls).toEqual([{ sessionId: ID_A, title: '/model' }])
    expect(port.promptCalls).toEqual([])
    expect(replyTexts(transport)).toContain('✅ 已重命名为 /model')
  })

  it('blank text cancels a pending rename', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename')
    transport.messages = []
    await console.handleMessage(10, '   ')
    expect(replyTexts(transport)).toContain('↩️ 已取消重命名。')
    expect(port.renameCalls).toEqual([])
    expect(port.promptCalls).toEqual([])
    await console.handleMessage(10, '标题丙')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '标题丙' }])
  })

  it('conveys refusals of a pending rename and clears the state', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.renameError = new Error('标题无效（title-invalid）')
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename')
    transport.messages = []
    await console.handleMessage(10, '无效标题')
    expect(port.renameCalls).toEqual([])
    expect(replyTexts(transport)).toContain('⛔ 标题无效（title-invalid）')
    // The pending state cleared after the refusal: the next text prompts.
    await console.handleMessage(10, '后来')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '后来' }])
  })

  it('renders non-Error refusals of a pending rename verbatim', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.renameError = '标题被拒' as unknown as Error
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename')
    transport.messages = []
    await console.handleMessage(10, '标题')
    expect(port.renameCalls).toEqual([])
    expect(replyTexts(transport)).toContain('⛔ 标题被拒')
  })

  it('renames the bound session with the full args as the title', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename 我的 新标题')
    expect(port.renameCalls).toEqual([{ sessionId: ID_A, title: '我的 新标题' }])
    expect(replyTexts(transport)).toContain('✅ 已重命名为 我的 新标题')
  })

  it('renames the bound session with a single-token title', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename 新标题')
    expect(port.renameCalls).toEqual([{ sessionId: ID_A, title: '新标题' }])
    expect(replyTexts(transport)).toContain('✅ 已重命名为 新标题')
  })

  it('targets a row-index or id selector, keeping the rest as the title', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A }), summary({ sessionId: ID_B })]
    await console.handleMessage(10, '/attach none')
    await console.handleMessage(10, '/rename 2 新标题')
    expect(port.renameCalls).toEqual([{ sessionId: ID_B, title: '新标题' }])
    transport.messages = []
    await console.handleMessage(10, `/rename ${ID_B} 另一个 标题`)
    expect(port.renameCalls).toEqual([
      { sessionId: ID_B, title: '新标题' },
      { sessionId: ID_B, title: '另一个 标题' },
    ])
  })

  it('refreshes the visible session list with the new title after a rename', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '旧标题' } } })]
    await console.handleMessage(10, '/attach none')
    expect(transport.inlineKeyboards.at(-1)?.rows).toEqual([[{ text: '✅ 旧标题', data: attachSessionData(ID_A) }]])
    port.sessions = [summary({ sessionId: ID_A, projections: { asOfSeq: 0, values: { title: '新标题' } } })]
    await console.handleMessage(10, '/rename 1 新标题')
    expect(port.renameCalls).toEqual([{ sessionId: ID_A, title: '新标题' }])
    const refreshed = transport.inlineKeyboards.at(-1)
    expect(refreshed?.text).toContain('未分组会话')
    expect(refreshed?.rows).toEqual([[{ text: '✅ 新标题', data: attachSessionData(ID_A) }]])
  })

  it('requests a bound session or selector when a title is given unbound', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/rename 话题')
    expect(replyTexts(transport)).toContain('没有打开的会话。带参数使用 /rename <序号|id> 指定会话。')
  })

  it('rejects out-of-range selectors', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/rename 9 标题')
    expect(replyTexts(transport)).toContain('序号 9 超出范围')
  })

  it('conveys rename refusals', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.renameError = new Error('标题无效（title-invalid）')
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename 无效标题')
    expect(replyTexts(transport)).toContain('⛔ 标题无效（title-invalid）')
  })

  it('renders non-Error rename failures verbatim', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.renameError = '标题被拒' as unknown as Error
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/rename 标题')
    expect(replyTexts(transport)).toContain('⛔ 标题被拒')
  })
})

describe('/fork', () => {
  it('bare /fork without a bound session asks to attach first', async () => {
    const { console, port, transport } = setup()
    await console.handleMessage(10, '/fork')
    expect(replyTexts(transport)).toContain('没有打开的会话。带参数使用 /fork <序号|id> 指定会话。')
    expect(port.forkCalls).toEqual([])
  })

  it('forks the bound session and binds the child, resetting the chat state', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, `/fork ${ID_A}`)
    expect(port.forkCalls).toEqual([ID_A])
    const reply = replyTexts(transport)
    expect(reply).toContain('🔀 已分叉会话')
    expect(reply).toContain('已绑定到新会话')
    // The child becomes the bound session: a prompt goes to the fork.
    expect(port.promptCalls).toEqual([])
    await console.handleMessage(10, '在新分叉上继续')
    expect(port.promptCalls).toEqual([{ sessionId: FORK_ID_1, mode: 'queue', text: '在新分叉上继续' }])
  })

  it('forks a selector target and stays bound to the child', async () => {
    const { console, port, transport } = setup()
    port.sessions = [summary({ sessionId: ID_A }), summary({ sessionId: ID_B })]
    await console.handleMessage(10, '/attach none')
    transport.messages = []
    await console.handleMessage(10, '/fork 2')
    expect(port.forkCalls).toEqual([ID_B])
    expect(replyTexts(transport)).toContain('🔀 已分叉会话')
    expect(port.promptCalls).toEqual([])
    await console.handleMessage(10, '继续')
    expect(port.promptCalls).toEqual([{ sessionId: FORK_ID_1, mode: 'queue', text: '继续' }])
  })

  it('conveys fork refusals and keeps the binding', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.forkError = new Error('会话没有已完成回合（fork-unavailable）')
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/fork')
    expect(replyTexts(transport)).toContain('⛔ 会话没有已完成回合（fork-unavailable）')
    // The refused fork never reaches the port's record point.
    expect(port.forkCalls).toEqual([])
    // The binding survives a refused fork.
    expect(port.promptCalls).toEqual([])
    await console.handleMessage(10, '原会话继续')
    expect(port.promptCalls).toEqual([{ sessionId: ID_A, mode: 'queue', text: '原会话继续' }])
  })

  it('renders non-Error fork failures verbatim', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.forkError = '分叉被拒' as unknown as Error
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/fork')
    expect(replyTexts(transport)).toContain('⛔ 分叉被拒')
  })

  it('rejects out-of-range fork selectors', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/fork 9')
    expect(replyTexts(transport)).toContain('序号 9 超出范围')
  })
})

describe('/curTasks', () => {
  const todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = [
    { content: '拉取数据', status: 'completed' },
    { content: '写报告', status: 'in_progress' },
    { content: '发邮件', status: 'pending' },
  ]

  it('asks to bind first when no session is bound', async () => {
    const { console, port, transport } = setup()
    await console.handleMessage(10, '/curTasks')
    expect(replyTexts(transport)).toContain('还没有绑定会话')
    expect(port.todosCalls).toEqual([])
  })

  it('renders the bound session todo list with the status summary', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.todos = todos
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/curTasks')
    expect(port.todosCalls).toEqual([ID_A])
    expect(replyTexts(transport)).toContain('📋 任务 1 已完成 · 1 进行中 · 1 待处理')
    expect(replyTexts(transport)).toContain('2) 🔄 写报告')
  })

  it('reports an empty list', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.todos = null
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/curTasks')
    expect(replyTexts(transport)).toContain('当前会话暂无任务列表')
  })

  it('conveys todo list refusals', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.todosError = new Error('会话不存在（session-not-found）')
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/curTasks')
    expect(replyTexts(transport)).toContain('⛔ 会话不存在（session-not-found）')
  })

  it('renders non-Error todo refusals verbatim', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.todosError = '任务读取被拒' as unknown as Error
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/curTasks')
    expect(replyTexts(transport)).toContain('⛔ 任务读取被拒')
  })
})

describe('/preset', () => {
  const presets = [
    { id: 'standard', name: '标准模式', trust: 'system' as const, isDefault: true },
    { id: 'code', name: 'PTC 模式', trust: 'system' as const, isDefault: false },
    { id: 'minimal', name: '极简模式', trust: 'system' as const, isDefault: false },
  ]

  it('opens the preset picker keyboard without arguments', async () => {
    const { console, port, transport } = setup()
    port.presets = presets
    await console.handleMessage(10, '/preset')
    const keyboard = transport.replyKeyboards.at(-1)
    expect(keyboard?.text).toContain('🎛 选择会话模式')
    expect(keyboard?.rows).toEqual([
      ...ACTION_ROWS.map(row => [...row]),
      ['/preset 1 · 标准模式'],
      ['/preset 2 · PTC 模式'],
      ['/preset 3 · 极简模式'],
    ])
  })

  it('reports an empty preset roster', async () => {
    const { console, transport } = setup()
    await console.handleMessage(10, '/preset')
    expect(replyTexts(transport)).toContain('此部署未配置预设模式')
  })

  it('applies a picked preset to the bound blank session', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.presets = presets
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/preset 2')
    expect(port.selectCalls).toEqual([{ sessionId: ID_A, agentPreset: 'code' }])
    expect(replyTexts(transport)).toContain('✅ 已切换会话模式为「PTC 模式」')
  })

  it('selects a preset by id', async () => {
    const { console, port } = setup()
    port.history.set(ID_A, [])
    port.presets = presets
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/preset code')
    expect(port.selectCalls).toEqual([{ sessionId: ID_A, agentPreset: 'code' }])
  })

  it('rejects unknown preset selectors', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.presets = presets
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/preset 不存在')
    expect(replyTexts(transport)).toContain('没有找到模式 不存在')
    expect(port.selectCalls).toEqual([])
  })

  it('stages the preset for the next /new when the bound session already started', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.presets = presets
    port.workspaces = [workspace()]
    port.selectError = new Error('session 已开始；无法切换（agent-preset-locked）')
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/preset')
    await console.handleMessage(10, '/preset 3')
    expect(replyTexts(transport)).toContain('已暂存「极简模式」：下一次 /new 创建会话时生效')
    // The preset rides into the created session beside the workspace pick.
    await console.handleMessage(10, '/new')
    transport.messages = []
    await console.handleMessage(10, '/new 1')
    expect(port.createCalls.at(-1)).toEqual({ workspaceId: 'ws-1', agentPreset: 'minimal' })
    expect(replyTexts(transport)).toContain('模式 minimal')
  })

  it('stages the preset when no session is bound and consumes it in /new', async () => {
    const { console, port, transport } = setup()
    port.presets = presets
    port.workspaces = [workspace()]
    await console.handleMessage(10, '/preset 1')
    expect(replyTexts(transport)).toContain('暂存模式「标准模式」：下一次 /new 创建会话时生效')
    await console.handleMessage(10, '/new')
    transport.messages = []
    await console.handleMessage(10, '/new 1')
    expect(port.createCalls.at(-1)).toEqual({ workspaceId: 'ws-1', agentPreset: 'standard' })
  })

  it('conveys preset refusals verbatim', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.presets = presets
    port.selectError = new Error('预设不存在（agent-preset-not-found）')
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/preset 2')
    expect(replyTexts(transport)).toContain('⛔ 预设不存在（agent-preset-not-found）')
    // The refused select never reaches the port's record point.
    expect(port.selectCalls).toEqual([])
  })

  it('shows the staged preset in the picker text', async () => {
    const { console, port, transport } = setup()
    port.presets = presets
    await console.handleMessage(10, '/preset 1')
    await console.handleMessage(10, '/preset')
    expect(transport.replyKeyboards.at(-1)?.text).toContain('已暂存：标准模式（下一次 /new 生效）')
  })

  it('stages a preset into /new none', async () => {
    const { console, port } = setup()
    port.presets = presets
    await console.handleMessage(10, '/preset 1')
    await console.handleMessage(10, '/new none')
    expect(port.createCalls.at(-1)).toEqual({ agentPreset: 'standard' })
  })

  it('stages a preset into /new by path', async () => {
    const { console, port } = setup()
    port.presets = presets
    await console.handleMessage(10, '/preset 3')
    await console.handleMessage(10, '/new /srv/preset-path')
    expect(port.createCalls.at(-1)).toEqual({ workspaceId: 'ws-1', agentPreset: 'minimal' })
  })

  it('selects a preset whose display falls back to its id', async () => {
    const { console, port } = setup()
    port.history.set(ID_A, [])
    port.presets = [{ id: 'bare', trust: 'system' as const, isDefault: false }]
    await console.handleMessage(10, `/attach ${ID_A}`)
    await console.handleMessage(10, '/preset 1')
    expect(port.selectCalls).toEqual([{ sessionId: ID_A, agentPreset: 'bare' }])
  })

  it('renders non-Error preset refusals verbatim', async () => {
    const { console, port, transport } = setup()
    port.history.set(ID_A, [])
    port.presets = presets
    port.selectError = '模式切换被拒' as unknown as Error
    await console.handleMessage(10, `/attach ${ID_A}`)
    transport.messages = []
    await console.handleMessage(10, '/preset 2')
    expect(replyTexts(transport)).toContain('⛔ 模式切换被拒')
  })

  it('falls back to the staged id in the picker when the roster changed', async () => {
    const { console, port, transport } = setup()
    port.presets = presets
    await console.handleMessage(10, '/preset 1')
    port.presets = [presets[1]!]
    await console.handleMessage(10, '/preset')
    expect(transport.replyKeyboards.at(-1)?.text).toContain('已暂存：standard（下一次 /new 生效）')
  })
})
