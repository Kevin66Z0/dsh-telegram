/**
 * Pure rendering helpers: every function deterministic from its inputs.
 */

import { describe, expect, it } from 'vitest'
import type { SessionSummary, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CREATE_UNGROUPED_LABEL, KEYBOARD_ACTION_ROWS, PRESET_KEYBOARD_MAX, QUEUE_ACK_MAX,
  SESSION_KEYBOARD_MAX, SESSION_STATE_LEGEND, SESSION_TITLE_MAX, STATUS_MAIN_MAX, STREAM_REPLYING_SUFFIX,
  REASONING_BRIEF_MAX, TELEGRAM_CHUNK_MAX, TELEGRAM_VERSION, TOOL_ARGS_MAX, WORKSPACE_KEYBOARD_MAX,
  accumulateRoundUsage, actionsHtml, assistantMessageText, assistantTail, attachScopeButtons, attachSessionButtons,
  lastTurnUsage, latestTurnStartTime, openTurnUsage,
  attachSessionData, blockText, chunkText, compactTokenCount,
  emptyRoundUsage, escapeHtml, formatStartClock, lastTodoWrite, messageActions, openToolCalls,
  parseAttachCallback, parseQuestionCallback, parseSessionListCallback,
  pendingAskBatches, presetKeyboardRows, questionCancelData, questionCustomData, questionKeyboard, questionMessageText,
  questionOptionData, questionSubmitData, reasoningBrief, renderTodoList, roundUsageFooter, startClockLabel, stepActions, stepActionsHtml,
  attachKeyboardRows, stripStreamSuffix, sessionActionButtons, sessionKeyboardRows, sessionRow, sessionStatusData, sessionStopData,
  shortSessionId, statusMainText, statusStats, timeAgo, todoRow,
  toolArgBrief, toolCallBrief, truncate, turnEndLabel, turnOpen, userMessageText, workspaceKeyboardRows, workspaceRow, type StepAction,
} from '../src/render.ts'

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: SessionId('11111111-2222-3333-4444-555555555555'),
    updatedAt: 0,
    running: false,
    blank: false,
    ...over,
  }
}

