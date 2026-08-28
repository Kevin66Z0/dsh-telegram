/**
 * Pure text rendering for the Telegram surface: session rows, history lines,
 * turn outcomes, and Telegram-safe chunking. No I/O here — every function is
 * a deterministic projection of its inputs so the console logic stays testable
 * without a transport.
 * @module @deepseek-ai/dsh-host-telegram/render
 */
import type { AssistantMessage, ContentBlock, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent, type TodoItem, type TurnEndReason } from '@deepseek-ai/dsh-session';
import type { AgentPresetEntry, SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy';
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
/**
 * The Telegram console's user-visible version, printed by `/status` so a
 * restart is verifiable at a glance. Bump per AGENTS.md: a bugfix adds 0.0.1,
 * a feature adds 0.1; a batch of several items still adds at most 0.1 total
 * (a minor mixed batch may add 0.01).
 */
export declare const TELEGRAM_VERSION = "1.9.2";
/** Hard byte-ish ceiling for one Telegram message; stay under the 4096 limit. */
export declare const TELEGRAM_CHUNK_MAX = 3500;
/** Queued-prompt acknowledgement caps the echoed text at this many code points. */
export declare const QUEUE_ACK_MAX = 200;
/** Row-title truncation for workspace and todo rows. */
export declare const SESSION_TITLE_MAX = 48;
/** Tool-call argument-brief truncation. */
export declare const TOOL_ARGS_MAX = 80;
/** Reasoning (Think) brief truncation in code points. */
export declare const REASONING_BRIEF_MAX = 120;
/** History lines fed to /status and /attach's last-dialogue preview. */
export declare const HISTORY_DEFAULT_LIMIT = 20;
/** Main-content cap for /status assistant output; the aux lines stay the signal, the text is a preview. */
export declare const STATUS_MAIN_MAX = 400;
/** Reply-keyboard sessions capped at the rows a bot can usefully show. */
export declare const SESSION_KEYBOARD_MAX = 15;
/**
 * Title inside a workspace or preset button; the worst-case button
 * (`/attach <n> · <title>…` or `/preset <n> · <name>…`) stays within 20 code
 * points, so the button holds one line on the narrowest phones that render
 * the reply keyboard.
 */
export declare const SESSION_KEYBOARD_TITLE_MAX = 6;
/** Reply-keyboard workspaces capped like the session rows. */
export declare const WORKSPACE_KEYBOARD_MAX = 15;
/**
 * Title inside a workspace button; worst case (`/new <n> · <title>…`) fits one
 * line like the session buttons.
 */
export declare const WORKSPACE_KEYBOARD_TITLE_MAX = 8;
/** The reply-keyboard label that creates an ungrouped (no-workspace) session. */
export declare const CREATE_UNGROUPED_LABEL = "/new none \u00B7 \u672A\u5206\u7C7B";
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
export declare const KEYBOARD_ACTION_ROWS: string[][];
/**
 * State legend for session lists: the glyph meanings at a glance.
 * @see sessionRow
 */
export declare const SESSION_STATE_LEGEND = "\uD83D\uDFE2 \u6267\u884C\u4E2D \u00B7 \u2705 \u5DF2\u5B8C\u6210 \u00B7 \u26AA \u672A\u5F00\u59CB";
/**
 * Suffix appended to in-flight stream edits while a turn is still running, so
 * the reader always sees the reply is not final; removed by the turn/end edit.
 */
export declare const STREAM_REPLYING_SUFFIX = "\n\n\u23F3 \u56DE\u590D\u4E2D\u2026";
/** Role glyph a rendered assistant line starts with. */
export declare const ASSISTANT_ROLE_GLYPH = "\uD83E\uDD16";
/**
 * Cap a string to `max` code points, appending an ellipsis when truncated.
 * @param text - the input text.
 * @param max - the maximum kept code points.
 * @returns the possibly-ellipsized text.
 */
export declare function truncate(text: string, max: number): string;
/**
 * Human-ish relative timestamp.
 * @param timestamp - Unix epoch milliseconds.
 * @param now - the current epoch millisecond clock (pure injection).
 * @returns a label like `刚刚`, `5 分钟前`, or `2 天前`.
 */
export declare function timeAgo(timestamp: number, now: number): string;
/**
 * Absolute start-time clock, date-aware like the Web surface: same-day
 * `HH:mm:ss`, same-year `MM-DD HH:mm:ss`, and `YYYY-MM-DD HH:mm:ss` across
 * years. Seconds are always shown; the day/year cut reads `now` (pure clock
 * injection) so tests stay deterministic.
 * @param ms - the start-time Unix epoch milliseconds.
 * @param now - the current Unix epoch millisecond clock.
 * @returns the zero-padded clock without surrounding parens.
 */
export declare function formatStartClock(ms: number, now: number): string;
/**
 * The {@link formatStartClock} value wrapped in full-width parens, as shown
 * before a tool-call step line or above an assistant reply.
 * @param ms - the start-time Unix epoch milliseconds.
 * @param now - the current Unix epoch millisecond clock.
 * @returns `（…）` around the clock.
 */
export declare function startClockLabel(ms: number, now: number): string;
/**
 * Short display form of a session id: `xxxxxxxx…xx`.
 * @param id - the full session id.
 * @returns the shortened id.
 */
export declare function shortSessionId(id: SessionId): string;
/**
 * Concatenate the display text of a content block list, skipping non-text
 * blocks (unknown merge-extensible types carry no display text for this
 * surface).
 * @param content - the message content blocks.
 * @returns the trimmed plain text.
 */
export declare function blockText(content: readonly ContentBlock[]): string;
/**
 * Text of one human user message, or empty when the message carries none.
 * @param message - the user message.
 * @returns the trimmed text of the message's text blocks.
 */
export declare function userMessageText(message: UserMessage): string;
/**
 * Whether a logged user-message source is a workspace-instruction context
 * (`source.kind === 'agent-instructions'`). Such messages are model-visible
 * context produced by the harness, never human input: this surface skips them
 * in realtime push, history previews, and status statistics, while the session
 * log and model context stay untouched.
 * @param source - the logged user-message source.
 * @returns true for the workspace-instruction source kind.
 */
export declare function isWorkspaceInstructionSource(source: {
    kind: string;
}): boolean;
/**
 * Text of one assembled assistant message, or empty when the step spoke no text.
 * @param message - the assistant message.
 * @returns the trimmed text of the message's text blocks.
 */
export declare function assistantMessageText(message: AssistantMessage): string;
/**
 * Brief form of one tool call's arguments: the first value of the leading
 * object entries, or the raw JSON when unparseable, ellipsized to
 * {@link TOOL_ARGS_MAX} code points. The tool name is not included.
 * @param raw - the model-produced arguments JSON string.
 * @returns the argument brief.
 */
export declare function toolArgBrief(raw: string): string;
/**
 * Brief inline form of a tool invocation: `name(brief)` where `brief` is
 * {@link toolArgBrief}.
 * @param name - the tool name.
 * @param raw - the model-produced arguments JSON string.
 * @returns the brief, ellipsized to {@link TOOL_ARGS_MAX} code points.
 */
export declare function toolCallBrief(name: string, raw: string): string;
/**
 * Brief one-line form of a reasoning pass: whitespace collapsed, ellipsized
 * to {@link REASONING_BRIEF_MAX} code points.
 * @param text - the reasoning block text.
 * @returns the brief ('' for blank input).
 */
export declare function reasoningBrief(text: string): string;
/** Display prefix of a reasoning action line. */
export declare const REASONING_ACTION_LABEL = "\uD83D\uDCAD Think";
/** Display prefix of a tool-call action line. */
export declare const TOOL_ACTION_LABEL = "\uD83D\uDD27";
/**
 * One model-step action rendered as a display line: a reasoning pass or a
 * tool call, each on its own line (mirrors the web's per-action rows).
 */
export interface StepAction {
    /** The `assistant/message` event time (Unix epoch milliseconds). */
    time: number;
    /** The display line: `💭 Think — brief` or `🔧 name — brief`. */
    line: string;
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
export declare function messageActions(message: AssistantMessage, time: number): StepAction[];
/**
 * Human label for {@link TurnEndReason}; the Chinese wording is dropped in
 * favor of an English one-word hint so the outcome reads without the local
 * language. Unknown merge-extensible kinds fall back to their raw kind name.
 * @param reason - the turn outcome.
 * @returns the label glyph plus wording.
 */
export declare function turnEndLabel(reason: TurnEndReason): string;
/** Escaping for Telegram's HTML parse mode (required before any `&`, `<`, or `>`). */
export declare function escapeHtml(text: string): string;
/**
 * The token accounting one turn accumulates from its step usage records
 * (`assistant/message` event `usage` fields). Counts are disjoint, mirroring
 * {@link TokenUsage}: cache reads/writes are separate from the plain input.
 */
export interface RoundUsage {
    /** Uncached input tokens (all steps). */
    input: number;
    /** Output tokens (all steps). */
    output: number;
    /** Tokens served from the provider's prompt cache. */
    cacheRead: number;
    /** Tokens written into the provider's prompt cache. */
    cacheWrite: number;
}
/** The zero pointer for {@link RoundUsage}. */
export declare function emptyRoundUsage(): RoundUsage;
/**
 * Fold one step's token usage into the turn accumulator, skipping records
 * without accounting (`undefined`).
 * @param usage - the turn accumulator to mutate.
 * @param step - one step's usage, or undefined when the adapter reported none.
 */
export declare function accumulateRoundUsage(usage: RoundUsage, step: TokenUsage | undefined): void;
/**
 * Compact token count for the footer: plain below 1000, `k` suffix above
 * with at most one decimal (JavaScript number formatting drops a trailing
 * `.0` itself).
 * @param count - a non-negative token count.
 * @returns the compact label.
 */
export declare function compactTokenCount(count: number): string;
/**
 * The small HTML footer appended to a turn's final message: this round's
 * token consumption (↑ input, ↓ output) plus the cache-hit percentage and
 * cache writes when the provider reported them. Rendered as a `<pre>` block
 * so Telegram draws it smaller and monospace. Empty when the turn carried no
 * token accounting at all.
 * @param usage - the turn's accumulated usage.
 * @returns the HTML footer, or an empty string when there is nothing to report.
 */
export declare function roundUsageFooter(usage: RoundUsage): string;
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
export declare function lastTurnUsage(events: readonly SessionEvent[]): RoundUsage;
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
export declare function openTurnUsage(events: readonly SessionEvent[]): RoundUsage;
/**
 * The timestamp of the history page's latest `turn/start`, or undefined when
 * the page shows none. The attach preview's live-stream clock: a chat that
 * binds mid-turn stamps the first pushed reply with the turn's real start
 * time instead of the bind time.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the latest turn start time, or undefined.
 */
export declare function latestTurnStartTime(events: readonly SessionEvent[]): number | undefined;
/**
 * The tri-state run glyph for one session summary: running 🟢, finished (has
 * turns, idle) ✅, blank ⚪.
 * @param summary - the session summary row.
 * @returns the status glyph.
 */
export declare function sessionGlyph(summary: SessionSummary): string;
/**
 * One list row: index, run glyph, title or cwd fallback, then a second line
 * with cwd, relative age, and the short session id.
 * @param index - 1-based row number, also the /attach selector.
 * @param summary - the session summary row.
 * @param now - current epoch millisecond clock (pure injection).
 * @returns the two-line row text.
 */
export declare function sessionRow(index: number, summary: SessionSummary, now: number): string;
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
export declare function assistantTail(events: readonly SessionEvent[], rounds: number): string[];
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
export declare function statusMainText(events: readonly SessionEvent[]): string;
/**
 * The briefs of tool calls still open at the page tail: each `tool/call` with
 * no later `tool/result` in the same turn. A `turn/end` settles every open
 * call, so only an in-progress turn leaves calls open.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the brief of each open call, in call order.
 */
export declare function openToolCalls(events: readonly SessionEvent[]): string[];
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
export declare function turnOpen(events: readonly SessionEvent[]): boolean;
/**
 * The unanswered `question/asked` batches at the page tail: each asked id
 * with no later `question/decided` carrying the same id.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the open batches, in asked order.
 */
export declare function pendingAskBatches(events: readonly SessionEvent[]): {
    id: string;
    questions: AskUserQuestionItem[];
}[];
/**
 * The per-action lines of a history page, one line per reasoning pass or tool
 * call in content order, capped at the most recent {@link maxActions} lines.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @param maxActions - maximum number of action lines (most recent) to keep.
 * @returns the action lines, oldest first.
 */
export declare function stepActions(events: readonly SessionEvent[], maxActions?: number): StepAction[];
/**
 * The collapsible Telegram-HTML blockquote listing the given actions, one
 * time-stamped line per action, or '' when there are none.
 * @param actions - the action lines, oldest first.
 * @param now - the current Unix epoch millisecond clock (pure injection).
 * @returns the `<blockquote expandable>` fragment, or ''.
 */
export declare function actionsHtml(actions: readonly StepAction[], now: number): string;
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
export declare function stepActionsHtml(events: readonly SessionEvent[], now: number, maxActions?: number): string;
/**
 * Split long text into Telegram-safe chunks, preferring newline boundaries.
 * @param text - the full text.
 * @param cap - the maximum chunk length; defaults to {@link TELEGRAM_CHUNK_MAX}.
 * @returns one or more chunks within `cap`.
 */
export declare function chunkText(text: string, cap?: number): string[];
/**
 * Remove the trailing replying marker from a stream edit's displayed text,
 * restoring the bare body for {@link STREAM_REPLYING_SUFFIX} consumers that
 * store what was shown (chunked overflow sends one chunk whole).
 * @param text - the displayed text, possibly ending with the marker.
 * @returns the text without a trailing marker.
 */
export declare function stripStreamSuffix(text: string): string;
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
export declare function statusStats(events: readonly SessionEvent[]): {
    users: number;
    assistants: number;
    tools: number;
    chars: number;
};
/**
 * Reply-keyboard rows for a session list: the shared actions row first, then
 * one button per session whose text is a finished `verb <n> · <glyph> <title>`
 * command — a tap sends it verbatim, so the selection happens without typing
 * or copying ids. The title is shown in full, never truncated.
 * @param items - the visible session summaries (list order).
 * @param verb - the command the buttons carry (`attach` for scoped lists).
 * @returns the reply-keyboard rows, each row a list of button texts.
 */
export declare function sessionKeyboardRows(items: readonly SessionSummary[], verb: string): string[][];
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
export declare function attachKeyboardRows(items: readonly SessionSummary[]): string[][];
/**
 * One workspace row: index, folding-folder glyph, title, then the canonical
 * path and accounted session count on the second line.
 * @param index - 1-based row number, also the `/new` selector.
 * @param workspace - the workspace row.
 * @returns the two-line row text.
 */
export declare function workspaceRow(index: number, workspace: WorkspaceView): string;
/**
 * Reply-keyboard rows for a workspace list: the shared actions row first,
 * then one button per workspace carrying `/new <n> · <title>` (create a
 * session inside that workspace), then the ungrouped-create row
 * (`/new none · 未分类`).
 * @param workspaces - the workspace rows (registry order).
 * @returns the reply-keyboard rows.
 */
export declare function workspaceKeyboardRows(workspaces: readonly WorkspaceView[]): string[][];
/** Reply-keyboard presets capped like the session rows. */
export declare const PRESET_KEYBOARD_MAX = 15;
/** One list row of the session's todo list, with its status glyph. */
export declare function todoRow(index: number, item: TodoItem): string;
/**
 * The session's todo list, rendered with a one-line status summary: completed,
 * in progress, and pending counts mirroring the web sidebar's task list.
 * @param todos - the session's whole task list.
 * @returns the multi-line list text.
 */
export declare function renderTodoList(todos: readonly TodoItem[]): string;
/**
 * The latest complete todo snapshot in a history page, or `null` when the
 * page holds no `todo/write` event. `todo/write` is a whole-value projection:
 * the last snapshot wins.
 * @param events - the history page's raw events (page-ordered, oldest first).
 * @returns the latest todo list, or null.
 */
export declare function lastTodoWrite(events: readonly SessionEvent[]): TodoItem[] | null;
/**
 * Reply-keyboard rows for the preset picker: the shared action rows first,
 * then one button per preset carrying `/preset <n> · <name>` — a tap applies
 * the preset to the bound session (or stages it for the next /new).
 * @param presets - the deployment's preset entries (roster order).
 * @returns the reply-keyboard rows.
 */
export declare function presetKeyboardRows(presets: readonly AgentPresetEntry[]): string[][];
/** Callback data of one workspace-scope button. */
export declare function attachWorkspaceData(workspaceId: string): string;
/** Callback data of the ungrouped-scope button. */
export declare const ATTACH_UNGROUPED_DATA = "atn:1";
/** Callback data of the archived-scope button. */
export declare const ATTACH_ARCHIVED_DATA = "ata:1";
/** Callback data of one session-bind button. */
export declare function attachSessionData(sessionId: SessionId): string;
/** The decoded action of one /attach picker callback. */
export type AttachCallback = {
    kind: 'workspace';
    workspaceId: WorkspaceId;
} | {
    kind: 'ungrouped';
} | {
    kind: 'archived';
} | {
    kind: 'session';
    sessionId: SessionId;
};
/**
 * Parse one /attach picker callback data into its action. Returns
 * `undefined` for anything this surface does not emit (a foreign or
 * malformed callback).
 * @param data - the raw callback data.
 * @returns the decoded action, or `undefined` for an unknown token.
 */
export declare function parseAttachCallback(data: string): AttachCallback | undefined;
/**
 * The inline-keyboard rows of the /attach scope picker: one button per
 * workspace (list that workspace's sessions), then the ungrouped and archived
 * rows when their buckets are non-empty — the chat-message counterpart of the
 * ask_user_question surface, so picking a scope never needs typing.
 * @param workspaces - the workspace rows (registry order).
 * @param options - which non-empty scope buckets include their row.
 * @returns the keyboard rows.
 */
export declare function attachScopeButtons(workspaces: readonly WorkspaceView[], options: {
    ungrouped: boolean;
    archived: boolean;
}): AnswerButton[][];
/**
 * The inline-keyboard rows of one /attach session list: one bind button per
 * visible session, its title shown in full like the reply-row counterpart.
 * @param items - the visible session summaries (list order).
 * @returns the keyboard rows.
 */
export declare function attachSessionButtons(items: readonly SessionSummary[]): AnswerButton[][];
/** Callback data of one session-stop button. */
export declare function sessionStopData(sessionId: SessionId): string;
/** Callback data of one session-status button. */
export declare function sessionStatusData(sessionId: SessionId): string;
/** The decoded action of one session action-list callback. */
export type SessionListCallback = {
    kind: 'stop';
    sessionId: SessionId;
} | {
    kind: 'status';
    sessionId: SessionId;
};
/**
 * Parse one session action-list callback data into its action. Returns
 * `undefined` for anything this surface does not emit (a foreign or
 * malformed callback).
 * @param data - the raw callback data.
 * @returns the decoded action, or `undefined` for an unknown token.
 */
export declare function parseSessionListCallback(data: string): SessionListCallback | undefined;
/**
 * The inline-keyboard rows of one session action list: one stop or status
 * button per visible session, its title shown in full like the attach
 * counterpart.
 * @param items - the visible session summaries (list order).
 * @param verb - the action the buttons carry (`stop` or `status`).
 * @returns the keyboard rows.
 */
export declare function sessionActionButtons(items: readonly SessionSummary[], verb: 'stop' | 'status'): AnswerButton[][];
/** The submit-row label of a rendered question keyboard. */
export declare const QUESTION_SUBMIT_LABEL = "\u2705 \u63D0\u4EA4\u56DE\u7B54";
/** The cancel-row label of a rendered question keyboard. */
export declare const QUESTION_CANCEL_LABEL = "\uD83D\uDEAB \u53D6\u6D88";
/** The custom-answer button label before the user typed anything. */
export declare const QUESTION_CUSTOM_LABEL = "\u270D\uFE0F \u81EA\u5B9A\u4E49\u56DE\u7B54";
/** The custom-answer button label once a custom answer is captured. */
export declare const QUESTION_CUSTOM_DONE_LABEL = "\u270D\uFE0F \u91CD\u65B0\u8F93\u5165\u56DE\u7B54";
/** One inline-keyboard button: display text plus callback data. */
export interface AnswerButton {
    text: string;
    data: string;
}
/** Callback data of one option button. */
export declare function questionOptionData(rpcId: string, questionIndex: number, optionIndex: number): string;
/** Callback data of one custom-answer button. */
export declare function questionCustomData(rpcId: string, questionIndex: number): string;
/** Callback data of the submit button. */
export declare function questionSubmitData(rpcId: string): string;
/** Callback data of the cancel button. */
export declare function questionCancelData(rpcId: string): string;
/**
 * Parse one question-button callback data into its action. Returns
 * `undefined` for anything this surface does not emit (a foreign or
 * malformed callback).
 * @param data - the raw callback data.
 * @returns the decoded action, or `undefined` for an unknown token.
 */
export declare function parseQuestionCallback(data: string): QuestionCallback | undefined;
/** The decoded action of one question-button callback. */
export type QuestionCallback = {
    kind: 'option';
    rpcId: string;
    questionIndex: number;
    optionIndex: number;
} | {
    kind: 'custom';
    rpcId: string;
    questionIndex: number;
} | {
    kind: 'submit';
    rpcId: string;
} | {
    kind: 'cancel';
    rpcId: string;
};
/**
 * The message text of one rendered ask batch.
 * @param questions - the questions of the ask batch.
 * @returns the text shown above the answer keyboard.
 */
export declare function questionMessageText(questions: readonly AskUserQuestionItem[]): string;
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
export declare function questionKeyboard(questions: readonly AskUserQuestionItem[], selected: readonly (readonly string[])[], custom: readonly (string | undefined)[], rpcId: string): AnswerButton[][];
//# sourceMappingURL=render.d.ts.map