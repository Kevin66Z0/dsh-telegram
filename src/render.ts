/**
 * Pure text rendering for the Telegram surface: session rows, history lines,
 * turn outcomes, and Telegram-safe chunking. No I/O here — every function is
 * a deterministic projection of its inputs so the console logic stays testable
 * without a transport.
 * @module @deepseek-ai/dsh-host-telegram/render
 */

import type { AssistantMessage, ContentBlock, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TodoItem, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AgentPresetEntry, SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/**
 * The Telegram console's user-visible version, printed by `/status` so a
 * restart is verifiable at a glance. Bump per AGENTS.md: a bugfix adds 0.0.1,
 * a feature adds 0.1; a batch of several items still adds at most 0.1 total
 * (a minor mixed batch may add 0.01).
 */
export const TELEGRAM_VERSION = '1.9.2'
/** Hard byte-ish ceiling for one Telegram message; stay under the 4096 limit. */
export const TELEGRAM_CHUNK_MAX = 3500
/** Queued-prompt acknowledgement caps the echoed text at this many code points. */
export const QUEUE_ACK_MAX = 200
/** Row-title truncation for workspace and todo rows. */
export const SESSION_TITLE_MAX = 48
/** Tool-call argument-brief truncation. */
export const TOOL_ARGS_MAX = 80
/** Reasoning (Think) brief truncation in code points. */
export const REASONING_BRIEF_MAX = 120
/** History lines fed to /status and /attach's last-dialogue preview. */
export const HISTORY_DEFAULT_LIMIT = 20
/** Main-content cap for /status assistant output; the aux lines stay the signal, the text is a preview. */
export const STATUS_MAIN_MAX = 400
/** Reply-keyboard sessions capped at the rows a bot can usefully show. */
export const SESSION_KEYBOARD_MAX = 15
/**
 * Title inside a workspace or preset button; the worst-case button
 * (`/attach <n> · <title>…` or `/preset <n> · <name>…`) stays within 20 code
 * points, so the button holds one line on the narrowest phones that render
 * the reply keyboard.
 */
export const SESSION_KEYBOARD_TITLE_MAX = 6
/** Reply-keyboard workspaces capped like the session rows. */
export const WORKSPACE_KEYBOARD_MAX = 15
/**
 * Title inside a workspace button; worst case (`/new <n> · <title>…`) fits one
 * line like the session buttons.
 */
export const WORKSPACE_KEYBOARD_TITLE_MAX = 8
/** The reply-keyboard label that creates an ungrouped (no-workspace) session. */
export const CREATE_UNGROUPED_LABEL = '/new none · 未分类'
/**
 * The shared action rows every keyboard carries, rendered first. The first row
 * pins the three reach-it-by-button commands: `/create` (the `/new` / `/fork`
 * sub-menu), `/archive` (archive the bound session), and `/attach` (binding
 * entry). The second row carries `/stop` (cancel the bound session's active
 * turn — unbound, the inline stop list) and `/close` (dismiss the keyboard).
 * `/operate` left the row — typing still opens its `/archive`, `/stop`,
 * `/curTasks` sub-menu, and `/archive` now doubles as the direct button.
 * `/model` and `/preset` deliberately stay off: selecting replaces the
 * keyboard with the corresponding picker, so both are reached by typing or the
 * `/` menu. `/sessions` is gone: /attach owns listing every scope (workspace,
 * ungrouped, archived). `/help` is gone: /start prints the same help.
 */
export const KEYBOARD_ACTION_ROWS: string[][] = [
  ['/create', '/archive', '/attach'],
  ['/stop', '/close'],
]
/**
 * State legend for session lists: the glyph meanings at a glance.
 * @see sessionRow
 */
export const SESSION_STATE_LEGEND = '🟢 执行中 · ✅ 已完成 · ⚪ 未开始'
/**
 * Suffix appended to in-flight stream edits while a turn is still running, so
 * the reader always sees the reply is not final; removed by the turn/end edit.
 */
export const STREAM_REPLYING_SUFFIX = '\n\n⏳ 回复中…'
/** Role glyph a rendered assistant line starts with. */
export const ASSISTANT_ROLE_GLYPH = '🤖'

/**
 * Cap a string to `max` code points, appending an ellipsis when truncated.
 * @param text - the input text.
 * @param max - the maximum kept code points.
 * @returns the possibly-ellipsized text.
 */
export function truncate(text: string, max: number): string {
  const points = Array.from(text)
  return points.length > max ? `${points.slice(0, max).join('')}…` : text
}

/**
 * Human-ish relative timestamp.
 * @param timestamp - Unix epoch milliseconds.
 * @param now - the current epoch millisecond clock (pure injection).
 * @returns a label like `刚刚`, `5 分钟前`, or `2 天前`.
 */
export function timeAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/**
 * Absolute start-time clock, date-aware like the Web surface: same-day
 * `HH:mm:ss`, same-year `MM-DD HH:mm:ss`, and `YYYY-MM-DD HH:mm:ss` across
 * years. Seconds are always shown; the day/year cut reads `now` (pure clock
 * injection) so tests stay deterministic.
 * @param ms - the start-time Unix epoch milliseconds.
 * @param now - the current Unix epoch millisecond clock.
 * @returns the zero-padded clock without surrounding parens.
 */
export function formatStartClock(ms: number, now: number): string {
  const d = new Date(ms)
  const hhmmss = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  const ref = new Date(now)
  const sameDay = d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate()
  if (sameDay) return hhmmss
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (d.getFullYear() === ref.getFullYear()) return `${mmdd} ${hhmmss}`
  return `${d.getFullYear()}-${mmdd} ${hhmmss}`
}

/**
 * The {@link formatStartClock} value wrapped in full-width parens, as shown
 * before a tool-call step line or above an assistant reply.
 * @param ms - the start-time Unix epoch milliseconds.
 * @param now - the current Unix epoch millisecond clock.
 * @returns `（…）` around the clock.
 */
export function startClockLabel(ms: number, now: number): string {
  return `（${formatStartClock(ms, now)}）`
}

/**
 * Short display form of a session id: `xxxxxxxx…xx`.
 * @param id - the full session id.
 * @returns the shortened id.
 */
export function shortSessionId(id: SessionId): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-2)}`
}

/**
 * Concatenate the display text of a content block list, skipping non-text
 * blocks (unknown merge-extensible types carry no display text for this
 * surface).
 * @param content - the message content blocks.
 * @returns the trimmed plain text.
 */
export function blockText(content: readonly ContentBlock[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text') out += block.text
  }
  return out.trim()
}

/**
 * Text of one human user message, or empty when the message carries none.
 * @param message - the user message.
 * @returns the trimmed text of the message's text blocks.
 */
export function userMessageText(message: UserMessage): string {
  return blockText(message.content)
}

/**
 * Whether a logged user-message source is a workspace-instruction context
 * (`source.kind === 'agent-instructions'`). Such messages are model-visible
 * context produced by the harness, never human input: this surface skips them
 * in realtime push, history previews, and status statistics, while the session
 * log and model context stay untouched.
 * @param source - the logged user-message source.
 * @returns true for the workspace-instruction source kind.
 */
export function isWorkspaceInstructionSource(source: { kind: string }): boolean {
  return source.kind === 'agent-instructions'
}

/**
 * Text of one assembled assistant message, or empty when the step spoke no text.
 * @param message - the assistant message.
 * @returns the trimmed text of the message's text blocks.
 */
export function assistantMessageText(message: AssistantMessage): string {
  return blockText(message.content)
}

/**
 * Brief form of one tool call's arguments: the first value of the leading
 * object entries, or the raw JSON when unparseable, ellipsized to
 * {@link TOOL_ARGS_MAX} code points. The tool name is not included.
 * @param raw - the model-produced arguments JSON string.
 * @returns the argument brief.
 */
export function toolArgBrief(raw: string): string {
  let brief = raw
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const first = Object.values(parsed as Record<string, unknown>)[0]
      if (typeof first === 'string') brief = first
      else if (first !== undefined) brief = JSON.stringify(first)
    }
  } catch {
    brief = raw
  }
  return truncate(brief, TOOL_ARGS_MAX)
}

/**
 * Brief inline form of a tool invocation: `name(brief)` where `brief` is
 * {@link toolArgBrief}.
 * @param name - the tool name.
 * @param raw - the model-produced arguments JSON string.
 * @returns the brief, ellipsized to {@link TOOL_ARGS_MAX} code points.
 */
export function toolCallBrief(name: string, raw: string): string {
  return `${name}(${toolArgBrief(raw)})`
}

/**
 * Brief one-line form of a reasoning pass: whitespace collapsed, ellipsized
 * to {@link REASONING_BRIEF_MAX} code points.
 * @param text - the reasoning block text.
 * @returns the brief ('' for blank input).
 */
export function reasoningBrief(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), REASONING_BRIEF_MAX)
}

/** Display prefix of a reasoning action line. */
export const REASONING_ACTION_LABEL = '💭 Think'
/** Display prefix of a tool-call action line. */
export const TOOL_ACTION_LABEL = '🔧'

/**
 * One model-step action rendered as a display line: a reasoning pass or a
 * tool call, each on its own line (mirrors the web's per-action rows).
 */
export interface StepAction {
  /** The `assistant/message` event time (Unix epoch milliseconds). */
  time: number
  /** The display line: `💭 Think — brief` or `🔧 name — brief`. */
  line: string
}

/**
 * The per-action lines of one assistant message, in content order. Each
 * `reasoning` block renders a `💭 Think — brief` line and each `tool-call`
 * block a `🔧 name — brief` line; text and other blocks are skipped (the
 * reply body renders separately).
 * @param message - the assistant message.
 * @param time - the message event time, stamped on every action.
 * @returns the action lines (empty when the step reasoned and called nothing).
 */
export function messageActions(message: AssistantMessage, time: number): StepAction[] {
  const actions: StepAction[] = []
  for (const block of message.content) {
    if (block.type === 'reasoning') {
      const brief = reasoningBrief(block.text)
      if (brief !== '') actions.push({ time, line: `${REASONING_ACTION_LABEL} — ${brief}` })
    } else if (block.type === 'tool-call') {
      actions.push({ time, line: `${TOOL_ACTION_LABEL} ${block.name} — ${toolArgBrief(block.arguments)}` })
    }
  }
  return actions
}

/**
 * Human label for {@link TurnEndReason}; the Chinese wording is dropped in
 * favor of an English one-word hint so the outcome reads without the local
 * language. Unknown merge-extensible kinds fall back to their raw kind name.
 * @param reason - the turn outcome.
 * @returns the label glyph plus wording.
 */
export function turnEndLabel(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed': return '✅ done'
    case 'aborted': return '⏹ stopped'
    case 'blocked': return '⛔ blocked'
    case 'error': return '❌ failed'
    case 'max-tokens': return '⏳ max tokens'
    case 'interrupted': return '⏸ interrupted'
    default:
      // TurnEndReasonMap is merge-extensible: kinds added by plugins land
      // here after the closed-set cases above.
      return `⏹ ${(reason as { kind: string }).kind}`
  }
}

// ── turn token-usage footer ─────────────────────────────────────────────────

/** Escaping for Telegram's HTML parse mode (required before any `&`, `<`, or `>`). */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * The token accounting one turn accumulates from its step usage records
 * (`assistant/message` event `usage` fields). Counts are disjoint, mirroring
 * {@link TokenUsage}: cache reads/writes are separate from the plain input.
 */
export interface RoundUsage {
  /** Uncached input tokens (all steps). */
  input: number
  /** Output tokens (all steps). */
  output: number
  /** Tokens served from the provider's prompt cache. */
  cacheRead: number
  /** Tokens written into the provider's prompt cache. */
  cacheWrite: number
}

/** The zero pointer for {@link RoundUsage}. */
export function emptyRoundUsage(): RoundUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/**
 * Fold one step's token usage into the turn accumulator, skipping records
 * without accounting (`undefined`).
 * @param usage - the turn accumulator to mutate.
 * @param step - one step's usage, or undefined when the adapter reported none.
 */
export function accumulateRoundUsage(usage: RoundUsage, step: TokenUsage | undefined): void {
  if (step === undefined) return
  usage.input += step.inputTokens
  usage.output += step.outputTokens
  usage.cacheRead += step.cacheReadTokens ?? 0
  usage.cacheWrite += step.cacheWriteTokens ?? 0
}

/**
 * Compact token count for the footer: plain below 1000, `k` suffix above
 * with at most one decimal (JavaScript number formatting drops a trailing
 * `.0` itself).
 * @param count - a non-negative token count.
 * @returns the compact label.
 */
export function compactTokenCount(count: number): string {
  if (count < 1000) return String(count)
  const oneDecimal = Math.round((count / 1000) * 10) / 10
  return `${oneDecimal}k`
}

/**
 * The small HTML footer appended to a turn's final message: this round's
 * token consumption (↑ input, ↓ output) plus the cache-hit percentage and
 * cache writes when the provider reported them. Rendered as a `<pre>` block
 * so Telegram draws it smaller and monospace. Empty when the turn carried no
 * token accounting at all.
 * @param usage - the turn's accumulated usage.
 * @returns the HTML footer, or an empty string when there is nothing to report.
 */
export function roundUsageFooter(usage: RoundUsage): string {
  const parts: string[] = []
  if (usage.input > 0 || usage.output > 0) {
    parts.push(`↑${compactTokenCount(usage.input)} ↓${compactTokenCount(usage.output)}`)
  }
  if (usage.cacheRead > 0) {
    const hitRate = Math.round((usage.cacheRead / (usage.cacheRead + usage.input)) * 100)
    parts.push(`缓存命中 ${hitRate}%`)
  }
  if (usage.cacheWrite > 0) {
    parts.push(`缓存写 ${compactTokenCount(usage.cacheWrite)}`)
  }
  if (parts.length === 0) return ''
  return `\n\n<pre>⚡ 本轮: ${parts.join(' · ')}</pre>`
}

/**
 * The token accounting of the history page's last completed turn: the
 * `assistant/message` usage records between its `turn/start` and `turn/end`.
 * Empty when the page's latest turn is still open (no `turn/end` after its
 * `turn/start`) or the turn boundary falls outside the page window — a
 * bounded page cannot attribute usage it cannot see. This is the static
 * counterpart of the live `turnUsage` accumulator, so an attach preview of a
 * finished session can close with the same token footer a streamed turn ends
 * with.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the last completed turn's accumulated usage.
 */
export function lastTurnUsage(events: readonly SessionEvent[]): RoundUsage {
  let startIndex = -1
  let endIndex = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'turn/start') startIndex = index
    else if (event?.type === 'turn/end') endIndex = index
  }
  if (startIndex === -1 || endIndex <= startIndex) return emptyRoundUsage()
  const usage = emptyRoundUsage()
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const event = events[index]
    if (event?.type === 'assistant/message') accumulateRoundUsage(usage, event.data.usage)
  }
  return usage
}

/**
 * The token accounting of the history page's still-open turn: the
 * `assistant/message` usage records after its last `turn/start` when no
 * `turn/end` follows it. Empty when the page's latest turn is closed or the
 * open turn's boundary falls outside the page window — a bounded page cannot
 * attribute usage it cannot see. This is the static counterpart of the live
 * `turnUsage` accumulator for an attach that joins mid-turn, so the turn's
 * end footer counts the steps that streamed before the chat bound.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the open turn's accumulated usage.
 */
export function openTurnUsage(events: readonly SessionEvent[]): RoundUsage {
  let startIndex = -1
  let endIndex = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'turn/start') startIndex = index
    else if (event?.type === 'turn/end') endIndex = index
  }
  if (startIndex === -1 || endIndex > startIndex) return emptyRoundUsage()
  const usage = emptyRoundUsage()
  for (let index = startIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'assistant/message') accumulateRoundUsage(usage, event.data.usage)
  }
  return usage
}

/**
 * The timestamp of the history page's latest `turn/start`, or undefined when
 * the page shows none. The attach preview's live-stream clock: a chat that
 * binds mid-turn stamps the first pushed reply with the turn's real start
 * time instead of the bind time.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the latest turn start time, or undefined.
 */
export function latestTurnStartTime(events: readonly SessionEvent[]): number | undefined {
  let time: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') time = event.time
  }
  return time
}

/**
 * The tri-state run glyph for one session summary: running 🟢, finished (has
 * turns, idle) ✅, blank ⚪.
 * @param summary - the session summary row.
 * @returns the status glyph.
 */
export function sessionGlyph(summary: SessionSummary): string {
  return summary.running ? '🟢' : summary.blank ? '⚪' : '✅'
}

/**
 * One list row: index, run glyph, title or cwd fallback, then a second line
 * with cwd, relative age, and the short session id.
 * @param index - 1-based row number, also the /attach selector.
 * @param summary - the session summary row.
 * @param now - current epoch millisecond clock (pure injection).
 * @returns the two-line row text.
 */
export function sessionRow(index: number, summary: SessionSummary, now: number): string {
  const title = summary.projections?.values.title ?? ''
  const heading = title !== '' ? title : (summary.cwd ?? shortSessionId(summary.sessionId))
  const cwd = summary.cwd ?? '（无目录）'
  const age = timeAgo(summary.updatedAt, now)
  return `${index}) ${sessionGlyph(summary)} ${heading}\n   ${cwd} · ${age} · ${shortSessionId(summary.sessionId)}`
}

/**
 * The last `rounds` non-empty assistant reply texts of a history page,
 * oldest first. Boundary/chunk events and user messages are skipped — this
 * surface shows the agent's side of the session only — and tool/outcome
 * events never render. The whole dialogue comes back when it has no more
 * replies than `rounds`; a blank log returns an empty array.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @param rounds - the number of assistant replies to keep.
 * @returns the kept assistant reply texts, unrendered (the caller renders).
 */
export function assistantTail(events: readonly SessionEvent[], rounds: number): string[] {
  const texts: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const text = assistantMessageText(event.data.message)
    if (text !== '') texts.push(text)
  }
  if (texts.length <= rounds) return texts
  return texts.slice(texts.length - rounds)
}

/**
 * The `/status` main line for a history page: the last assistant text, or the
 * pending tool call when the page's latest action is one, or a hint when the
 * page shows none. Tool liveness follows event-stream pairing: each
 * `tool/result` closes the most recent unclosed `tool/call` (results arrive
 * in step order, so the stack pairs correctly), and a `turn/end` settles
 * every outstanding call — an interrupted or aborted turn leaves no
 * in-progress tool. Assistant text is capped at {@link STATUS_MAIN_MAX} code
 * points so the preview stays a glance; the full turn text lives in the
 * realtime chat stream.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the main line, or the empty-session hint for a blank page.
 */
export function statusMainText(events: readonly SessionEvent[]): string {
  if (events.length === 0) return '（空白会话，还没有消息）'
  const openCalls: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'tool/call':
        openCalls.push(event.data.name)
        break
      case 'tool/result':
        openCalls.pop()
        break
      case 'turn/end':
        openCalls.length = 0
        break
      default:
        break
    }
  }
  const pending = openCalls.at(-1)
  if (pending !== undefined) return `🔧 工具调用中: ${pending}`
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const text = assistantMessageText(event.data.message)
    if (text === '') continue
    return `🤖 ${truncate(text, STATUS_MAIN_MAX)}`
  }
  return '（暂无输出）'
}

/**
 * The briefs of tool calls still open at the page tail: each `tool/call` with
 * no later `tool/result` in the same turn. A `turn/end` settles every open
 * call, so only an in-progress turn leaves calls open.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the brief of each open call, in call order.
 */
export function openToolCalls(events: readonly SessionEvent[]): string[] {
  const open: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'tool/call':
        open.push(toolCallBrief(event.data.name, event.data.arguments))
        break
      case 'tool/result':
        open.pop()
        break
      case 'turn/end':
        open.length = 0
        break
      default:
        break
    }
  }
  return open
}

/**
 * Whether a history page's latest turn is still running. The last
 * `turn/start`/`turn/end` boundary decides — a `turn/end` closes the turn for
 * any outcome, so a completed, aborted, or interrupted reply all count as
 * finished — and unpaired `tool/call` briefs fall back to open when a bounded
 * page (e.g. the attach read window) truncates a long turn so its `turn/start`
 * is not in the window. This is the attach counterpart of the live
 * {@link STREAM_REPLYING_SUFFIX}: both stay visible until the turn ends,
 * including while the model composes its reply text with no tool call open.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns true when the page's latest turn has not ended.
 */
export function turnOpen(events: readonly SessionEvent[]): boolean {
  let started = false
  for (const event of events) {
    if (event.type === 'turn/start') started = true
    else if (event.type === 'turn/end') started = false
  }
  return started || openToolCalls(events).length > 0
}

/**
 * The unanswered `question/asked` batches at the page tail: each asked id
 * with no later `question/decided` carrying the same id.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the open batches, in asked order.
 */
export function pendingAskBatches(events: readonly SessionEvent[]): { id: string; questions: AskUserQuestionItem[] }[] {
  const decided = new Set<string>()
  for (const event of events) {
    if (event.type === 'question/decided') decided.add(event.data.id)
  }
  const batches: { id: string; questions: AskUserQuestionItem[] }[] = []
  for (const event of events) {
    if (event.type === 'question/asked' && !decided.has(event.data.id)) {
      batches.push({ id: event.data.id, questions: event.data.questions })
    }
  }
  return batches
}

/**
 * The per-action lines of a history page, one line per reasoning pass or tool
 * call in content order, capped at the most recent {@link maxActions} lines.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @param maxActions - maximum number of action lines (most recent) to keep.
 * @returns the action lines, oldest first.
 */
export function stepActions(events: readonly SessionEvent[], maxActions = 20): StepAction[] {
  const actions: StepAction[] = []
  for (const event of events) {
    if (event.type === 'assistant/message') actions.push(...messageActions(event.data.message, event.time))
  }
  return actions.slice(-maxActions)
}

/**
 * The collapsible Telegram-HTML blockquote listing the given actions, one
 * time-stamped line per action, or '' when there are none.
 * @param actions - the action lines, oldest first.
 * @param now - the current Unix epoch millisecond clock (pure injection).
 * @returns the `<blockquote expandable>` fragment, or ''.
 */
export function actionsHtml(actions: readonly StepAction[], now: number): string {
  if (actions.length === 0) return ''
  const lines = actions.map(action => startClockLabel(action.time, now) + escapeHtml(action.line))
  return '<blockquote expandable>' + lines.join('\n') + '</blockquote>'
}

/**
 * The collapsible Telegram-HTML blockquote listing recent actions (one
 * time-stamped line per reasoning pass or tool call), or '' when the page has
 * none. Keeps a session's activity one expandable tap away instead of
 * flooding the attach preview.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @param now - the current Unix epoch millisecond clock (pure injection).
 * @param maxActions - maximum number of action lines (most recent) to include.
 * @returns the `<blockquote expandable>` fragment, or ''.
 */
export function stepActionsHtml(events: readonly SessionEvent[], now: number, maxActions = 20): string {
  return actionsHtml(stepActions(events, maxActions), now)
}

/**
 * Split long text into Telegram-safe chunks, preferring newline boundaries.
 * @param text - the full text.
 * @param cap - the maximum chunk length; defaults to {@link TELEGRAM_CHUNK_MAX}.
 * @returns one or more chunks within `cap`.
 */
export function chunkText(text: string, cap: number = TELEGRAM_CHUNK_MAX): string[] {
  const points = Array.from(text)
  if (points.length <= cap) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < points.length) {
    let end = Math.min(start + cap, points.length)
    // Back up to the last newline in the window when one exists and the
    // window is not the tail.
    if (end < points.length) {
      let lastNewline = -1
      for (let cursor = end - 1; cursor > start && end - cursor <= 200; cursor--) {
        if (points[cursor] === '\n') { lastNewline = cursor; break }
      }
      if (lastNewline !== -1) end = lastNewline + 1
    }
    chunks.push(points.slice(start, end).join(''))
    start = end
  }
  return chunks
}

/**
 * Remove the trailing replying marker from a stream edit's displayed text,
 * restoring the bare body for {@link STREAM_REPLYING_SUFFIX} consumers that
 * store what was shown (chunked overflow sends one chunk whole).
 * @param text - the displayed text, possibly ending with the marker.
 * @returns the text without a trailing marker.
 */
export function stripStreamSuffix(text: string): string {
  return text.endsWith(STREAM_REPLYING_SUFFIX) ? text.slice(0, -STREAM_REPLYING_SUFFIX.length) : text
}

/**
 * One /status page's usage statistics: a count per surface kind over `events`
 * plus the total display characters (user and assistant text blocks, tool-call
 * argument JSON — the text this surface renders, so the estimate matches the
 * visible transcript). Workspace-instruction context is not a human user
 * message, so it contributes neither a user count nor characters. The figures
 * anchor exactly to the passed page: the
 * caller reads a bounded history tail ({@link HISTORY_DEFAULT_LIMIT} message
 * quota), so they speak about that page only, never the whole session — the
 * /status layout prints the message count next to the estimate to make the
 * scope explicit.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns one count per surface kind and the character total.
 */
export function statusStats(events: readonly SessionEvent[]): {
  users: number
  assistants: number
  tools: number
  chars: number
} {
  let users = 0
  let assistants = 0
  let tools = 0
  let chars = 0
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        // Workspace-instruction context is not a human user message: it stays
        // out of the user count and the character estimate.
        if (isWorkspaceInstructionSource(event.data.source)) break
        users++
        chars += Array.from(userMessageText(event.data)).length
        break
      case 'assistant/message':
        assistants++
        chars += Array.from(assistantMessageText(event.data.message)).length
        break
      case 'tool/call':
        tools++
        chars += Array.from(event.data.arguments).length
        break
      default:
        break
    }
  }
  return { users, assistants, tools, chars }
}

/**
 * Reply-keyboard rows for a session list: the shared actions row first, then
 * one button per session whose text is a finished `verb <n> · <glyph> <title>`
 * command — a tap sends it verbatim, so the selection happens without typing
 * or copying ids. The title is shown in full, never truncated.
 * @param items - the visible session summaries (list order).
 * @param verb - the command the buttons carry (`attach` for scoped lists).
 * @returns the reply-keyboard rows, each row a list of button texts.
 */
export function sessionKeyboardRows(items: readonly SessionSummary[], verb: string): string[][] {
  const rows: string[][] = [...KEYBOARD_ACTION_ROWS.map(row => [...row])]
  for (const [index, item] of items.slice(0, SESSION_KEYBOARD_MAX).entries()) {
    const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId)
    rows.push([`/${verb} ${index + 1} · ${sessionGlyph(item)} ${title}`])
  }
  return rows
}

/**
 * Reply-keyboard rows for the /attach keyboard: the shared action rows first,
 * then one button per listed session carrying `/attach <n> · <glyph> <title>` —
 * a tap sends it verbatim and binds through the same numeric selector. The
 * list is fixed to the console's highlight rule (every running session, then
 * the five most recently completed, archived excluded) and carries no cap:
 * running sessions keep stacking until the next attach flow re-installs the
 * keyboard.
 * @param items - the attach keyboard's session summaries (running first, then the recent five).
 * @returns the reply-keyboard rows, each row a list of button texts.
 */
export function attachKeyboardRows(items: readonly SessionSummary[]): string[][] {
  const rows: string[][] = [...KEYBOARD_ACTION_ROWS.map(row => [...row])]
  for (const [index, item] of items.entries()) {
    const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId)
    rows.push([`/attach ${index + 1} · ${sessionGlyph(item)} ${title}`])
  }
  return rows
}

/**
 * One workspace row: index, folding-folder glyph, title, then the canonical
 * path and accounted session count on the second line.
 * @param index - 1-based row number, also the `/new` selector.
 * @param workspace - the workspace row.
 * @returns the two-line row text.
 */
export function workspaceRow(index: number, workspace: WorkspaceView): string {
  return `${index}) 📁 ${truncate(workspace.title, SESSION_TITLE_MAX)}\n   ${workspace.path} · ${workspace.sessionIds.length} 个会话`
}

/**
 * Reply-keyboard rows for a workspace list: the shared actions row first,
 * then one button per workspace carrying `/new <n> · <title>` (create a
 * session inside that workspace), then the ungrouped-create row
 * (`/new none · 未分类`).
 * @param workspaces - the workspace rows (registry order).
 * @returns the reply-keyboard rows.
 */
export function workspaceKeyboardRows(workspaces: readonly WorkspaceView[]): string[][] {
  const rows: string[][] = [...KEYBOARD_ACTION_ROWS.map(row => [...row])]
  for (const [index, workspace] of workspaces.slice(0, WORKSPACE_KEYBOARD_MAX).entries()) {
    rows.push([`/new ${index + 1} · ${truncate(workspace.title, WORKSPACE_KEYBOARD_TITLE_MAX)}`])
  }
  rows.push([CREATE_UNGROUPED_LABEL])
  return rows
}

/** Reply-keyboard presets capped like the session rows. */
export const PRESET_KEYBOARD_MAX = 15
/** One list row of the session's todo list, with its status glyph. */
export function todoRow(index: number, item: TodoItem): string {
  const glyph = item.status === 'completed' ? '✅' : item.status === 'in_progress' ? '🔄' : '⬜'
  return `${index}) ${glyph} ${truncate(item.content, SESSION_TITLE_MAX)}`
}

/**
 * The session's todo list, rendered with a one-line status summary: completed,
 * in progress, and pending counts mirroring the web sidebar's task list.
 * @param todos - the session's whole task list.
 * @returns the multi-line list text.
 */
export function renderTodoList(todos: readonly TodoItem[]): string {
  const done = todos.filter(item => item.status === 'completed').length
  const active = todos.filter(item => item.status === 'in_progress').length
  const pending = todos.length - done - active
  const body = todos.map((item, index) => todoRow(index + 1, item)).join('\n')
  return `📋 任务 ${done} 已完成 · ${active} 进行中 · ${pending} 待处理\n\n${body}`
}

/**
 * The latest complete todo snapshot in a history page, or `null` when the
 * page holds no `todo/write` event. `todo/write` is a whole-value projection:
 * the last snapshot wins.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the latest todo list, or null.
 */
export function lastTodoWrite(events: readonly SessionEvent[]): TodoItem[] | null {
  let latest: TodoItem[] | null = null
  for (const event of events) {
    if (event.type === 'todo/write') latest = event.data.todos
  }
  return latest
}

/**
 * Reply-keyboard rows for the preset picker: the shared action rows first,
 * then one button per preset carrying `/preset <n> · <name>` — a tap applies
 * the preset to the bound session (or stages it for the next /new).
 * @param presets - the deployment's preset entries (roster order).
 * @returns the reply-keyboard rows.
 */
export function presetKeyboardRows(presets: readonly AgentPresetEntry[]): string[][] {
  const rows: string[][] = [...KEYBOARD_ACTION_ROWS.map(row => [...row])]
  for (const [index, preset] of presets.slice(0, PRESET_KEYBOARD_MAX).entries()) {
    const label = preset.name ?? preset.id
    rows.push([`/preset ${index + 1} · ${truncate(label, SESSION_KEYBOARD_TITLE_MAX)}`])
  }
  return rows
}

// ── /attach inline picker surface ──────────────────────────────────────────

/** Callback-data prefixes of the /attach picker buttons (distinct from the ask prefixes). */
const ATTACH_CALLBACK_WORKSPACE = 'atw'
const ATTACH_CALLBACK_UNGROUPED = 'atn'
const ATTACH_CALLBACK_ARCHIVED = 'ata'
const ATTACH_CALLBACK_SESSION = 'ats'

/** Callback data of one workspace-scope button. */
export function attachWorkspaceData(workspaceId: string): string {
  return `${ATTACH_CALLBACK_WORKSPACE}:${workspaceId}`
}

/** Callback data of the ungrouped-scope button. */
export const ATTACH_UNGROUPED_DATA = `${ATTACH_CALLBACK_UNGROUPED}:1`
/** Callback data of the archived-scope button. */
export const ATTACH_ARCHIVED_DATA = `${ATTACH_CALLBACK_ARCHIVED}:1`

/** Callback data of one session-bind button. */
export function attachSessionData(sessionId: SessionId): string {
  return `${ATTACH_CALLBACK_SESSION}:${sessionId}`
}

/** The decoded action of one /attach picker callback. */
export type AttachCallback =
  | { kind: 'workspace'; workspaceId: WorkspaceId }
  | { kind: 'ungrouped' }
  | { kind: 'archived' }
  | { kind: 'session'; sessionId: SessionId }

/**
 * Parse one /attach picker callback data into its action. Returns
 * `undefined` for anything this surface does not emit (a foreign or
 * malformed callback).
 * @param data - the raw callback data.
 * @returns the decoded action, or `undefined` for an unknown token.
 */
export function parseAttachCallback(data: string): AttachCallback | undefined {
  const [prefix, id, ...rest] = data.split(':')
  if (id === undefined || id === '') return undefined
  if (prefix === ATTACH_CALLBACK_WORKSPACE) {
    if (rest.length !== 0) return undefined
    return { kind: 'workspace', workspaceId: id as WorkspaceId }
  }
  if (prefix === ATTACH_CALLBACK_UNGROUPED || prefix === ATTACH_CALLBACK_ARCHIVED) {
    if (id !== '1' || rest.length !== 0) return undefined
    return { kind: prefix === ATTACH_CALLBACK_UNGROUPED ? 'ungrouped' : 'archived' }
  }
  if (prefix === ATTACH_CALLBACK_SESSION) {
    if (rest.length !== 0) return undefined
    return { kind: 'session', sessionId: SessionId(id) }
  }
  return undefined
}

/**
 * The inline-keyboard rows of the /attach scope picker: one button per
 * workspace (list that workspace's sessions), then the ungrouped and archived
 * rows when their buckets are non-empty — the chat-message counterpart of the
 * ask_user_question surface, so picking a scope never needs typing.
 * @param workspaces - the workspace rows (registry order).
 * @param options - which non-empty scope buckets include their row.
 * @returns the keyboard rows.
 */
export function attachScopeButtons(
  workspaces: readonly WorkspaceView[],
  options: { ungrouped: boolean; archived: boolean },
): AnswerButton[][] {
  const rows: AnswerButton[][] = []
  for (const workspace of workspaces.slice(0, WORKSPACE_KEYBOARD_MAX)) {
    rows.push([{ text: `📁 ${truncate(workspace.title, SESSION_KEYBOARD_TITLE_MAX)}`, data: attachWorkspaceData(workspace.workspaceId) }])
  }
  if (options.ungrouped) rows.push([{ text: '未分组', data: ATTACH_UNGROUPED_DATA }])
  if (options.archived) rows.push([{ text: '归档', data: ATTACH_ARCHIVED_DATA }])
  return rows
}

/**
 * The inline-keyboard rows of one /attach session list: one bind button per
 * visible session, its title shown in full like the reply-row counterpart.
 * @param items - the visible session summaries (list order).
 * @returns the keyboard rows.
 */
export function attachSessionButtons(items: readonly SessionSummary[]): AnswerButton[][] {
  const rows: AnswerButton[][] = []
  for (const item of items.slice(0, SESSION_KEYBOARD_MAX)) {
    const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId)
    rows.push([{ text: `${sessionGlyph(item)} ${title}`, data: attachSessionData(item.sessionId) }])
  }
  return rows
}

// ── session action-list inline surface (stop / status) ─────────────────────

/** Callback-data prefixes of the session action-list buttons (distinct from the attach prefixes). */
const SESSION_LIST_CALLBACK_STOP = 'stp'
const SESSION_LIST_CALLBACK_STATUS = 'sta'

/** Callback data of one session-stop button. */
export function sessionStopData(sessionId: SessionId): string {
  return `${SESSION_LIST_CALLBACK_STOP}:${sessionId}`
}

/** Callback data of one session-status button. */
export function sessionStatusData(sessionId: SessionId): string {
  return `${SESSION_LIST_CALLBACK_STATUS}:${sessionId}`
}

/** The decoded action of one session action-list callback. */
export type SessionListCallback =
  | { kind: 'stop'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId }

/**
 * Parse one session action-list callback data into its action. Returns
 * `undefined` for anything this surface does not emit (a foreign or
 * malformed callback).
 * @param data - the raw callback data.
 * @returns the decoded action, or `undefined` for an unknown token.
 */
export function parseSessionListCallback(data: string): SessionListCallback | undefined {
  const [prefix, id, ...rest] = data.split(':')
  if (id === undefined || id === '') return undefined
  if (rest.length !== 0) return undefined
  if (prefix === SESSION_LIST_CALLBACK_STOP) return { kind: 'stop', sessionId: SessionId(id) }
  if (prefix === SESSION_LIST_CALLBACK_STATUS) return { kind: 'status', sessionId: SessionId(id) }
  return undefined
}

/**
 * The inline-keyboard rows of one session action list: one stop or status
 * button per visible session, its title shown in full like the attach
 * counterpart.
 * @param items - the visible session summaries (list order).
 * @param verb - the action the buttons carry (`stop` or `status`).
 * @returns the keyboard rows.
 */
export function sessionActionButtons(items: readonly SessionSummary[], verb: 'stop' | 'status'): AnswerButton[][] {
  const rows: AnswerButton[][] = []
  for (const item of items.slice(0, SESSION_KEYBOARD_MAX)) {
    const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId)
    const glyph = verb === 'stop' ? '⏹' : '📊'
    rows.push([{ text: `${glyph} ${sessionGlyph(item)} ${title}`, data: verb === 'stop' ? sessionStopData(item.sessionId) : sessionStatusData(item.sessionId) }])
  }
  return rows
}

// ── ask_user_question inline-surface rendering ──────────────────────────────

/** The submit-row label of a rendered question keyboard. */
export const QUESTION_SUBMIT_LABEL = '✅ 提交回答'
/** The cancel-row label of a rendered question keyboard. */
export const QUESTION_CANCEL_LABEL = '🚫 取消'
/** The custom-answer button label before the user typed anything. */
export const QUESTION_CUSTOM_LABEL = '✍️ 自定义回答'
/** The custom-answer button label once a custom answer is captured. */
export const QUESTION_CUSTOM_DONE_LABEL = '✍️ 重新输入回答'

/** Callback-data prefixes; the console routes taps by the first segment. */
const QUESTION_CALLBACK_OPTION = 'qo'
const QUESTION_CALLBACK_CUSTOM = 'qt'
const QUESTION_CALLBACK_SUBMIT = 'qs'
const QUESTION_CALLBACK_CANCEL = 'qx'

/** One inline-keyboard button: display text plus callback data. */
export interface AnswerButton {
  text: string
  data: string
}

/** Callback data of one option button. */
export function questionOptionData(rpcId: string, questionIndex: number, optionIndex: number): string {
  return `${QUESTION_CALLBACK_OPTION}:${rpcId}:${questionIndex}:${optionIndex}`
}

/** Callback data of one custom-answer button. */
export function questionCustomData(rpcId: string, questionIndex: number): string {
  return `${QUESTION_CALLBACK_CUSTOM}:${rpcId}:${questionIndex}`
}

/** Callback data of the submit button. */
export function questionSubmitData(rpcId: string): string {
  return `${QUESTION_CALLBACK_SUBMIT}:${rpcId}`
}

/** Callback data of the cancel button. */
export function questionCancelData(rpcId: string): string {
  return `${QUESTION_CALLBACK_CANCEL}:${rpcId}`
}

/**
 * Parse one question-button callback data into its action. Returns
 * `undefined` for anything this surface does not emit (a foreign or
 * malformed callback).
 * @param data - the raw callback data.
 * @returns the decoded action, or `undefined` for an unknown token.
 */
export function parseQuestionCallback(data: string): QuestionCallback | undefined {
  const parts = data.split(':')
  const prefix = parts[0]
  const rpcId = parts[1]
  if (rpcId === undefined || rpcId === '') return undefined
  if (prefix === QUESTION_CALLBACK_OPTION) {
    if (parts.length !== 4) return undefined
    const questionIndex = segmentIndex(parts[2])
    const option = segmentIndex(parts[3])
    if (questionIndex === undefined || option === undefined) return undefined
    return { kind: 'option', rpcId, questionIndex, optionIndex: option }
  }
  if (prefix === QUESTION_CALLBACK_CUSTOM) {
    if (parts.length !== 3) return undefined
    const questionIndex = segmentIndex(parts[2])
    if (questionIndex === undefined) return undefined
    return { kind: 'custom', rpcId, questionIndex }
  }
  if (prefix === QUESTION_CALLBACK_SUBMIT) {
    if (parts.length !== 2) return undefined
    return { kind: 'submit', rpcId }
  }
  if (prefix === QUESTION_CALLBACK_CANCEL) {
    if (parts.length !== 2) return undefined
    return { kind: 'cancel', rpcId }
  }
  return undefined
}

/** Parse one non-negative integer segment of a callback token. */
function segmentIndex(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** The decoded action of one question-button callback. */
export type QuestionCallback =
  | { kind: 'option'; rpcId: string; questionIndex: number; optionIndex: number }
  | { kind: 'custom'; rpcId: string; questionIndex: number }
  | { kind: 'submit'; rpcId: string }
  | { kind: 'cancel'; rpcId: string }

/**
 * The message text of one rendered ask batch.
 * @param questions - the questions of the ask batch.
 * @returns the text shown above the answer keyboard.
 */
export function questionMessageText(questions: readonly AskUserQuestionItem[]): string {
  const blocks = questions.map((question, index) => {
    const lines = [
      `❓ ${question.header ?? question.question}`,
      ...question.header === undefined ? [] : [question.question],
      ...question.detail === undefined ? [] : [question.detail],
      ...question.multiSelect === true ? ['（可多选）'] : [],
    ]
    return questions.length > 1 ? `【${index + 1}】\n${lines.join('\n')}` : lines.join('\n')
  })
  const footer = questions.length > 1
    ? '\n\n全部回答后点「✅ 提交回答」。'
    : ''
  return `${blocks.join('\n\n')}${footer}`
}

/**
 * The inline-keyboard rows of one rendered ask batch. Each question gets one
 * option row per option (its label carrying a ✅ pick mark and a question
 * prefix in multi-question batches), then one custom-answer row per question,
 * then the submit and cancel action rows.
 * @param questions - the questions of the ask batch.
 * @param selected - picked option labels per question (in tap order).
 * @param custom - captured custom answers per question (`undefined` = none).
 * @param rpcId - the host question id, embedded in every callback token.
 * @returns the keyboard rows.
 */
export function questionKeyboard(
  questions: readonly AskUserQuestionItem[],
  selected: readonly (readonly string[])[],
  custom: readonly (string | undefined)[],
  rpcId: string,
): AnswerButton[][] {
  const multiple = questions.length > 1
  const rows: AnswerButton[][] = []
  for (const [questionIndex, question] of questions.entries()) {
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      const picked = selected[questionIndex]?.includes(option.label) === true
      rows.push([{
        text: `${picked ? '✅ ' : ''}${multiple ? `${questionIndex + 1}. ` : ''}${option.label}`,
        data: questionOptionData(rpcId, questionIndex, optionIndex),
      }])
    }
    const hasCustom = custom[questionIndex] !== undefined
    rows.push([{
      text: multiple
        ? (hasCustom ? `✍️ 重输 Q${questionIndex + 1}` : `✍️ 自定义 Q${questionIndex + 1}`)
        : (hasCustom ? QUESTION_CUSTOM_DONE_LABEL : QUESTION_CUSTOM_LABEL),
      data: questionCustomData(rpcId, questionIndex),
    }])
  }
  rows.push([{ text: QUESTION_SUBMIT_LABEL, data: questionSubmitData(rpcId) }])
  rows.push([{ text: QUESTION_CANCEL_LABEL, data: questionCancelData(rpcId) }])
  return rows
}