/** One workspace row fixture; shared by the workspace and /attach scope keyboard tests. */
function workspaceRowItem(over: Partial<{ workspaceId: string; title: string; path: string }> = {}): WorkspaceView {
  return {
    workspaceId: (over.workspaceId ?? 'ws-1') as WorkspaceView['workspaceId'],
    title: over.title ?? '数据中台',
    path: over.path ?? '/srv/data-hub',
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('truncate', () => {
  it('keeps short text unchanged', () => {
    expect(truncate('你好', 10)).toBe('你好')
  })

  it('ellipsizes long text by code points', () => {
    expect(truncate('一二三四五六', 4)).toBe('一二三四…')
  })

  it('caps at the maximum when text is exactly the limit', () => {
    expect(truncate('abcd', 4)).toBe('abcd')
  })
})

describe('timeAgo', () => {
  it('labels fresh timestamps 刚刚', () => {
    expect(timeAgo(1_000_000, 1_010_000)).toBe('刚刚')
  })

  it('labels minutes', () => {
    expect(timeAgo(1_000_000, 1_360_000)).toBe('6 分钟前')
  })

  it('labels hours', () => {
    expect(timeAgo(1_000_000, 1_720_000)).toBe('12 分钟前')
    expect(timeAgo(1_000_000, 7_600_000)).toBe('1 小时前')
  })

  it('labels days', () => {
    expect(timeAgo(1_000_000, 200_000_000)).toBe('2 天前')
  })

  it('clamps future timestamps to 刚刚', () => {
    expect(timeAgo(1_000_000, 500_000)).toBe('刚刚')
  })
})

describe('formatStartClock', () => {
  // Local-Date construction keeps every input/output pair on the machine's own
  // timezone, so the assertions stay stable wherever the tests run.
  const at = (year: number, month: number, day: number, hour: number, minute: number, second: number) =>
    new Date(year, month - 1, day, hour, minute, second).getTime()

  it('shows time only within the same day', () => {
    expect(formatStartClock(at(2026, 8, 20, 9, 33, 19), at(2026, 8, 20, 12, 0, 0))).toBe('09:33:19')
  })

  it('prefixes month and day across days within the same year', () => {
    expect(formatStartClock(at(2026, 8, 16, 9, 33, 19), at(2026, 8, 20, 12, 0, 0))).toBe('08-16 09:33:19')
  })

  it('prefixes the full year across years', () => {
    expect(formatStartClock(at(2025, 12, 31, 23, 59, 5), at(2026, 1, 1, 0, 0, 0))).toBe('2025-12-31 23:59:05')
  })

  it('zero-pads every field', () => {
    expect(formatStartClock(at(2026, 3, 5, 4, 7, 9), at(2026, 3, 5, 4, 7, 9))).toBe('04:07:09')
  })
})

describe('startClockLabel', () => {
  it('wraps the clock in full-width parens', () => {
    const ms = new Date(2026, 7, 20, 9, 33, 19).getTime()
    expect(startClockLabel(ms, ms)).toBe('（09:33:19）')
  })
})

describe('shortSessionId', () => {
  it('shortens long ids', () => {
    expect(shortSessionId(SessionId('11111111-2222-3333-4444-555555555555'))).toBe('11111111…55')
  })

  it('keeps short ids', () => {
    expect(shortSessionId(SessionId('abc'))).toBe('abc')
  })
})

describe('blockText', () => {
  it('concatenates text blocks only', () => {
    const content = [
      { type: 'text', text: 'hello ' } as never,
      { type: 'image', url: 'data:image/png;base64,AAA', visible: true } as never,
      { type: 'tool-call', invocationId: 'c1', name: 'read_file', arguments: '{}' } as never,
      { type: 'text', text: 'world' } as never,
      { type: 'future-block', anything: 1 } as never,
    ]
    expect(blockText(content)).toBe('hello world')
  })

  it('returns empty for content without text', () => {
    expect(blockText([{ type: 'image', url: 'x', visible: true } as never])).toBe('')
  })
})

describe('userMessageText / assistantMessageText', () => {
  it('extracts display text from user and assistant messages', () => {
    expect(userMessageText({ content: [{ type: 'text', text: ' 请分析 ' }] } as never)).toBe('请分析')
    expect(assistantMessageText({ content: [{ type: 'text', text: '结果' }] } as never)).toBe('结果')
  })

  it('returns empty for text-free messages', () => {
    expect(userMessageText({ content: [{ type: 'tool-result', toolCallId: 'c', content: [] }] } as never)).toBe('')
    expect(assistantMessageText({ content: [] } as never)).toBe('')
  })
})

describe('toolCallBrief', () => {
  it('uses the first object value when arguments parse', () => {
    expect(toolCallBrief('read_file', '{"path":"/a/b.txt","limit":5}')).toBe('read_file(/a/b.txt)')
  })

  it('stringifies a non-string first value', () => {
    expect(toolCallBrief('read_file', '{"limit":5}')).toBe('read_file(5)')
  })

  it('falls back to the raw JSON for an empty object', () => {
    expect(toolCallBrief('read_file', '{}')).toBe('read_file({})')
  })

  it('keeps the raw text when JSON parsing fails', () => {
    expect(toolCallBrief('read_file', 'not-json')).toBe('read_file(not-json)')
  })

  it('truncates long briefs', () => {
    const long = `{"path":"${'x'.repeat(TOOL_ARGS_MAX + 10)}"}`
    expect(toolCallBrief('read_file', long)).toBe(`read_file(${'x'.repeat(TOOL_ARGS_MAX)}…)`)
  })
})

describe('toolArgBrief', () => {
  it('extracts the first object value without the tool name', () => {
    expect(toolArgBrief('{"path":"/a/b.txt","limit":5}')).toBe('/a/b.txt')
    expect(toolArgBrief('{"limit":5}')).toBe('5')
    expect(toolArgBrief('{}')).toBe('{}')
    expect(toolArgBrief('not-json')).toBe('not-json')
  })
})

describe('reasoningBrief', () => {
  it('collapses whitespace and truncates long passes', () => {
    expect(reasoningBrief(' 对比信息\n基本齐了。\n再确认一个 ')).toBe('对比信息 基本齐了。 再确认一个')
    expect(reasoningBrief('x'.repeat(REASONING_BRIEF_MAX + 5))).toBe(`${'x'.repeat(REASONING_BRIEF_MAX)}…`)
    expect(reasoningBrief('   \n  ')).toBe('')
  })
})

describe('turnEndLabel', () => {
  it.each([
    [{ kind: 'completed' } as never, '✅ done'],
    [{ kind: 'aborted', reason: { kind: 'user' } } as never, '⏹ stopped'],
    [{ kind: 'blocked' } as never, '⛔ blocked'],
    [{ kind: 'error', error: { message: 'boom', code: 'X' } } as never, '❌ failed'],
    [{ kind: 'max-tokens' } as never, '⏳ max tokens'],
    [{ kind: 'interrupted' } as never, '⏸ interrupted'],
  ])('labels known outcomes', (reason, label) => {
    expect(turnEndLabel(reason)).toBe(label)
  })

  it('falls back to the raw kind for unknown outcomes', () => {
    expect(turnEndLabel({ kind: 'custom' } as never)).toBe('⏹ custom')
  })
})

describe('sessionRow', () => {
  const now = 200_000_000

  it('renders the projection title, running glyph, cwd, age, and short id', () => {
    const row = sessionRow(1, summary({
      running: true,
      updatedAt: 100_000_000,
      cwd: '/works/proj',
      projections: { asOfSeq: 5, values: { title: '拉取数据' } },
    }), now)
    expect(row).toBe('1) 🟢 拉取数据\n   /works/proj · 1 天前 · 11111111…55')
  })

  it('marks a non-blank idle session finished and keeps the blank glyph for never-run sessions', () => {
    expect(sessionRow(2, summary({ cwd: '/works/proj' }), now)).toContain('✅ /works/proj')
    expect(sessionRow(3, summary({ blank: true }), now)).toContain('⚪ 11111111…55')
  })

  it('keeps long titles untruncated', () => {
    const row = sessionRow(1, summary({ projections: { asOfSeq: 0, values: { title: '长'.repeat(60) } } }), now)
    expect(row).toContain(`1) ✅ ${'长'.repeat(60)}`)
  })
})

describe('state legend and queue ack cap', () => {
  it('describes the tri-state glyphs in list order', () => {
    expect(SESSION_STATE_LEGEND).toBe('🟢 执行中 · ✅ 已完成 · ⚪ 未开始')
  })

  it('caps acknowledgement echoes above the small-message budget', () => {
    expect(QUEUE_ACK_MAX).toBeGreaterThanOrEqual(100)
    expect(QUEUE_ACK_MAX).toBeLessThanOrEqual(400)
  })
})

function userEvent(text: string): SessionEvent {
  return { type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } } as unknown as SessionEvent
}

/** Build a raw session event for rendering tests; shading is the renderer's job. */
function ev(type: string, data: unknown, seq = 0): SessionEvent {
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

/** A workspace-instruction user message (`source.kind === 'agent-instructions'`). */
function instructionEvent(text: string): SessionEvent {
  return { type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text }], source: { kind: 'agent-instructions', form: 'instructions', changes: [] } } } as unknown as SessionEvent
}

describe('assistantTail', () => {
  const msg = (text: string) => ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } })

  it('returns every assistant reply when there are no more than rounds', () => {
    expect(assistantTail([], 2)).toEqual([])
    expect(assistantTail([msg('甲'), msg('乙')], 2)).toEqual(['甲', '乙'])
    expect(assistantTail([msg('甲')], 5)).toEqual(['甲'])
  })

  it('keeps only the last rounds replies', () => {
    expect(assistantTail([msg('甲'), msg('乙'), msg('丙')], 2)).toEqual(['乙', '丙'])
    expect(assistantTail([msg('甲'), msg('乙'), msg('丙')], 1)).toEqual(['丙'])
  })

  it('skips empty assistant messages and non-assistant events', () => {
    expect(assistantTail([msg('')], 2)).toEqual([])
    expect(assistantTail([ev('assistant/message', { turn: 1, step: 1, message: { content: [] } }), msg('甲')], 2)).toEqual(['甲'])
    expect(assistantTail([
      ev('turn/start', { turn: 1 }),
      userEvent('你好'),
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
      ev('tool/result', { turn: 1, step: 1, message: {} }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      msg('甲'),
    ], 2)).toEqual(['甲'])
  })
})

describe('statusMainText', () => {
  const toolCall = (name: string) => ev('tool/call', { turn: 1, step: 1, callId: `c-${name}`, name, arguments: '{}' })
  const toolResult = () => ev('tool/result', { turn: 1, step: 1, message: {} })
  const assistant = (text: string) => ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } })

  it('hints at a blank page', () => {
    expect(statusMainText([])).toBe('（空白会话，还没有消息）')
  })

  it('reports a trailing unpaired tool call as in-progress', () => {
    const events = [
      userEvent('跑一下'),
      assistant('我来看'),
      toolCall('bash'),
      assistant('正在执行'),
    ]
    expect(statusMainText(events)).toBe('🔧 工具调用中: bash')
  })

  it('reports the last open call when several stay unpaired', () => {
    const events = [toolCall('bash'), assistant('还在执行'), toolCall('node')]
    expect(statusMainText(events)).toBe('🔧 工具调用中: node')
  })

  it('pairs results with the most recent open call', () => {
    const events = [toolCall('bash'), toolCall('node'), toolResult()]
    expect(statusMainText(events)).toBe('🔧 工具调用中: bash')
  })

  it('shows the last assistant text once every call has its result', () => {
    const events = [
      userEvent('跑一下'),
      toolCall('bash'),
      toolResult(),
      assistant('完成，结果表明'),
      toolCall('read_file'),
      toolResult(),
      assistant('文件里写了答案'),
    ]
    expect(statusMainText(events)).toBe('🤖 文件里写了答案')
  })

  it('settles outstanding calls at turn/end, even without results', () => {
    const events = [
      assistant('我去调用'),
      toolCall('bash'),
      ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
    ]
    expect(statusMainText(events)).toBe('🤖 我去调用')
  })

  it('scans back past text-free assistant steps to the last spoken output', () => {
    const events = [assistant('第一段'), ev('assistant/message', { turn: 1, step: 1, message: { content: [] } })]
    expect(statusMainText(events)).toBe('🤖 第一段')
  })

  it('falls back to a no-output hint when nothing spoke text', () => {
    expect(statusMainText([userEvent('你好'), toolCall('bash'), toolResult()])).toBe('（暂无输出）')
  })

  it('caps the assistant preview at STATUS_MAIN_MAX code points', () => {
    const long = '长'.repeat(STATUS_MAIN_MAX + 10)
    expect(statusMainText([assistant(long)])).toBe(`🤖 ${'长'.repeat(STATUS_MAIN_MAX)}…`)
  })
})

describe('openToolCalls', () => {
  const toolCall = (name: string, args = '{}') => ev('tool/call', { turn: 1, step: 1, callId: 'c-' + name, name, arguments: args })
  const toolResult = () => ev('tool/result', { turn: 1, step: 1, message: {} })
  const turnEnd = () => ev('turn/end', { turn: 1, reason: { kind: 'completed' } })

  it('lists open calls and drops paired or settled ones', () => {
    expect(openToolCalls([])).toEqual([])
    expect(openToolCalls([userEvent('你好')])).toEqual([])
    expect(openToolCalls([toolCall('read_file', '{"path":"/x"}'), toolResult()])).toEqual([])
    expect(openToolCalls([toolCall('bash'), turnEnd()])).toEqual([])
    expect(openToolCalls([toolCall('bash'), toolCall('node'), toolResult()])).toEqual(['bash({})'])
    expect(openToolCalls([toolCall('read_file', '{"path":"/x"}')])).toEqual(['read_file(/x)'])
  })
})

describe('turnOpen', () => {
  const toolCall = (name: string) => ev('tool/call', { turn: 1, step: 1, callId: 'c-' + name, name, arguments: '{}' })
  const toolResult = () => ev('tool/result', { turn: 1, step: 1, message: {} })
  const turnStart = () => ev('turn/start', { turn: 1 })
  const turnEnd = (kind: string = 'completed') => ev('turn/end', { turn: 1, reason: { kind } })
  const speak = (text: string) => ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } })

  it('is open from turn/start until the end boundary, even while composing the reply', () => {
    expect(turnOpen([])).toBe(false)
    expect(turnOpen([userEvent('你好')])).toBe(false)
    expect(turnOpen([turnStart()])).toBe(true)
    expect(turnOpen([turnStart(), speak('正在写正文')])).toBe(true)
    expect(turnOpen([turnStart(), toolCall('bash'), toolResult(), speak('结论')])).toBe(true)
  })

  it('is closed by any turn end, regardless of outcome and pending results', () => {
    expect(turnOpen([turnStart(), speak('好了'), turnEnd('completed')])).toBe(false)
    expect(turnOpen([turnStart(), toolCall('bash'), turnEnd('interrupted')])).toBe(false)
    expect(turnOpen([speak('我去调用'), toolCall('bash'), turnEnd('error')])).toBe(false)
  })

  it('reopens when a later turn starts after a closed one', () => {
    expect(turnOpen([turnStart(), turnEnd('completed'), turnStart()])).toBe(true)
    expect(turnOpen([turnStart(), turnEnd('completed'), turnStart(), turnEnd('completed')])).toBe(false)
  })

  it('falls back to unpaired tool calls when the window lacks turn boundaries', () => {
    expect(turnOpen([toolCall('bash')])).toBe(true)
    expect(turnOpen([toolCall('bash'), toolResult(), speak('收尾中')])).toBe(false)
  })
})

/** Turn-boundary and assistant fixtures shared by the usage folds. */
const usageTurnStart = () => ev('turn/start', { turn: 1 })
const usageTurnEnd = (kind: string = 'completed') => ev('turn/end', { turn: 1, reason: { kind } })
const usageSpeak = (text: string, usage?: TokenUsage) => ev('assistant/message', {
  turn: 1, step: 1, message: { content: [{ type: 'text', text }] }, ...(usage === undefined ? {} : { usage }),
})

describe('lastTurnUsage', () => {
  it('is empty for a blank page or events without any turn boundary', () => {
    expect(lastTurnUsage([])).toEqual(emptyRoundUsage())
    expect(lastTurnUsage([userEvent('你好'), usageSpeak('甲', { inputTokens: 5, outputTokens: 1 })])).toEqual(emptyRoundUsage())
  })

  it('accumulates the assistant usage of the last completed turn', () => {
    expect(lastTurnUsage([
      usageTurnStart(),
      usageSpeak('甲', { inputTokens: 500, outputTokens: 100, cacheReadTokens: 300 }),
      usageSpeak('乙', { inputTokens: 700, outputTokens: 200, cacheReadTokens: 300 }),
      usageTurnEnd(),
    ])).toEqual({ input: 1200, output: 300, cacheRead: 600, cacheWrite: 0 })
  })

  it('skips records without usage and events outside the assistant messages', () => {
    expect(lastTurnUsage([
      usageTurnStart(),
      userEvent('一轮'),
      usageSpeak('甲'),
      usageSpeak('乙', { inputTokens: 10, outputTokens: 2 }),
      usageTurnEnd(),
    ])).toEqual({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0 })
  })

  it('only counts the last completed turn, not earlier ones', () => {
    expect(lastTurnUsage([
      usageTurnStart(),
      usageSpeak('第一回合', { inputTokens: 100, outputTokens: 10 }),
      usageTurnEnd(),
      usageTurnStart(),
      usageSpeak('第二回合', { inputTokens: 200, outputTokens: 20, cacheWriteTokens: 50 }),
      usageTurnEnd(),
    ])).toEqual({ input: 200, output: 20, cacheRead: 0, cacheWrite: 50 })
  })

  it('is empty while the latest turn is still open', () => {
    expect(lastTurnUsage([usageTurnStart(), usageSpeak('甲', { inputTokens: 5, outputTokens: 1 })])).toEqual(emptyRoundUsage())
    expect(lastTurnUsage([usageTurnStart(), usageTurnEnd(), usageTurnStart()])).toEqual(emptyRoundUsage())
  })

  it('is empty when the turn/start fell outside the window', () => {
    expect(lastTurnUsage([usageSpeak('甲', { inputTokens: 5, outputTokens: 1 }), usageTurnEnd()])).toEqual(emptyRoundUsage())
  })
})

describe('openTurnUsage', () => {
  it('is empty for a blank page or events without an open turn', () => {
    expect(openTurnUsage([])).toEqual(emptyRoundUsage())
    expect(openTurnUsage([userEvent('你好'), usageSpeak('甲', { inputTokens: 5, outputTokens: 1 })])).toEqual(emptyRoundUsage())
    expect(openTurnUsage([usageTurnStart(), usageSpeak('甲', { inputTokens: 5, outputTokens: 1 }), usageTurnEnd()])).toEqual(emptyRoundUsage())
  })

  it('accumulates the assistant usage of the still-open turn', () => {
    expect(openTurnUsage([
      usageTurnStart(),
      usageSpeak('甲', { inputTokens: 500, outputTokens: 100, cacheReadTokens: 300 }),
      usageSpeak('乙', { inputTokens: 700, outputTokens: 200, cacheReadTokens: 300 }),
    ])).toEqual({ input: 1200, output: 300, cacheRead: 600, cacheWrite: 0 })
  })

  it('counts only the open turn after a closed one', () => {
    expect(openTurnUsage([
      usageTurnStart(),
      usageSpeak('第一回合', { inputTokens: 100, outputTokens: 10 }),
      usageTurnEnd(),
      usageTurnStart(),
      usageSpeak('第二回合', { inputTokens: 200, outputTokens: 20, cacheWriteTokens: 50 }),
    ])).toEqual({ input: 200, output: 20, cacheRead: 0, cacheWrite: 50 })
  })
})

describe('latestTurnStartTime', () => {
  it('returns the last turn/start time, or undefined without one', () => {
    expect(latestTurnStartTime([])).toBeUndefined()
    expect(latestTurnStartTime([userEvent('你好')])).toBeUndefined()
    expect(latestTurnStartTime([{ type: 'turn/start', seq: 0, time: 123, data: { turn: 1 } }])).toBe(123)
    expect(latestTurnStartTime([
      { type: 'turn/start', seq: 0, time: 123, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 200, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 2, time: 300, data: { turn: 2 } },
    ])).toBe(300)
  })
})

describe('stepActions / stepActionsHtml', () => {
  const call = (name: string, args = '{}') => ({ type: 'tool-call', id: 'c-' + name, name, arguments: args })
  const think = (text: string) => ({ type: 'reasoning', text })
  const msg = (...blocks: object[]) => ev('assistant/message', { turn: 1, step: 1, message: { content: blocks } })

  it('lists one line per action in content order, skipping text and non-message events', () => {
    expect(stepActions([])).toEqual([])
    expect(stepActions([userEvent('你好')])).toEqual([])
    expect(stepActions([ev('tool/call', { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{}' })])).toEqual([])
    expect(stepActions([msg({ type: 'text', text: '好' })])).toEqual([])
    expect(stepActions([msg(think('先想想'), call('bash'))])).toEqual([
      { time: 0, line: '💭 Think — 先想想' },
      { time: 0, line: '🔧 bash — {}' },
    ])
  })

  it('caps at the most recent maxActions lines', () => {
    const events = [msg(call('a')), msg(call('b')), msg(call('c'))]
    expect(stepActions(events, 2)).toEqual([{ time: 0, line: '🔧 b — {}' }, { time: 0, line: '🔧 c — {}' }])
    expect(stepActions(events, 5)).toEqual([
      { time: 0, line: '🔧 a — {}' },
      { time: 0, line: '🔧 b — {}' },
      { time: 0, line: '🔧 c — {}' },
    ])
  })

  it('renders one time-stamped expandable line per action, or returns empty', () => {
    const now = 2_000
    const clock = startClockLabel(0, now)
    expect(stepActionsHtml([], now)).toBe('')
    expect(stepActionsHtml([msg(call('read_file', '{"path":"/x"}'))], now)).toBe(`<blockquote expandable>${clock}🔧 read_file — /x</blockquote>`)
    expect(stepActionsHtml([msg(think('先想想'), call('bash'), call('node'))], now)).toBe(`<blockquote expandable>${clock}💭 Think — 先想想\n${clock}🔧 bash — {}\n${clock}🔧 node — {}</blockquote>`)
    expect(stepActionsHtml([msg(call('bash', '{"cmd":"a < b & c"}'))], now)).toBe(`<blockquote expandable>${clock}🔧 bash — a &lt; b &amp; c</blockquote>`)
  })
})

describe('messageActions / actionsHtml', () => {
  const call = (name: string, args = '{}') => ({ type: 'tool-call', id: 'c-' + name, name, arguments: args })
  const think = (text: string) => ({ type: 'reasoning', text })
  const message = (blocks: object[]): never => ({ content: blocks }) as never

  it('renders reasoning and tool-call blocks as action lines, skipping text and blank reasoning', () => {
    expect(messageActions(message([]), 0)).toEqual([])
    expect(messageActions(message([{ type: 'text', text: '好' }]), 0)).toEqual([])
    expect(messageActions(message([think('   \n ')]), 0)).toEqual([])
    expect(messageActions(message([think('先想想'), call('read_file', '{"path":"/x"}'), { type: 'text', text: '好了' }]), 0)).toEqual([
      { time: 0, line: '💭 Think — 先想想' },
      { time: 0, line: '🔧 read_file — /x' },
    ])
    expect(messageActions(message([call('bash'), call('node')]), 0)).toEqual([
      { time: 0, line: '🔧 bash — {}' },
      { time: 0, line: '🔧 node — {}' },
    ])
  })

  it('renders action lines into an expandable blockquote with per-line clocks', () => {
    const now = 2_000
    const clock = startClockLabel(0, now)
    const action = (line: string): StepAction => ({ time: 0, line })
    expect(actionsHtml([], now)).toBe('')
    expect(actionsHtml([action('🔧 read_file — /x')], now)).toBe(`<blockquote expandable>${clock}🔧 read_file — /x</blockquote>`)
    expect(actionsHtml([action('💭 Think — 先想想'), action('🔧 bash — {}')], now)).toBe(`<blockquote expandable>${clock}💭 Think — 先想想\n${clock}🔧 bash — {}</blockquote>`)
    expect(actionsHtml([action('🔧 bash — a < b & c')], now)).toBe(`<blockquote expandable>${clock}🔧 bash — a &lt; b &amp; c</blockquote>`)
  })
})

describe('pendingAskBatches', () => {
  const asked = (id: string) => ev('question/asked', { id, questions: [{ id: 'q', question: '选哪个' }] })
  const decided = (id: string) => ev('question/decided', { id, outcome: 'answered' })

  it('returns only the asks without a later decision', () => {
    expect(pendingAskBatches([])).toEqual([])
    expect(pendingAskBatches([asked('a'), decided('a')])).toEqual([])
    expect(pendingAskBatches([asked('a')])).toEqual([{ id: 'a', questions: [{ id: 'q', question: '选哪个' }] }])
    expect(pendingAskBatches([asked('a'), decided('a'), asked('b')])).toEqual([{ id: 'b', questions: [{ id: 'q', question: '选哪个' }] }])
  })
})

describe('chunkText', () => {
  it('returns a single chunk under the cap', () => {
    expect(chunkText('short')).toEqual(['short'])
  })

  it('hard-splits long text without newlines', () => {
    const text = 'x'.repeat(TELEGRAM_CHUNK_MAX + 10)
    const chunks = chunkText(text)
    expect(chunks.length).toBe(2)
    expect(Array.from(chunks[0]!).length).toBe(TELEGRAM_CHUNK_MAX)
    expect(chunks.join('')).toBe(text)
  })

  it('splits at the last newline inside the window when available', () => {
    const text = 'y'.repeat(100) + '\n' + 'z'.repeat(TELEGRAM_CHUNK_MAX)
    const chunks = chunkText(text, 200)
    expect(chunks[0]).toBe('y'.repeat(100) + '\n')
    expect(Array.from(chunks[1]!).length).toBe(200)
    expect(chunks.join('')).toBe(text)
  })

  it('respects a custom cap', () => {
    expect(chunkText('abcdef', 4)).toEqual(['abcd', 'ef'])
  })
})

describe('stripStreamSuffix', () => {
  it('removes a trailing replying marker', () => {
    expect(stripStreamSuffix(`正文${STREAM_REPLYING_SUFFIX}`)).toBe('正文')
  })

  it('leaves text without the marker untouched', () => {
    expect(stripStreamSuffix('正文')).toBe('正文')
  })

  it('keeps interior marker text intact', () => {
    expect(stripStreamSuffix(`前面${STREAM_REPLYING_SUFFIX}后面`)).toBe(`前面${STREAM_REPLYING_SUFFIX}后面`)
  })
})

describe('statusStats', () => {
  it('counts user, assistant, and tool events and totals their display characters', () => {
    const stats = statusStats([
      { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } } as unknown as SessionEvent,
      { type: 'assistant/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '👋 hi' }] } } } as unknown as SessionEvent,
      { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'c-1', name: 'bash', arguments: '{"cmd":"ls"}' } } as unknown as SessionEvent,
    ])
    expect(stats).toEqual({
      users: 1,
      assistants: 1,
      tools: 1,
      // 你好 = 2 code points, 👋 hi = 4, the parsed-tail arguments JSON = 12.
      chars: 18,
    })
  })

  it('ignores every other event kind', () => {
    const stats = statusStats([
      { type: 'tool/result', seq: 0, time: 0, data: { turn: 1, step: 1, message: {} } } as unknown as SessionEvent,
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 0, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent,
    ])
    expect(stats).toEqual({ users: 0, assistants: 0, tools: 0, chars: 0 })
  })

  it('does not count workspace-instruction context as users or characters', () => {
    const stats = statusStats([
      instructionEvent('<system-reminder>…'),
      { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } } as unknown as SessionEvent,
    ])
    expect(stats).toEqual({ users: 1, assistants: 0, tools: 0, chars: 2 })
  })
})

describe('workspaceRow', () => {
  it('renders the title, path, and accounted session count', () => {
    const row = workspaceRow(1, {
      workspaceId: 'ws-1' as WorkspaceView['workspaceId'],
      path: '/srv/data-hub',
      title: '数据中台',
      sessionIds: [SessionId('a'), SessionId('b')],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(row).toBe('1) 📁 数据中台\n   /srv/data-hub · 2 个会话')
  })
})

describe('workspaceKeyboardRows', () => {
  it('emits the action rows first, then create buttons and the ungrouped row', () => {
    const rows = workspaceKeyboardRows([workspaceRowItem({ workspaceId: 'ws-1', title: '项目A' }), workspaceRowItem({ workspaceId: 'ws-2', title: '项目B' })])
    expect(rows).toEqual([
      ...KEYBOARD_ACTION_ROWS.map(row => [...row]),
      ['/new 1 · 项目A'],
      ['/new 2 · 项目B'],
      [CREATE_UNGROUPED_LABEL],
    ])
  })

  it('caps the buttons at 15 and keeps every button within 64 chars', () => {
    const items = Array.from({ length: 20 }, (_, index) => workspaceRowItem({ title: `工作区${index}` }))
    const rows = workspaceKeyboardRows(items)
    expect(rows.length).toBe(WORKSPACE_KEYBOARD_MAX + 3)
    let buttons = 0
    for (const row of rows) {
      for (const button of row) {
        buttons++
        expect(Array.from(button).length).toBeLessThanOrEqual(64)
      }
    }
    expect(buttons).toBe(21)
  })
})

describe('attachScopeButtons', () => {
  it('emits one workspace button per workspace, then ungrouped and archived when non-empty', () => {
    const rows = attachScopeButtons(
      [workspaceRowItem({ workspaceId: 'ws-1', title: '项目A' }), workspaceRowItem({ workspaceId: 'ws-2', title: '项目B' })],
      { ungrouped: true, archived: true },
    )
    expect(rows).toEqual([
      [{ text: '📁 项目A', data: 'atw:ws-1' }],
      [{ text: '📁 项目B', data: 'atw:ws-2' }],
      [{ text: '未分组', data: 'atn:1' }],
      [{ text: '归档', data: 'ata:1' }],
    ])
  })

  it('omits the ungrouped and archived rows when their buckets are empty', () => {
    const rows = attachScopeButtons(
      [workspaceRowItem({ workspaceId: 'ws-1', title: '项目A' })],
      { ungrouped: false, archived: false },
    )
    expect(rows).toEqual([[{ text: '📁 项目A', data: 'atw:ws-1' }]])
  })

  it('caps the workspace buttons at WORKSPACE_KEYBOARD_MAX', () => {
    const items = Array.from({ length: 20 }, (_, index) => workspaceRowItem({ title: `工作区${index}` }))
    const rows = attachScopeButtons(items, { ungrouped: true, archived: true })
    expect(rows.length).toBe(WORKSPACE_KEYBOARD_MAX + 2)
  })
})

describe('attachSessionButtons', () => {
  it('emits one bind button per visible session with its full title', () => {
    const items = [
      summary({
        sessionId: SessionId('11111111-2222-3333-4444-555555555555'),
        projections: { asOfSeq: 0, values: { title: '会话甲' } },
        running: true,
      }),
      summary({ sessionId: SessionId('66666666-7777-8888-9999-000000000000'), projections: { asOfSeq: 0, values: { title: '会话乙' } } }),
    ]
    expect(attachSessionButtons(items)).toEqual([
      [{ text: '🟢 会话甲', data: attachSessionData(SessionId('11111111-2222-3333-4444-555555555555')) }],
      [{ text: '✅ 会话乙', data: attachSessionData(SessionId('66666666-7777-8888-9999-000000000000')) }],
    ])
  })

  it('caps the buttons at SESSION_KEYBOARD_MAX', () => {
    const items = Array.from({ length: 20 }, (_, index) => summary({ projections: { asOfSeq: 0, values: { title: `会话${index}` } } }))
    expect(attachSessionButtons(items).length).toBe(SESSION_KEYBOARD_MAX)
  })
})

describe('parseAttachCallback', () => {
  it('decodes workspace, ungrouped, archived, and session tokens', () => {
    expect(parseAttachCallback('atw:ws-1')).toEqual({ kind: 'workspace', workspaceId: 'ws-1' })
    expect(parseAttachCallback('atn:1')).toEqual({ kind: 'ungrouped' })
    expect(parseAttachCallback('ata:1')).toEqual({ kind: 'archived' })
    expect(parseAttachCallback('ats:11111111-2222-3333-4444-555555555555')).toEqual({
      kind: 'session',
      sessionId: SessionId('11111111-2222-3333-4444-555555555555'),
    })
  })

  it('rejects foreign, empty, and malformed tokens', () => {
    expect(parseAttachCallback('qo:abc:0:0')).toBeUndefined()
    expect(parseAttachCallback('atw:')).toBeUndefined()
    expect(parseAttachCallback('atw:ws-1:extra')).toBeUndefined()
    expect(parseAttachCallback('atn:2')).toBeUndefined()
    expect(parseAttachCallback('ats:')).toBeUndefined()
    expect(parseAttachCallback('')).toBeUndefined()
  })
})

describe('session action-list inline surface', () => {
  it('decodes stop and status tokens', () => {
    expect(parseSessionListCallback('stp:11111111-2222-3333-4444-555555555555')).toEqual({
      kind: 'stop',
      sessionId: SessionId('11111111-2222-3333-4444-555555555555'),
    })
    expect(parseSessionListCallback('sta:11111111-2222-3333-4444-555555555555')).toEqual({
      kind: 'status',
      sessionId: SessionId('11111111-2222-3333-4444-555555555555'),
    })
  })

  it('rejects foreign, empty, and malformed tokens', () => {
    expect(parseSessionListCallback('qo:abc:0:0')).toBeUndefined()
    expect(parseSessionListCallback('stp:')).toBeUndefined()
    expect(parseSessionListCallback('stp:11111111-2222-3333-4444-555555555555:x')).toBeUndefined()
    expect(parseSessionListCallback('')).toBeUndefined()
  })

  it('emits one stop button per session with the action glyph and full title', () => {
    const rows = sessionActionButtons([
      summary({ projections: { asOfSeq: 0, values: { title: '会话甲' } } }),
      summary({ cwd: '/w/b' }),
    ], 'stop')
    expect(rows).toEqual([
      [{ text: '⏹ ✅ 会话甲', data: sessionStopData(SessionId('11111111-2222-3333-4444-555555555555')) }],
      [{ text: '⏹ ✅ /w/b', data: sessionStopData(SessionId('11111111-2222-3333-4444-555555555555')) }],
    ])
  })

  it('emits status buttons with the status glyph', () => {
    const rows = sessionActionButtons([summary({ projections: { asOfSeq: 0, values: { title: '会话甲' } } })], 'status')
    expect(rows[0]).toEqual([{ text: '📊 ✅ 会话甲', data: sessionStatusData(SessionId('11111111-2222-3333-4444-555555555555')) }])
  })

  it('caps the buttons at the session-keyboard limit', () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      summary({ projections: { asOfSeq: 0, values: { title: `标题${index}` } } }))
    expect(sessionActionButtons(items, 'stop').length).toBe(SESSION_KEYBOARD_MAX)
  })
})

describe('sessionKeyboardRows', () => {
  it('emits the shared action rows first, then one finished command button per session', () => {
    const rows = sessionKeyboardRows([
      summary({ projections: { asOfSeq: 0, values: { title: '会话甲' } } }),
      summary({ cwd: '/w/b' }),
      summary({}),
    ], 'open')
    expect(rows).toEqual([
      ...KEYBOARD_ACTION_ROWS.map(row => [...row]),
      ['/open 1 · ✅ 会话甲'],
      ['/open 2 · ✅ /w/b'],
      ['/open 3 · ✅ 11111111…55'],
    ])
  })

  it('uses the given verb verbatim', () => {
    expect(sessionKeyboardRows([summary({})], 'view')[2]).toEqual(['/view 1 · ✅ 11111111…55'])
    expect(sessionKeyboardRows([summary({})], 'attach')[2]).toEqual(['/attach 1 · ✅ 11111111…55'])
  })

  it('caps the buttons at 15 and keeps every button within 64 chars', () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      summary({ projections: { asOfSeq: 0, values: { title: `标题${index}` } } }))
    const rows = sessionKeyboardRows(items, 'open')
    expect(rows.length).toBe(SESSION_KEYBOARD_MAX + 2)
    let buttons = 0
    for (const row of rows) {
      for (const button of row) {
        buttons++
        expect(Array.from(button).length).toBeLessThanOrEqual(64)
      }
    }
    expect(buttons).toBe(20)
  })
})

describe('attachKeyboardRows', () => {
  it('emits the action rows first, then one bind button per listed session', () => {
    const rows = attachKeyboardRows([
      summary({ running: true, projections: { asOfSeq: 0, values: { title: '运行甲' } } }),
      summary({ projections: { asOfSeq: 0, values: { title: '完成乙' } } }),
    ])
    expect(rows).toEqual([
      ...KEYBOARD_ACTION_ROWS.map(row => [...row]),
      ['/attach 1 · 🟢 运行甲'],
      ['/attach 2 · ✅ 完成乙'],
    ])
  })

  it('carries no cap: every listed session gets a button', () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      summary({ projections: { asOfSeq: 0, values: { title: '标题' + index } } }))
    const rows = attachKeyboardRows(items)
    expect(rows.length).toBe(22)
    let buttons = 0
    for (const row of rows) {
      for (const button of row) {
        buttons++
        expect(Array.from(button).length).toBeLessThanOrEqual(64)
      }
    }
    expect(buttons).toBe(25)
  })
})

describe('keyboard button budget', () => {
  it('prefixes every session button with its status glyph and keeps the full title', () => {
    const items = Array.from({ length: SESSION_KEYBOARD_MAX }, (_, index) =>
      summary({ projections: { asOfSeq: 0, values: { title: `很长很长的会话标题${index}` } } }))
    for (const verb of ['attach', 'stop', 'status', 'delete']) {
      const rows = sessionKeyboardRows(items, verb)
      for (let index = 0; index < SESSION_KEYBOARD_MAX; index++) {
        expect(rows[index + 2]?.[0]).toBe(`/${verb} ${index + 1} · ✅ 很长很长的会话标题${index}`)
      }
    }
  })

  it('keeps every workspace button at or below 20 code points at the two-digit index', () => {
    const items = Array.from({ length: WORKSPACE_KEYBOARD_MAX }, (_, index) => ({
      workspaceId: `ws-${index}` as WorkspaceView['workspaceId'],
      title: `很长很长的工作区标题${index}`,
      path: '/srv/x',
      sessionIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
    for (const row of workspaceKeyboardRows(items)) {
      for (const button of row) {
        expect(Array.from(button).length, button).toBeLessThanOrEqual(20)
      }
    }
  })
})

describe('renderTodoList', () => {
  it('renders the status summary and one glyph-per-status row', () => {
    const todos = [
      { content: '拉取数据', status: 'completed' },
      { content: '写报告', status: 'in_progress' },
      { content: '发邮件', status: 'pending' },
    ] as const
    expect(renderTodoList(todos)).toBe(
      '📋 任务 1 已完成 · 1 进行中 · 1 待处理\n\n1) ✅ 拉取数据\n2) 🔄 写报告\n3) ⬜ 发邮件',
    )
  })

  it('counts zero states and truncates long content', () => {
    const long = '很长的任务内容'.repeat(20)
    const out = renderTodoList([{ content: long, status: 'pending' }])
    expect(out).toContain('📋 任务 0 已完成 · 0 进行中 · 1 待处理')
    expect(out).toContain(`⬜ ${long.slice(0, SESSION_TITLE_MAX)}…`)
  })
})

describe('todoRow', () => {
  it('maps each lifecycle status to its glyph', () => {
    expect(todoRow(1, { content: 'a', status: 'completed' })).toBe('1) ✅ a')
    expect(todoRow(2, { content: 'b', status: 'in_progress' })).toBe('2) 🔄 b')
    expect(todoRow(3, { content: 'c', status: 'pending' })).toBe('3) ⬜ c')
  })
})

describe('lastTodoWrite', () => {
  it('returns the latest whole snapshot and null without one', () => {
    const first = { content: '甲', status: 'pending' }
    const second = { content: '乙', status: 'completed' }
    const events: SessionEvent[] = [
      { type: 'todo/write', time: 1, seq: 1, data: { todos: [first] } } as SessionEvent,
      { type: 'assistant/message', time: 2, seq: 2, data: {} as never } as SessionEvent,
      { type: 'todo/write', time: 3, seq: 3, data: { todos: [second] } } as SessionEvent,
    ]
    expect(lastTodoWrite(events)).toEqual([second])
    expect(lastTodoWrite([])).toBeNull()
    expect(lastTodoWrite([{ type: 'turn/end', time: 1, seq: 1, data: {} as never } as SessionEvent])).toBeNull()
  })
})

describe('presetKeyboardRows', () => {
  const entry = (id: string, name?: string) =>
    ({ id, ...(name === undefined ? {} : { name }), trust: 'system' as const, isDefault: false })

  it('emits the action rows first, then one button per preset', () => {
    const rows = presetKeyboardRows([entry('standard', '标准模式'), entry('ptc'), entry('minimal', '极简模式')])
    expect(rows).toEqual([
      ...KEYBOARD_ACTION_ROWS.map(row => [...row]),
      ['/preset 1 · 标准模式'],
      ['/preset 2 · ptc'],
      ['/preset 3 · 极简模式'],
    ])
  })

  it('caps the buttons and truncates long display names', () => {
    const items = Array.from({ length: 20 }, (_, index) => entry(`p${index}`, `很长很长的模式名${index}`))
    const rows = presetKeyboardRows(items)
    expect(rows.length).toBe(PRESET_KEYBOARD_MAX + 2)
    expect(rows[2]?.[0]).toContain('…')
  })
})

// Constants are exported for the console to reuse; keep them honest.
describe('surface constants', () => {
  it('stays within Telegram message limits', () => {
    expect(TELEGRAM_CHUNK_MAX).toBeLessThan(4096)
  })

  it('keeps the Telegram version in semver form', () => {
    expect(TELEGRAM_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('question rendering', () => {
  const single = [
    { id: 'q1', question: '改哪个模块？', options: [{ label: 'core' }, { label: 'web' }] },
  ]
  const rpcId = '11111111-2222-4333-8444-555555555555'

  it('renders a single-question text without numbering or footer', () => {
    expect(questionMessageText(single)).toBe('❓ 改哪个模块？')
    expect(questionMessageText(single)).not.toContain('【1】')
    expect(questionMessageText(single)).not.toContain('提交回答')
  })

  it('renders header, detail, and the multi-select hint', () => {
    const withDetail = [{
      id: 'q2', header: '计划评审', question: '批准这份计划吗？', detail: '详见 #计划', multiSelect: true,
    }]
    expect(questionMessageText(withDetail)).toBe('❓ 计划评审\n批准这份计划吗？\n详见 #计划\n（可多选）')
    expect(questionMessageText([{ id: 'q3', question: '纯文本' }])).toBe('❓ 纯文本')
  })

  it('numbers multi-question batches and appends the submit footer', () => {
    const two = [
      { id: 'q1', question: '改哪个模块？' },
      { id: 'q2', question: '改哪里？', options: [{ label: 'src' }] },
    ]
    expect(questionMessageText(two)).toContain('【1】\n❓ 改哪个模块？')
    expect(questionMessageText(two)).toContain('【2】\n❓ 改哪里？')
    expect(questionMessageText(two)).toContain('全部回答后点「✅ 提交回答」。')
  })

  it('lays out one row per option, custom per question, then submit and cancel', () => {
    const rows = questionKeyboard(single, [['core']], [undefined], rpcId)
    expect(rows).toEqual([
      [{ text: '✅ core', data: questionOptionData(rpcId, 0, 0) }],
      [{ text: 'web', data: questionOptionData(rpcId, 0, 1) }],
      [{ text: '✍️ 自定义回答', data: questionCustomData(rpcId, 0) }],
      [{ text: '✅ 提交回答', data: questionSubmitData(rpcId) }],
      [{ text: '🚫 取消', data: questionCancelData(rpcId) }],
    ])
  })

  it('prefixes question numbers and custom-done labels in multi-question batches', () => {
    const two = [
      { id: 'q1', question: '改哪个模块？', options: [{ label: 'core' }] },
      { id: 'q2', question: '改哪里？', options: [{ label: 'src' }] },
    ]
    const rows = questionKeyboard(two, [], ['说明', undefined], rpcId)
    expect(rows).toEqual([
      [{ text: '1. core', data: questionOptionData(rpcId, 0, 0) }],
      [{ text: '✍️ 重输 Q1', data: questionCustomData(rpcId, 0) }],
      [{ text: '2. src', data: questionOptionData(rpcId, 1, 0) }],
      [{ text: '✍️ 自定义 Q2', data: questionCustomData(rpcId, 1) }],
      [{ text: '✅ 提交回答', data: questionSubmitData(rpcId) }],
      [{ text: '🚫 取消', data: questionCancelData(rpcId) }],
    ])
  })

  it('shows the custom-done label once a single-question custom answer exists', () => {
    const rows = questionKeyboard(single, [], ['说明'], rpcId)
    expect(rows[2]).toEqual([{ text: '✍️ 重新输入回答', data: questionCustomData(rpcId, 0) }])
  })

  it('lays out a text-only question with just the custom and action rows', () => {
    const rows = questionKeyboard([{ id: 'q9', question: '自由回答' }], [[]], [undefined], rpcId)
    expect(rows).toEqual([
      [{ text: '✍️ 自定义回答', data: questionCustomData(rpcId, 0) }],
      [{ text: '✅ 提交回答', data: questionSubmitData(rpcId) }],
      [{ text: '🚫 取消', data: questionCancelData(rpcId) }],
    ])
  })

  it('parses every callback kind back from its data', () => {
    expect(parseQuestionCallback(questionOptionData(rpcId, 2, 3)))
      .toEqual({ kind: 'option', rpcId, questionIndex: 2, optionIndex: 3 })
    expect(parseQuestionCallback(questionCustomData(rpcId, 1)))
      .toEqual({ kind: 'custom', rpcId, questionIndex: 1 })
    expect(parseQuestionCallback(questionSubmitData(rpcId)))
      .toEqual({ kind: 'submit', rpcId })
    expect(parseQuestionCallback(questionCancelData(rpcId)))
      .toEqual({ kind: 'cancel', rpcId })
  })

  it('rejects malformed or foreign callback data', () => {
    expect(parseQuestionCallback('')).toBeUndefined()
    expect(parseQuestionCallback('qo:')).toBeUndefined()
    expect(parseQuestionCallback('qo:rpc-only')).toBeUndefined()
    expect(parseQuestionCallback('qo:rpc:abc:0')).toBeUndefined()
    expect(parseQuestionCallback('qo:rpc:0:abc')).toBeUndefined()
    expect(parseQuestionCallback('qo:rpc:1:2:3')).toBeUndefined()
    expect(parseQuestionCallback('qt:rpc')).toBeUndefined()
    expect(parseQuestionCallback('qt:rpc:x')).toBeUndefined()
    expect(parseQuestionCallback('qx:rpc:extra')).toBeUndefined()
    expect(parseQuestionCallback('xx:rpc')).toBeUndefined()
    expect(parseQuestionCallback('qs:rpc:extra')).toBeUndefined()
    expect(parseQuestionCallback('qc:rpc')).toBeUndefined()
    expect(parseQuestionCallback('qo:rpc:99999999999999999999:0')).toBeUndefined()
  })
})

describe('turn usage footer', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
    expect(escapeHtml('中文与 emoji 🚀 不受影响')).toBe('中文与 emoji 🚀 不受影响')
  })

  it('starts every turn at zero', () => {
    expect(emptyRoundUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('skips steps without usage and folds the disjoint fields', () => {
    const usage = emptyRoundUsage()
    accumulateRoundUsage(usage, undefined)
    expect(usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    accumulateRoundUsage(usage, { inputTokens: 10, outputTokens: 20 })
    accumulateRoundUsage(usage, { inputTokens: 5, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 })
    expect(usage).toEqual({ input: 15, output: 27, cacheRead: 3, cacheWrite: 2 })
  })

  it('compacts token counts with a k suffix only from 1000', () => {
    expect(compactTokenCount(0)).toBe('0')
    expect(compactTokenCount(999)).toBe('999')
    expect(compactTokenCount(1_000)).toBe('1k')
    expect(compactTokenCount(1_234)).toBe('1.2k')
    expect(compactTokenCount(12_000)).toBe('12k')
  })

  it('renders nothing for a turn without token accounting', () => {
    expect(roundUsageFooter(emptyRoundUsage())).toBe('')
  })

  it('renders the consumption and the cache-hit rate', () => {
    const usage = emptyRoundUsage()
    accumulateRoundUsage(usage, {
      inputTokens: 4_000, outputTokens: 300, cacheReadTokens: 6_000,
    })
    expect(roundUsageFooter(usage)).toBe('\n\n<pre>⚡ 本轮: ↑4k ↓300 · 缓存命中 60%</pre>')
  })

  it('reports the cache-write volume when the provider wrote a new cache entry', () => {
    const usage = emptyRoundUsage()
    accumulateRoundUsage(usage, { inputTokens: 500, outputTokens: 0, cacheWriteTokens: 2_500 })
    expect(roundUsageFooter(usage)).toBe('\n\n<pre>⚡ 本轮: ↑500 ↓0 · 缓存写 2.5k</pre>')
  })
})
