import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { Bot } from "grammy";
import { ProxyAgent, fetch } from "undici";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
//#region lib/types/render.js
/**
* Pure text rendering for the Telegram surface: session rows, history lines,
* turn outcomes, and Telegram-safe chunking. No I/O here — every function is
* a deterministic projection of its inputs so the console logic stays testable
* without a transport.
* @module @deepseek-ai/dsh-host-telegram/render
*/
/**
* The Telegram console's user-visible version, printed by `/status` so a
* restart is verifiable at a glance. Bump per AGENTS.md: a bugfix adds 0.0.1,
* a feature adds 0.1; a batch of several items still adds at most 0.1 total
* (a minor mixed batch may add 0.01).
*/
const TELEGRAM_VERSION = "1.9.2";
/** Hard byte-ish ceiling for one Telegram message; stay under the 4096 limit. */
const TELEGRAM_CHUNK_MAX = 3500;
/** The reply-keyboard label that creates an ungrouped (no-workspace) session. */
const CREATE_UNGROUPED_LABEL = "/new none · 未分类";
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
const KEYBOARD_ACTION_ROWS = [[
	"/create",
	"/archive",
	"/attach"
], ["/stop", "/close"]];
/**
* State legend for session lists: the glyph meanings at a glance.
* @see sessionRow
*/
const SESSION_STATE_LEGEND = "🟢 执行中 · ✅ 已完成 · ⚪ 未开始";
/**
* Suffix appended to in-flight stream edits while a turn is still running, so
* the reader always sees the reply is not final; removed by the turn/end edit.
*/
const STREAM_REPLYING_SUFFIX = "\n\n⏳ 回复中…";
/** Role glyph a rendered assistant line starts with. */
const ASSISTANT_ROLE_GLYPH = "🤖";
/**
* Cap a string to `max` code points, appending an ellipsis when truncated.
* @param text - the input text.
* @param max - the maximum kept code points.
* @returns the possibly-ellipsized text.
*/
function truncate(text, max) {
	const points = Array.from(text);
	return points.length > max ? `${points.slice(0, max).join("")}…` : text;
}
/**
* Human-ish relative timestamp.
* @param timestamp - Unix epoch milliseconds.
* @param now - the current epoch millisecond clock (pure injection).
* @returns a label like `刚刚`, `5 分钟前`, or `2 天前`.
*/
function timeAgo(timestamp, now) {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1e3));
	if (seconds < 60) return "刚刚";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return `${Math.floor(hours / 24)} 天前`;
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
function formatStartClock(ms, now) {
	const d = new Date(ms);
	const hhmmss = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
	const ref = new Date(now);
	if (d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate()) return hhmmss;
	const mmdd = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	if (d.getFullYear() === ref.getFullYear()) return `${mmdd} ${hhmmss}`;
	return `${d.getFullYear()}-${mmdd} ${hhmmss}`;
}
/**
* The {@link formatStartClock} value wrapped in full-width parens, as shown
* before a tool-call step line or above an assistant reply.
* @param ms - the start-time Unix epoch milliseconds.
* @param now - the current Unix epoch millisecond clock.
* @returns `（…）` around the clock.
*/
function startClockLabel(ms, now) {
	return `（${formatStartClock(ms, now)}）`;
}
/**
* Short display form of a session id: `xxxxxxxx…xx`.
* @param id - the full session id.
* @returns the shortened id.
*/
function shortSessionId(id) {
	return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-2)}`;
}
/**
* Concatenate the display text of a content block list, skipping non-text
* blocks (unknown merge-extensible types carry no display text for this
* surface).
* @param content - the message content blocks.
* @returns the trimmed plain text.
*/
function blockText(content) {
	let out = "";
	for (const block of content) if (block.type === "text") out += block.text;
	return out.trim();
}
/**
* Text of one human user message, or empty when the message carries none.
* @param message - the user message.
* @returns the trimmed text of the message's text blocks.
*/
function userMessageText(message) {
	return blockText(message.content);
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
function isWorkspaceInstructionSource(source) {
	return source.kind === "agent-instructions";
}
/**
* Text of one assembled assistant message, or empty when the step spoke no text.
* @param message - the assistant message.
* @returns the trimmed text of the message's text blocks.
*/
function assistantMessageText(message) {
	return blockText(message.content);
}
/**
* Brief form of one tool call's arguments: the first value of the leading
* object entries, or the raw JSON when unparseable, ellipsized to
* {@link TOOL_ARGS_MAX} code points. The tool name is not included.
* @param raw - the model-produced arguments JSON string.
* @returns the argument brief.
*/
function toolArgBrief(raw) {
	let brief = raw;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const first = Object.values(parsed)[0];
			if (typeof first === "string") brief = first;
			else if (first !== void 0) brief = JSON.stringify(first);
		}
	} catch {
		brief = raw;
	}
	return truncate(brief, 80);
}
/**
* Brief inline form of a tool invocation: `name(brief)` where `brief` is
* {@link toolArgBrief}.
* @param name - the tool name.
* @param raw - the model-produced arguments JSON string.
* @returns the brief, ellipsized to {@link TOOL_ARGS_MAX} code points.
*/
function toolCallBrief(name, raw) {
	return `${name}(${toolArgBrief(raw)})`;
}
/**
* Brief one-line form of a reasoning pass: whitespace collapsed, ellipsized
* to {@link REASONING_BRIEF_MAX} code points.
* @param text - the reasoning block text.
* @returns the brief ('' for blank input).
*/
function reasoningBrief(text) {
	return truncate(text.replace(/\s+/g, " ").trim(), 120);
}
/** Display prefix of a reasoning action line. */
const REASONING_ACTION_LABEL = "💭 Think";
/** Display prefix of a tool-call action line. */
const TOOL_ACTION_LABEL = "🔧";
/**
* The per-action lines of one assistant message, in content order. Each
* `reasoning` block renders a `💭 Think — brief` line and each `tool-call`
* block a `🔧 name — brief` line; text and other blocks are skipped (the
* reply body renders separately).
* @param message - the assistant message.
* @param time - the message event time, stamped on every action.
* @returns the action lines (empty when the step reasoned and called nothing).
*/
function messageActions(message, time) {
	const actions = [];
	for (const block of message.content) if (block.type === "reasoning") {
		const brief = reasoningBrief(block.text);
		if (brief !== "") actions.push({
			time,
			line: `${REASONING_ACTION_LABEL} — ${brief}`
		});
	} else if (block.type === "tool-call") actions.push({
		time,
		line: `${TOOL_ACTION_LABEL} ${block.name} — ${toolArgBrief(block.arguments)}`
	});
	return actions;
}
/**
* Human label for {@link TurnEndReason}; the Chinese wording is dropped in
* favor of an English one-word hint so the outcome reads without the local
* language. Unknown merge-extensible kinds fall back to their raw kind name.
* @param reason - the turn outcome.
* @returns the label glyph plus wording.
*/
function turnEndLabel(reason) {
	switch (reason.kind) {
		case "completed": return "✅ done";
		case "aborted": return "⏹ stopped";
		case "blocked": return "⛔ blocked";
		case "error": return "❌ failed";
		case "max-tokens": return "⏳ max tokens";
		case "interrupted": return "⏸ interrupted";
		default: return `⏹ ${reason.kind}`;
	}
}
/** Escaping for Telegram's HTML parse mode (required before any `&`, `<`, or `>`). */
function escapeHtml(text) {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
/** The zero pointer for {@link RoundUsage}. */
function emptyRoundUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0
	};
}
/**
* Fold one step's token usage into the turn accumulator, skipping records
* without accounting (`undefined`).
* @param usage - the turn accumulator to mutate.
* @param step - one step's usage, or undefined when the adapter reported none.
*/
function accumulateRoundUsage(usage, step) {
	if (step === void 0) return;
	usage.input += step.inputTokens;
	usage.output += step.outputTokens;
	usage.cacheRead += step.cacheReadTokens ?? 0;
	usage.cacheWrite += step.cacheWriteTokens ?? 0;
}
/**
* Compact token count for the footer: plain below 1000, `k` suffix above
* with at most one decimal (JavaScript number formatting drops a trailing
* `.0` itself).
* @param count - a non-negative token count.
* @returns the compact label.
*/
function compactTokenCount(count) {
	if (count < 1e3) return String(count);
	return `${Math.round(count / 1e3 * 10) / 10}k`;
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
function roundUsageFooter(usage) {
	const parts = [];
	if (usage.input > 0 || usage.output > 0) parts.push(`↑${compactTokenCount(usage.input)} ↓${compactTokenCount(usage.output)}`);
	if (usage.cacheRead > 0) {
		const hitRate = Math.round(usage.cacheRead / (usage.cacheRead + usage.input) * 100);
		parts.push(`缓存命中 ${hitRate}%`);
	}
	if (usage.cacheWrite > 0) parts.push(`缓存写 ${compactTokenCount(usage.cacheWrite)}`);
	if (parts.length === 0) return "";
	return `\n\n<pre>⚡ 本轮: ${parts.join(" · ")}</pre>`;
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
function lastTurnUsage(events) {
	let startIndex = -1;
	let endIndex = -1;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (event?.type === "turn/start") startIndex = index;
		else if (event?.type === "turn/end") endIndex = index;
	}
	if (startIndex === -1 || endIndex <= startIndex) return emptyRoundUsage();
	const usage = emptyRoundUsage();
	for (let index = startIndex + 1; index < endIndex; index += 1) {
		const event = events[index];
		if (event?.type === "assistant/message") accumulateRoundUsage(usage, event.data.usage);
	}
	return usage;
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
function openTurnUsage(events) {
	let startIndex = -1;
	let endIndex = -1;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (event?.type === "turn/start") startIndex = index;
		else if (event?.type === "turn/end") endIndex = index;
	}
	if (startIndex === -1 || endIndex > startIndex) return emptyRoundUsage();
	const usage = emptyRoundUsage();
	for (let index = startIndex + 1; index < events.length; index += 1) {
		const event = events[index];
		if (event?.type === "assistant/message") accumulateRoundUsage(usage, event.data.usage);
	}
	return usage;
}
/**
* The timestamp of the history page's latest `turn/start`, or undefined when
* the page shows none. The attach preview's live-stream clock: a chat that
* binds mid-turn stamps the first pushed reply with the turn's real start
* time instead of the bind time.
* @param events - the history page's raw events (page-ordered, oldest first).
* @returns the latest turn start time, or undefined.
*/
function latestTurnStartTime(events) {
	let time;
	for (const event of events) if (event.type === "turn/start") time = event.time;
	return time;
}
/**
* The tri-state run glyph for one session summary: running 🟢, finished (has
* turns, idle) ✅, blank ⚪.
* @param summary - the session summary row.
* @returns the status glyph.
*/
function sessionGlyph(summary) {
	return summary.running ? "🟢" : summary.blank ? "⚪" : "✅";
}
/**
* One list row: index, run glyph, title or cwd fallback, then a second line
* with cwd, relative age, and the short session id.
* @param index - 1-based row number, also the /attach selector.
* @param summary - the session summary row.
* @param now - current epoch millisecond clock (pure injection).
* @returns the two-line row text.
*/
function sessionRow(index, summary, now) {
	const title = summary.projections?.values.title ?? "";
	const heading = title !== "" ? title : summary.cwd ?? shortSessionId(summary.sessionId);
	const cwd = summary.cwd ?? "（无目录）";
	const age = timeAgo(summary.updatedAt, now);
	return `${index}) ${sessionGlyph(summary)} ${heading}\n   ${cwd} · ${age} · ${shortSessionId(summary.sessionId)}`;
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
function assistantTail(events, rounds) {
	const texts = [];
	for (const event of events) {
		if (event.type !== "assistant/message") continue;
		const text = assistantMessageText(event.data.message);
		if (text !== "") texts.push(text);
	}
	if (texts.length <= rounds) return texts;
	return texts.slice(texts.length - rounds);
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
function statusMainText(events) {
	if (events.length === 0) return "（空白会话，还没有消息）";
	const openCalls = [];
	for (const event of events) switch (event.type) {
		case "tool/call":
			openCalls.push(event.data.name);
			break;
		case "tool/result":
			openCalls.pop();
			break;
		case "turn/end":
			openCalls.length = 0;
			break;
		default: break;
	}
	const pending = openCalls.at(-1);
	if (pending !== void 0) return `🔧 工具调用中: ${pending}`;
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event === void 0 || event.type !== "assistant/message") continue;
		const text = assistantMessageText(event.data.message);
		if (text === "") continue;
		return `🤖 ${truncate(text, 400)}`;
	}
	return "（暂无输出）";
}
/**
* The briefs of tool calls still open at the page tail: each `tool/call` with
* no later `tool/result` in the same turn. A `turn/end` settles every open
* call, so only an in-progress turn leaves calls open.
* @param events - the history page's raw events (page-ordered, oldest first).
* @returns the brief of each open call, in call order.
*/
function openToolCalls(events) {
	const open = [];
	for (const event of events) switch (event.type) {
		case "tool/call":
			open.push(toolCallBrief(event.data.name, event.data.arguments));
			break;
		case "tool/result":
			open.pop();
			break;
		case "turn/end":
			open.length = 0;
			break;
		default: break;
	}
	return open;
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
function turnOpen(events) {
	let started = false;
	for (const event of events) if (event.type === "turn/start") started = true;
	else if (event.type === "turn/end") started = false;
	return started || openToolCalls(events).length > 0;
}
/**
* The unanswered `question/asked` batches at the page tail: each asked id
* with no later `question/decided` carrying the same id.
* @param events - the history page's raw events (page-ordered, oldest first).
* @returns the open batches, in asked order.
*/
function pendingAskBatches(events) {
	const decided = /* @__PURE__ */ new Set();
	for (const event of events) if (event.type === "question/decided") decided.add(event.data.id);
	const batches = [];
	for (const event of events) if (event.type === "question/asked" && !decided.has(event.data.id)) batches.push({
		id: event.data.id,
		questions: event.data.questions
	});
	return batches;
}
/**
* The per-action lines of a history page, one line per reasoning pass or tool
* call in content order, capped at the most recent {@link maxActions} lines.
* @param events - the history page's raw events (page-ordered, oldest first).
* @param maxActions - maximum number of action lines (most recent) to keep.
* @returns the action lines, oldest first.
*/
function stepActions(events, maxActions = 20) {
	const actions = [];
	for (const event of events) if (event.type === "assistant/message") actions.push(...messageActions(event.data.message, event.time));
	return actions.slice(-maxActions);
}
/**
* The collapsible Telegram-HTML blockquote listing the given actions, one
* time-stamped line per action, or '' when there are none.
* @param actions - the action lines, oldest first.
* @param now - the current Unix epoch millisecond clock (pure injection).
* @returns the `<blockquote expandable>` fragment, or ''.
*/
function actionsHtml(actions, now) {
	if (actions.length === 0) return "";
	return "<blockquote expandable>" + actions.map((action) => startClockLabel(action.time, now) + escapeHtml(action.line)).join("\n") + "</blockquote>";
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
function stepActionsHtml(events, now, maxActions = 20) {
	return actionsHtml(stepActions(events, maxActions), now);
}
/**
* Split long text into Telegram-safe chunks, preferring newline boundaries.
* @param text - the full text.
* @param cap - the maximum chunk length; defaults to {@link TELEGRAM_CHUNK_MAX}.
* @returns one or more chunks within `cap`.
*/
function chunkText(text, cap = TELEGRAM_CHUNK_MAX) {
	const points = Array.from(text);
	if (points.length <= cap) return [text];
	const chunks = [];
	let start = 0;
	while (start < points.length) {
		let end = Math.min(start + cap, points.length);
		if (end < points.length) {
			let lastNewline = -1;
			for (let cursor = end - 1; cursor > start && end - cursor <= 200; cursor--) if (points[cursor] === "\n") {
				lastNewline = cursor;
				break;
			}
			if (lastNewline !== -1) end = lastNewline + 1;
		}
		chunks.push(points.slice(start, end).join(""));
		start = end;
	}
	return chunks;
}
/**
* Remove the trailing replying marker from a stream edit's displayed text,
* restoring the bare body for {@link STREAM_REPLYING_SUFFIX} consumers that
* store what was shown (chunked overflow sends one chunk whole).
* @param text - the displayed text, possibly ending with the marker.
* @returns the text without a trailing marker.
*/
function stripStreamSuffix(text) {
	return text.endsWith("\n\n⏳ 回复中…") ? text.slice(0, -8) : text;
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
function statusStats(events) {
	let users = 0;
	let assistants = 0;
	let tools = 0;
	let chars = 0;
	for (const event of events) switch (event.type) {
		case "user/message":
			if (isWorkspaceInstructionSource(event.data.source)) break;
			users++;
			chars += Array.from(userMessageText(event.data)).length;
			break;
		case "assistant/message":
			assistants++;
			chars += Array.from(assistantMessageText(event.data.message)).length;
			break;
		case "tool/call":
			tools++;
			chars += Array.from(event.data.arguments).length;
			break;
		default: break;
	}
	return {
		users,
		assistants,
		tools,
		chars
	};
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
function sessionKeyboardRows(items, verb) {
	const rows = [...KEYBOARD_ACTION_ROWS.map((row) => [...row])];
	for (const [index, item] of items.slice(0, 15).entries()) {
		const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId);
		rows.push([`/${verb} ${index + 1} · ${sessionGlyph(item)} ${title}`]);
	}
	return rows;
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
function attachKeyboardRows(items) {
	const rows = [...KEYBOARD_ACTION_ROWS.map((row) => [...row])];
	for (const [index, item] of items.entries()) {
		const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId);
		rows.push([`/attach ${index + 1} · ${sessionGlyph(item)} ${title}`]);
	}
	return rows;
}
/**
* One workspace row: index, folding-folder glyph, title, then the canonical
* path and accounted session count on the second line.
* @param index - 1-based row number, also the `/new` selector.
* @param workspace - the workspace row.
* @returns the two-line row text.
*/
function workspaceRow(index, workspace) {
	return `${index}) 📁 ${truncate(workspace.title, 48)}\n   ${workspace.path} · ${workspace.sessionIds.length} 个会话`;
}
/**
* Reply-keyboard rows for a workspace list: the shared actions row first,
* then one button per workspace carrying `/new <n> · <title>` (create a
* session inside that workspace), then the ungrouped-create row
* (`/new none · 未分类`).
* @param workspaces - the workspace rows (registry order).
* @returns the reply-keyboard rows.
*/
function workspaceKeyboardRows(workspaces) {
	const rows = [...KEYBOARD_ACTION_ROWS.map((row) => [...row])];
	for (const [index, workspace] of workspaces.slice(0, 15).entries()) rows.push([`/new ${index + 1} · ${truncate(workspace.title, 8)}`]);
	rows.push([CREATE_UNGROUPED_LABEL]);
	return rows;
}
/** One list row of the session's todo list, with its status glyph. */
function todoRow(index, item) {
	return `${index}) ${item.status === "completed" ? "✅" : item.status === "in_progress" ? "🔄" : "⬜"} ${truncate(item.content, 48)}`;
}
/**
* The session's todo list, rendered with a one-line status summary: completed,
* in progress, and pending counts mirroring the web sidebar's task list.
* @param todos - the session's whole task list.
* @returns the multi-line list text.
*/
function renderTodoList(todos) {
	const done = todos.filter((item) => item.status === "completed").length;
	const active = todos.filter((item) => item.status === "in_progress").length;
	return `📋 任务 ${done} 已完成 · ${active} 进行中 · ${todos.length - done - active} 待处理\n\n${todos.map((item, index) => todoRow(index + 1, item)).join("\n")}`;
}
/**
* The latest complete todo snapshot in a history page, or `null` when the
* page holds no `todo/write` event. `todo/write` is a whole-value projection:
* the last snapshot wins.
* @param events - the history page's raw events (page-ordered, oldest first).
* @returns the latest todo list, or null.
*/
function lastTodoWrite(events) {
	let latest = null;
	for (const event of events) if (event.type === "todo/write") latest = event.data.todos;
	return latest;
}
/**
* Reply-keyboard rows for the preset picker: the shared action rows first,
* then one button per preset carrying `/preset <n> · <name>` — a tap applies
* the preset to the bound session (or stages it for the next /new).
* @param presets - the deployment's preset entries (roster order).
* @returns the reply-keyboard rows.
*/
function presetKeyboardRows(presets) {
	const rows = [...KEYBOARD_ACTION_ROWS.map((row) => [...row])];
	for (const [index, preset] of presets.slice(0, 15).entries()) {
		const label = preset.name ?? preset.id;
		rows.push([`/preset ${index + 1} · ${truncate(label, 6)}`]);
	}
	return rows;
}
/** Callback-data prefixes of the /attach picker buttons (distinct from the ask prefixes). */
const ATTACH_CALLBACK_WORKSPACE = "atw";
const ATTACH_CALLBACK_UNGROUPED = "atn";
const ATTACH_CALLBACK_ARCHIVED = "ata";
const ATTACH_CALLBACK_SESSION = "ats";
/** Callback data of one workspace-scope button. */
function attachWorkspaceData(workspaceId) {
	return `${ATTACH_CALLBACK_WORKSPACE}:${workspaceId}`;
}
/** Callback data of the ungrouped-scope button. */
const ATTACH_UNGROUPED_DATA = `${ATTACH_CALLBACK_UNGROUPED}:1`;
/** Callback data of the archived-scope button. */
const ATTACH_ARCHIVED_DATA = `${ATTACH_CALLBACK_ARCHIVED}:1`;
/** Callback data of one session-bind button. */
function attachSessionData(sessionId) {
	return `${ATTACH_CALLBACK_SESSION}:${sessionId}`;
}
/**
* Parse one /attach picker callback data into its action. Returns
* `undefined` for anything this surface does not emit (a foreign or
* malformed callback).
* @param data - the raw callback data.
* @returns the decoded action, or `undefined` for an unknown token.
*/
function parseAttachCallback(data) {
	const [prefix, id, ...rest] = data.split(":");
	if (id === void 0 || id === "") return void 0;
	if (prefix === ATTACH_CALLBACK_WORKSPACE) {
		if (rest.length !== 0) return void 0;
		return {
			kind: "workspace",
			workspaceId: id
		};
	}
	if (prefix === ATTACH_CALLBACK_UNGROUPED || prefix === ATTACH_CALLBACK_ARCHIVED) {
		if (id !== "1" || rest.length !== 0) return void 0;
		return { kind: prefix === ATTACH_CALLBACK_UNGROUPED ? "ungrouped" : "archived" };
	}
	if (prefix === ATTACH_CALLBACK_SESSION) {
		if (rest.length !== 0) return void 0;
		return {
			kind: "session",
			sessionId: SessionId(id)
		};
	}
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
function attachScopeButtons(workspaces, options) {
	const rows = [];
	for (const workspace of workspaces.slice(0, 15)) rows.push([{
		text: `📁 ${truncate(workspace.title, 6)}`,
		data: attachWorkspaceData(workspace.workspaceId)
	}]);
	if (options.ungrouped) rows.push([{
		text: "未分组",
		data: ATTACH_UNGROUPED_DATA
	}]);
	if (options.archived) rows.push([{
		text: "归档",
		data: ATTACH_ARCHIVED_DATA
	}]);
	return rows;
}
/**
* The inline-keyboard rows of one /attach session list: one bind button per
* visible session, its title shown in full like the reply-row counterpart.
* @param items - the visible session summaries (list order).
* @returns the keyboard rows.
*/
function attachSessionButtons(items) {
	const rows = [];
	for (const item of items.slice(0, 15)) {
		const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId);
		rows.push([{
			text: `${sessionGlyph(item)} ${title}`,
			data: attachSessionData(item.sessionId)
		}]);
	}
	return rows;
}
/** Callback-data prefixes of the session action-list buttons (distinct from the attach prefixes). */
const SESSION_LIST_CALLBACK_STOP = "stp";
const SESSION_LIST_CALLBACK_STATUS = "sta";
/** Callback data of one session-stop button. */
function sessionStopData(sessionId) {
	return `${SESSION_LIST_CALLBACK_STOP}:${sessionId}`;
}
/** Callback data of one session-status button. */
function sessionStatusData(sessionId) {
	return `${SESSION_LIST_CALLBACK_STATUS}:${sessionId}`;
}
/**
* Parse one session action-list callback data into its action. Returns
* `undefined` for anything this surface does not emit (a foreign or
* malformed callback).
* @param data - the raw callback data.
* @returns the decoded action, or `undefined` for an unknown token.
*/
function parseSessionListCallback(data) {
	const [prefix, id, ...rest] = data.split(":");
	if (id === void 0 || id === "") return void 0;
	if (rest.length !== 0) return void 0;
	if (prefix === SESSION_LIST_CALLBACK_STOP) return {
		kind: "stop",
		sessionId: SessionId(id)
	};
	if (prefix === SESSION_LIST_CALLBACK_STATUS) return {
		kind: "status",
		sessionId: SessionId(id)
	};
}
/**
* The inline-keyboard rows of one session action list: one stop or status
* button per visible session, its title shown in full like the attach
* counterpart.
* @param items - the visible session summaries (list order).
* @param verb - the action the buttons carry (`stop` or `status`).
* @returns the keyboard rows.
*/
function sessionActionButtons(items, verb) {
	const rows = [];
	for (const item of items.slice(0, 15)) {
		const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId);
		const glyph = verb === "stop" ? "⏹" : "📊";
		rows.push([{
			text: `${glyph} ${sessionGlyph(item)} ${title}`,
			data: verb === "stop" ? sessionStopData(item.sessionId) : sessionStatusData(item.sessionId)
		}]);
	}
	return rows;
}
/** The submit-row label of a rendered question keyboard. */
const QUESTION_SUBMIT_LABEL = "✅ 提交回答";
/** The cancel-row label of a rendered question keyboard. */
const QUESTION_CANCEL_LABEL = "🚫 取消";
/** The custom-answer button label before the user typed anything. */
const QUESTION_CUSTOM_LABEL = "✍️ 自定义回答";
/** The custom-answer button label once a custom answer is captured. */
const QUESTION_CUSTOM_DONE_LABEL = "✍️ 重新输入回答";
/** Callback-data prefixes; the console routes taps by the first segment. */
const QUESTION_CALLBACK_OPTION = "qo";
const QUESTION_CALLBACK_CUSTOM = "qt";
const QUESTION_CALLBACK_SUBMIT = "qs";
const QUESTION_CALLBACK_CANCEL = "qx";
/** Callback data of one option button. */
function questionOptionData(rpcId, questionIndex, optionIndex) {
	return `${QUESTION_CALLBACK_OPTION}:${rpcId}:${questionIndex}:${optionIndex}`;
}
/** Callback data of one custom-answer button. */
function questionCustomData(rpcId, questionIndex) {
	return `${QUESTION_CALLBACK_CUSTOM}:${rpcId}:${questionIndex}`;
}
/** Callback data of the submit button. */
function questionSubmitData(rpcId) {
	return `${QUESTION_CALLBACK_SUBMIT}:${rpcId}`;
}
/** Callback data of the cancel button. */
function questionCancelData(rpcId) {
	return `${QUESTION_CALLBACK_CANCEL}:${rpcId}`;
}
/**
* Parse one question-button callback data into its action. Returns
* `undefined` for anything this surface does not emit (a foreign or
* malformed callback).
* @param data - the raw callback data.
* @returns the decoded action, or `undefined` for an unknown token.
*/
function parseQuestionCallback(data) {
	const parts = data.split(":");
	const prefix = parts[0];
	const rpcId = parts[1];
	if (rpcId === void 0 || rpcId === "") return void 0;
	if (prefix === QUESTION_CALLBACK_OPTION) {
		if (parts.length !== 4) return void 0;
		const questionIndex = segmentIndex(parts[2]);
		const option = segmentIndex(parts[3]);
		if (questionIndex === void 0 || option === void 0) return void 0;
		return {
			kind: "option",
			rpcId,
			questionIndex,
			optionIndex: option
		};
	}
	if (prefix === QUESTION_CALLBACK_CUSTOM) {
		if (parts.length !== 3) return void 0;
		const questionIndex = segmentIndex(parts[2]);
		if (questionIndex === void 0) return void 0;
		return {
			kind: "custom",
			rpcId,
			questionIndex
		};
	}
	if (prefix === QUESTION_CALLBACK_SUBMIT) {
		if (parts.length !== 2) return void 0;
		return {
			kind: "submit",
			rpcId
		};
	}
	if (prefix === QUESTION_CALLBACK_CANCEL) {
		if (parts.length !== 2) return void 0;
		return {
			kind: "cancel",
			rpcId
		};
	}
}
/** Parse one non-negative integer segment of a callback token. */
function segmentIndex(raw) {
	if (raw === void 0 || !/^\d+$/.test(raw)) return void 0;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) ? parsed : void 0;
}
/**
* The message text of one rendered ask batch.
* @param questions - the questions of the ask batch.
* @returns the text shown above the answer keyboard.
*/
function questionMessageText(questions) {
	const blocks = questions.map((question, index) => {
		const lines = [
			`❓ ${question.header ?? question.question}`,
			...question.header === void 0 ? [] : [question.question],
			...question.detail === void 0 ? [] : [question.detail],
			...question.multiSelect === true ? ["（可多选）"] : []
		];
		return questions.length > 1 ? `【${index + 1}】\n${lines.join("\n")}` : lines.join("\n");
	});
	const footer = questions.length > 1 ? "\n\n全部回答后点「✅ 提交回答」。" : "";
	return `${blocks.join("\n\n")}${footer}`;
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
function questionKeyboard(questions, selected, custom, rpcId) {
	const multiple = questions.length > 1;
	const rows = [];
	for (const [questionIndex, question] of questions.entries()) {
		for (const [optionIndex, option] of (question.options ?? []).entries()) {
			const picked = selected[questionIndex]?.includes(option.label) === true;
			rows.push([{
				text: `${picked ? "✅ " : ""}${multiple ? `${questionIndex + 1}. ` : ""}${option.label}`,
				data: questionOptionData(rpcId, questionIndex, optionIndex)
			}]);
		}
		const hasCustom = custom[questionIndex] !== void 0;
		rows.push([{
			text: multiple ? hasCustom ? `✍️ 重输 Q${questionIndex + 1}` : `✍️ 自定义 Q${questionIndex + 1}` : hasCustom ? QUESTION_CUSTOM_DONE_LABEL : QUESTION_CUSTOM_LABEL,
			data: questionCustomData(rpcId, questionIndex)
		}]);
	}
	rows.push([{
		text: QUESTION_SUBMIT_LABEL,
		data: questionSubmitData(rpcId)
	}]);
	rows.push([{
		text: QUESTION_CANCEL_LABEL,
		data: questionCancelData(rpcId)
	}]);
	return rows;
}
//#endregion
//#region lib/types/markdown.js
/**
* Markdown → Telegram HTML projection for assistant replies. The model's
* GFM markdown is parsed into an mdast tree and serialized to Telegram's
* HTML subset: Telegram has no headings, lists, or tables, so those map to
* bold lines, bullet/number lines, and flattened rows. Raw HTML stays
* literal text, and link destinations pass an http(s) allowlist.
* @module @deepseek-ai/dsh-host-telegram/markdown
*/
/** Telegram <a> supports only absolute HTTP(S) destinations; anything else stays inert text. */
const SAFE_LINK_SCHEME = /^https?:\/\//i;
/** The divider a thematic break renders as. */
const THEMATIC_BREAK = "────────";
/**
* Escape one link destination for an HTML attribute value.
* @param url - the destination URL.
* @returns the entity-escaped URL.
*/
function escapeHref(url) {
	return url.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
/**
* Project GFM markdown to Telegram HTML.
* @param markdown - the assistant-authored markdown source.
* @returns Telegram-HTML text, or an empty string for blank input.
*/
function markdownToTelegramHtml(markdown) {
	const root = fromMarkdown(markdown, {
		extensions: [gfm()],
		mdastExtensions: [gfmFromMarkdown()]
	});
	const definitions = collectDefinitions(root);
	return root.children.map((node) => blockToHtml(node, definitions)).filter((text) => text !== "").join("\n\n");
}
/** Collect reference-style link/image destinations into a lookup map. */
function collectDefinitions(root) {
	const map = /* @__PURE__ */ new Map();
	for (const node of root.children) if (node.type === "definition") map.set(node.identifier.toLowerCase(), node.url);
	return map;
}
/** Serialize one root-level block node. */
function blockToHtml(node, definitions) {
	switch (node.type) {
		case "paragraph": return inlineToHtml(node.children, definitions);
		case "heading": return "<b>" + inlineToHtml(node.children, definitions) + "</b>";
		case "thematicBreak": return THEMATIC_BREAK;
		case "blockquote": return "<blockquote>" + node.children.map((child) => blockToHtml(child, definitions)).filter((text) => text !== "").join("\n") + "</blockquote>";
		case "list": return listToHtml(node, definitions, 0);
		case "code": return codeBlockToHtml(node.value, node.lang);
		case "table": return tableToHtml(node, definitions);
		case "html": return escapeHtml(node.value);
		case "definition":
		case "footnoteDefinition": return "";
		/* v8 ignore next 2 -- merge-extensible block union: unknown node types render nothing. */
		default: return "";
	}
}
/** Serialize a run of inline (phrasing) nodes. */
function inlineToHtml(nodes, definitions) {
	let out = "";
	for (const node of nodes) out += phrasingToHtml(node, definitions);
	return out;
}
/** Serialize one inline node. */
function phrasingToHtml(node, definitions) {
	switch (node.type) {
		case "text": return escapeHtml(node.value);
		case "break": return "\n";
		case "strong": return "<b>" + inlineToHtml(node.children, definitions) + "</b>";
		case "emphasis": return "<i>" + inlineToHtml(node.children, definitions) + "</i>";
		case "delete": return "<s>" + inlineToHtml(node.children, definitions) + "</s>";
		case "inlineCode": return "<code>" + escapeHtml(node.value.replace(/\r?\n|\r/g, " ")) + "</code>";
		case "link": return linkToHtml(node.url, inlineToHtml(node.children, definitions));
		case "linkReference": return linkToHtml(resolveDefinition(definitions, node.identifier), inlineToHtml(node.children, definitions));
		case "image": return escapeHtml(imageAlt(node.alt, node.url));
		case "imageReference": return escapeHtml(imageAlt(node.alt, resolveDefinition(definitions, node.identifier)));
		case "html": return escapeHtml(node.value);
		case "footnoteReference": return escapeHtml("[^" + node.identifier + "]");
		/* v8 ignore next 2 -- merge-extensible phrasing union: unknown node types render nothing. */
		default: return "";
	}
}
/** Resolve a reference-style destination; absent only for a hand-built tree. */
function resolveDefinition(definitions, identifier) {
	/* v8 ignore next -- fromMarkdown keeps unresolvable references as literal text, so parsed references always resolve. */
	return definitions.get(identifier.toLowerCase()) ?? "";
}
/** Wrap one link when its destination is an absolute HTTP(S) URL. */
function linkToHtml(url, text) {
	if (text === "" || !SAFE_LINK_SCHEME.test(url)) return text;
	return "<a href=\"" + escapeHref(url) + "\">" + text + "</a>";
}
/** The alt text an image falls back to when absent. */
function imageAlt(alt, url) {
	/* v8 ignore next -- fromMarkdown emits a (possibly empty) string alt; the null/undefined arms only satisfy the mdast union. */
	return alt === null || alt === void 0 || alt === "" ? url : alt;
}
/** One fenced code block, with a language class when one is present. */
function codeBlockToHtml(value, lang) {
	const escaped = escapeHtml(value);
	const language = /^[\w-]+/.exec(lang ?? "")?.[0];
	return language === void 0 ? "<pre>" + escaped + "</pre>" : "<pre><code class=\"language-" + language + "\">" + escaped + "</code></pre>";
}
/** One GFM table flattened to cell | cell lines with a bold header row. */
function tableToHtml(table, definitions) {
	return table.children.map((row, index) => {
		const line = row.children.map((cell) => inlineToHtml(cell.children, definitions)).join(" | ");
		return index === 0 ? "<b>" + line + "</b>" : line;
	}).join("\n");
}
/** One list flattened to marker-prefixed lines with two-space nesting. */
function listToHtml(list, definitions, depth) {
	const indent = "  ".repeat(depth);
	const lines = [];
	let number = list.start ?? 1;
	for (const item of list.children) {
		const marker = typeof item.checked === "boolean" ? item.checked ? "☑" : "☐" : list.ordered === true ? String(number) + "." : "•";
		const paragraphs = [];
		for (const child of item.children) {
			if (child.type === "list") continue;
			paragraphs.push(blockToHtml(child, definitions));
		}
		const first = paragraphs[0];
		lines.push(first === void 0 ? indent + marker : indent + marker + " " + first);
		for (let i = 1; i < paragraphs.length; i++) lines.push(indent + "  " + paragraphs[i]);
		for (const child of item.children) if (child.type === "list") lines.push(listToHtml(child, definitions, depth + 1));
		number++;
	}
	return lines.join("\n");
}
//#endregion
//#region lib/types/console.js
/**
* Chat-bound remote console over a {@link SessionConsolePort}: command
* routing, session binding, prompt forwarding, and realtime push of the bound
* session's events. Pure orchestration — I/O goes through the injected port
* and transport, so unit tests drive the full flow without a live bot or
* harness.
* @module @deepseek-ai/dsh-host-telegram/console
*/
/**
* Interpret one incoming text: a leading backslash escapes the following
* text verbatim (so `/`-leading text reaches the harness), a leading `/`
* names a console command (with any `@bot` suffix stripped), and anything
* else is a prompt for the open session.
* @param text - the raw incoming text.
* @returns the command or prompt interpretation.
*/
function interpretInput(text) {
	if (text.startsWith("\\")) return {
		kind: "prompt",
		text: text.slice(1)
	};
	if (!text.startsWith("/")) return {
		kind: "prompt",
		text
	};
	/* v8 ignore start -- the command branch guarantees a leading-token split. */
	const [rawName, ...rest] = text.split(/\s+/);
	/* v8 ignore stop */
	return {
		name: ((rawName ?? "").split("@")[0] ?? "").toLowerCase().slice(1),
		args: rest.join(" ")
	};
}
/**
* Chat-bound remote console over the harness sessions.
*
* One console instance lives for the plugin lifetime. Command replies and
* event pushes go through {@link ConsoleTransport}; session reads and writes
* go through {@link SessionConsolePort}. Choose the prompt mode by the last
* known agent activity: interject (`steer`) while the bound session runs,
* queue otherwise — cold sessions resume through the port's prompt path.
*/
var TelegramConsole = class {
	#port;
	#transport;
	#now;
	#chats = /* @__PURE__ */ new Map();
	/**
	* One chat's in-flight event-push chain. Events bound to the same chat are
	* serialized so a later event never reads stream state mid-edit of an
	* earlier one (e.g. `turn/end` must see the assistant text its edit
	* finalized, not the empty stream of the still-in-flight edit).
	*/
	#chains = /* @__PURE__ */ new Map();
	/**
	* @param port - session operations (ApiProxy adapter).
	* @param transport - outbound Telegram surface.
	* @param now - clock injection for relative timestamp rendering.
	*/
	constructor(port, transport, now = () => Date.now()) {
		this.#port = port;
		this.#transport = transport;
		this.#now = now;
	}
	/**
	* Handle one allowed chat's incoming text message (commands and prompts).
	* @param chatId - the sender chat id.
	* @param text - the raw message text.
	* @returns after replies are dispatched.
	*/
	async handleMessage(chatId, text) {
		const state = this.#state(chatId);
		const input = interpretInput(text);
		if ("kind" in input) {
			state.awaitingConfirm = void 0;
			if (state.awaitingRename) {
				await this.#handlePendingRename(chatId, state, input.text);
				return;
			}
			if (state.awaitingAskAnswer !== void 0) {
				await this.#handleAskCustomText(chatId, state, state.awaitingAskAnswer, input.text);
				return;
			}
			await this.#handlePrompt(chatId, state, input.text);
			return;
		}
		state.awaitingRename = false;
		state.awaitingAskAnswer = void 0;
		const command = input;
		try {
			await this.#handleCommand(chatId, state, command);
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Push one session event to every chat bound to that session. User
	* messages are never pushed — the chat sees the agent's side only, so
	* non-text blocks and tool noise are suppressed too. A turn streams on
	* one live message: `turn/start` opens a `🤔 thinking…` placeholder, assistant steps
	* edit it in place (spilling onto a fresh chunked message past the chunk
	* budget or after a failed edit), and `turn/end` closes it with the outcome
	* label only when the turn did not complete with a reply — a completed
	* reply finalizes its own message, while `aborted`/`error`/`interrupted` ends
	* append the label (an `error` end carries its structured failure reason),
	* and a failed label edit falls back to a fresh message so the outcome is
	* never lost.
	* @param sessionId - the emitting session.
	* @param event - the raw session event.
	* @returns after all targeted pushes dispatch.
	*/
	async onSessionEvent(sessionId, event) {
		const pushes = [];
		for (const [chatId, state] of this.#chats) {
			if (state.sessionId !== sessionId) continue;
			const push = (this.#chains.get(chatId) ?? Promise.resolve()).then(() => this.#pushEvent(chatId, state, sessionId, event));
			this.#chains.set(chatId, push.then(() => void 0, () => void 0));
			pushes.push(push);
		}
		const failure = (await Promise.allSettled(pushes)).find((result) => result.status === "rejected");
		if (failure !== void 0) throw failure.reason;
	}
	/**
	* Push one session event to one bound chat. User messages are never pushed
	* — the chat sees the agent's side only, so non-text blocks and tool noise
	* are suppressed too. A turn streams on one live message: `turn/start` opens
	* a `🤔 thinking…` placeholder, assistant steps edit it in place (spilling
	* onto a fresh chunked message past the chunk budget or after a failed
	* edit), and `turn/end` closes it with the outcome label only when the turn
	* did not complete with a reply — a completed reply finalizes its own
	* message, while `aborted`/`error`/`interrupted` ends append the label (an
	* `error` end carries its structured failure reason), and a failed label
	* edit falls back to a fresh message so the outcome is never lost.
	* @param chatId - the bound chat.
	* @param state - the chat's console state.
	* @param sessionId - the emitting session.
	* @param event - the raw session event.
	* @returns after the push dispatches.
	*/
	async #pushEvent(chatId, state, sessionId, event) {
		switch (event.type) {
			case "turn/start":
				state.stream = {
					messageId: await this.#transport.sendMessage(chatId, "🤔 thinking…"),
					text: ""
				};
				state.turnUsage = emptyRoundUsage();
				state.turnActions = [];
				state.turnStartTime = event.time;
				state.typing = true;
				break;
			case "assistant/message": {
				accumulateRoundUsage(state.turnUsage, event.data.usage);
				const text = blockText(event.data.message.content);
				if (text !== "") await this.#publishAssistant(chatId, state, text);
				state.turnActions.push(...messageActions(event.data.message, event.time));
				break;
			}
			case "turn/end": {
				const stream = state.stream;
				const reason = event.data.reason;
				const label = reason.kind === "completed" && stream !== void 0 && stream.text !== "" ? void 0 : turnOutcomeLabel(reason);
				const footer = roundUsageFooter(state.turnUsage);
				const toolHtml = actionsHtml(state.turnActions, this.#now());
				state.stream = void 0;
				state.typing = false;
				state.turnActions = [];
				state.turnStartTime = void 0;
				for (const [rpcId, pending] of [...state.pendingAsks]) {
					if (!pending.answered) continue;
					await this.#transport.editInlineKeyboard(chatId, pending.messageId, "✅ 已回答。", []);
					state.pendingAsks.delete(rpcId);
				}
				if (footer === "" && toolHtml === "") {
					try {
						if (stream !== void 0) await this.#transport.editMessage(chatId, stream.messageId, label === void 0 ? stream.text : stream.text === "" ? label : `${stream.text}\n${label}`);
						else await this.#reply(chatId, label ?? "");
					} catch (error) {
						if (stream === void 0) throw error;
						console.warn(`telegram: turn label edit failed, sending a fresh message instead: ${String(error)}`);
						if (label !== void 0) await this.#reply(chatId, label);
					}
					break;
				}
				let body;
				if (stream === void 0 || stream.text === "")
 // v8 ignore next -- unreachable: an empty body implies a defined label
				body = label ?? "";
				else if (label === void 0) body = stream.text;
				else body = `${stream.text}\n${label}`;
				const html = markdownToTelegramHtml(body) + (toolHtml === "" ? "" : "\n\n" + toolHtml) + footer;
				try {
					if (stream !== void 0) await this.#transport.editMessageHtml(chatId, stream.messageId, html);
					else await this.#transport.sendMessageHtml(chatId, html);
				} catch (error) {
					if (stream === void 0) throw error;
					console.warn(`telegram: turn footer edit failed, sending a fresh message instead: ${String(error)}`);
					await this.#transport.sendMessageHtml(chatId, html);
				}
				break;
			}
			default: break;
			case "question/asked":
				await this.#renderAsk(chatId, state, sessionId, event.data.id, event.data.questions);
				break;
			case "question/decided":
				await this.#settleAsk(chatId, state, event.data.id, event.data.outcome);
				break;
		}
	}
	/**
	* Drive the Telegram typing indicator for chats whose bound session runs a
	* turn. Called on a fixed interval by the entry.
	* @returns after every pending chat action dispatched.
	*/
	async pumpTyping() {
		for (const [chatId, state] of this.#chats) if (state.typing) await this.#transport.sendChatAction(chatId, "typing");
	}
	#state(chatId) {
		let state = this.#chats.get(chatId);
		if (state === void 0) {
			state = {
				sessionId: void 0,
				rows: void 0,
				workspaces: void 0,
				attachScopes: false,
				keyboard: void 0,
				attachKeyboard: void 0,
				typing: false,
				stream: void 0,
				turnUsage: emptyRoundUsage(),
				turnActions: [],
				turnStartTime: void 0,
				awaitingRename: false,
				pendingAsks: /* @__PURE__ */ new Map(),
				awaitingAskAnswer: void 0,
				nextPreset: void 0,
				awaitingConfirm: void 0
			};
			this.#chats.set(chatId, state);
		}
		return state;
	}
	/**
	* Handle one allowed chat's inline-button tap. Two surfaces share the
	* same chat: the /attach picker buttons (workspace scopes, session binds)
	* and the rendered ask buttons. A tap on a stale or unknown button gets a
	* ⛔ reply; attach taps navigate or bind, and ask taps mutate the pending
	* ask (option pick, custom-answer arm, submit, cancel) and settle it
	* through the port.
	* @param chatId - the sender chat id.
	* @param data - the button's callback data.
	* @returns after the reply/edit for this tap dispatches.
	*/
	async handleCallback(chatId, data) {
		const state = this.#state(chatId);
		const attach = parseAttachCallback(data);
		if (attach !== void 0) {
			try {
				switch (attach.kind) {
					case "session":
						await this.#performAttach(chatId, state, attach.sessionId);
						break;
					case "workspace":
						await this.#attachWorkspaceSessions(chatId, state, attach.workspaceId);
						break;
					case "ungrouped":
						await this.#attachUngrouped(chatId, state);
						break;
					case "archived":
						await this.#attachArchived(chatId, state);
						break;
				}
			} catch (error) {
				await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}
		const list = parseSessionListCallback(data);
		if (list !== void 0) {
			try {
				if (list.kind === "stop") {
					await this.#port.stopSession(list.sessionId);
					await this.#reply(chatId, "⏹ 已请求停止。");
				} else {
					const details = await this.#statusDetails(chatId, list.sessionId);
					if (details !== void 0) await this.#reply(chatId, details);
				}
			} catch (error) {
				await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}
		const parsed = parseQuestionCallback(data);
		if (parsed === void 0) {
			await this.#reply(chatId, "⛔ 未知按钮。");
			return;
		}
		const pending = state.pendingAsks.get(parsed.rpcId);
		if (pending === void 0 || pending.answered) {
			await this.#reply(chatId, "⛔ 该提问已失效（可能已在别处回答）。");
			return;
		}
		try {
			switch (parsed.kind) {
				case "option":
					await this.#tapOption(chatId, pending, parsed.questionIndex, parsed.optionIndex);
					break;
				case "custom":
					await this.#armCustom(chatId, state, pending, parsed.questionIndex);
					break;
				case "submit":
					await this.#submitAsk(chatId, pending);
					break;
				case "cancel":
					await this.#cancelAsk(chatId, state, pending);
					break;
			}
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Render one ask batch for one chat: one message with the questions text
	* and the option/action keyboard, plus the chat's answer-collection state.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param sessionId - the session owning the ask (the chat's binding).
	* @param rpcId - the host question id.
	* @param questions - the questions of the ask batch.
	* @returns after the keyboard message dispatches.
	*/
	async #renderAsk(chatId, state, sessionId, rpcId, questions) {
		const messageId = await this.#transport.sendInlineKeyboard(chatId, questionMessageText(questions), questionKeyboard(questions, questions.map(() => []), questions.map(() => void 0), rpcId));
		state.pendingAsks.set(rpcId, {
			rpcId,
			sessionId,
			messageId,
			questions,
			selected: questions.map(() => []),
			custom: questions.map(() => void 0),
			answered: false
		});
	}
	/**
	* Finalize one rendered ask when the host settles it (answered elsewhere,
	* cancelled, or answered here): a cancelled ask is dropped immediately,
	* while an answered ask shows the in-progress label and stays registered
	* until the owning turn closes — the agent's reply is only complete then,
	* so the keyboard is finalized by {@link onSessionEvent}'s turn/end arm.
	* @param chatId - the chat holding the message.
	* @param state - the chat's console state.
	* @param rpcId - the settled question id.
	* @param outcome - the settlement outcome.
	* @returns after the edit dispatches.
	*/
	async #settleAsk(chatId, state, rpcId, outcome) {
		const pending = state.pendingAsks.get(rpcId);
		if (pending === void 0) return;
		if (state.awaitingAskAnswer?.rpcId === rpcId) state.awaitingAskAnswer = void 0;
		if (outcome === "cancelled") {
			await this.#transport.editInlineKeyboard(chatId, pending.messageId, "🚫 已取消。", []);
			state.pendingAsks.delete(rpcId);
			return;
		}
		await this.#transport.editInlineKeyboard(chatId, pending.messageId, "⏳ 回答中…", []);
		pending.answered = true;
	}
	/** Re-render one pending ask's keyboard from the collected answer state. */
	async #refreshAskKeyboard(chatId, pending) {
		await this.#transport.editInlineKeyboard(chatId, pending.messageId, questionMessageText(pending.questions), questionKeyboard(pending.questions, pending.selected, pending.custom, pending.rpcId));
	}
	/**
	* Handle one option-button tap. A single-select ask of exactly one question
	* answers immediately with the tapped option; any other tap collects the
	* selection (multi-select toggles, single-select replaces) and re-renders
	* the keyboard for the user to finish with submit.
	* @param chatId - the sender chat id.
	* @param state - the chat's console state.
	* @param pending - the live pending ask.
	* @param questionIndex - the tapped question.
	* @param optionIndex - the tapped option.
	* @returns after the answer or keyboard refresh dispatches.
	*/
	async #tapOption(chatId, pending, questionIndex, optionIndex) {
		const question = pending.questions[questionIndex];
		const option = question?.options?.[optionIndex];
		if (question === void 0 || option === void 0) {
			await this.#reply(chatId, "⛔ 该提问已失效（选项已更新，请重选）。");
			return;
		}
		const isMulti = question.multiSelect === true;
		const selected = pending.selected[questionIndex];
		/* v8 ignore next -- #renderAsk seeds every question with an empty selection array */
		if (selected === void 0) return;
		if (isMulti) {
			const at = selected.indexOf(option.label);
			if (at === -1) selected.push(option.label);
			else selected.splice(at, 1);
		} else {
			pending.selected[questionIndex] = [option.label];
			pending.custom[questionIndex] = void 0;
		}
		if (!isMulti && pending.questions.length === 1) {
			await this.#submitAsk(chatId, pending);
			return;
		}
		await this.#refreshAskKeyboard(chatId, pending);
	}
	/**
	* Arm the custom-answer flow for one question: the next non-command text
	* in the chat becomes its custom answer instead of a prompt. For
	* single-select questions the collected option is dropped, keeping the
	* answer shape valid (a single-select answer may not carry both).
	* @param chatId - the sender chat id.
	* @param state - the chat's console state.
	* @param pending - the live pending ask.
	* @param questionIndex - the question to answer in free text.
	* @returns after the hint reply dispatches.
	*/
	async #armCustom(chatId, state, pending, questionIndex) {
		const question = pending.questions[questionIndex];
		if (question === void 0) return;
		if (question.multiSelect !== true) pending.selected[questionIndex] = [];
		state.awaitingRename = false;
		state.awaitingAskAnswer = {
			rpcId: pending.rpcId,
			questionIndex
		};
		await this.#reply(chatId, `✍️ 请直接输入对「${truncate(question.question, 60)}」的回答（发送文本即可）。`);
	}
	/**
	* Submit the collected answer batch for one ask. Every question must carry
	* at least one picked option or a captured custom answer; the host rejects
	* incomplete batches, so the submit is blocked here with a hint instead.
	* @param chatId - the sender chat id.
	* @param state - the chat's console state.
	* @param pending - the live pending ask.
	* @returns after the answer settles or the incompleteness hint dispatches.
	*/
	async #submitAsk(chatId, pending) {
		const answers = pending.questions.map((question, index) => {
			const custom = pending.custom[index]?.trim();
			const selected = pending.selected[index];
			if (custom !== void 0 && custom !== "")
 /* v8 ignore next -- multiSelect selections are always present arrays */
			return {
				id: question.id,
				selected: question.multiSelect === true ? selected ?? [] : [],
				custom
			};
			if (selected !== void 0 && selected.length > 0) return {
				id: question.id,
				selected
			};
		});
		const incomplete = pending.questions.findIndex((_, index) => answers[index] === void 0);
		if (incomplete !== -1) {
			const question = pending.questions[incomplete];
			/* v8 ignore next -- findIndex only returns indexes inside the batch */
			if (question === void 0) return;
			await this.#reply(chatId, `⛔ 还有问题「${truncate(question.question, 40)}」未回答：选择选项或点「✍️ 自定义回答」。`);
			return;
		}
		await this.#port.answerQuestion(pending.rpcId, pending.sessionId, { answers });
	}
	/**
	* Cancel one pending ask (the host rejects it as cancelled; the turn's tool
	* call fails closed). The decided event finalizes the rendered message.
	* @param chatId - the sender chat id.
	* @param state - the chat's console state.
	* @param pending - the live pending ask.
	* @returns after the cancel dispatches.
	*/
	async #cancelAsk(chatId, state, pending) {
		await this.#port.cancelQuestion(pending.rpcId);
		if (state.awaitingAskAnswer?.rpcId === pending.rpcId) state.awaitingAskAnswer = void 0;
		await this.#reply(chatId, "🚫 已取消该提问。");
	}
	/**
	* Consume one free-text message as the custom answer of an armed question:
	* record it (blank text cancels the arm) and let the user finish with
	* submit. A binding change or a `/` command clears the arm before this
	* path can run.
	* @param chatId - the sender chat id.
	* @param state - the chat's console state.
	* @param awaiting - the armed question (rpcId + index).
	* @param text - the raw incoming text.
	* @returns after the answer record or cancel dispatches.
	*/
	async #handleAskCustomText(chatId, state, awaiting, text) {
		state.awaitingAskAnswer = void 0;
		const pending = state.pendingAsks.get(awaiting.rpcId);
		/* v8 ignore next -- settleAsk and cancelAsk clear the arm together with the pending entry */
		if (pending === void 0) {
			await this.#reply(chatId, "⛔ 该提问已失效（可能已在别处回答）。");
			return;
		}
		const question = pending.questions[awaiting.questionIndex];
		/* v8 ignore next -- the arm index is bounded by #armCustom's own guard */
		if (question === void 0) return;
		const custom = text.trim();
		if (custom === "") {
			await this.#reply(chatId, "↩️ 已取消自定义回答。");
			return;
		}
		if (question.multiSelect !== true) pending.selected[awaiting.questionIndex] = [];
		pending.custom[awaiting.questionIndex] = custom;
		await this.#refreshAskKeyboard(chatId, pending);
		await this.#reply(chatId, `✅ 已记录对「${truncate(question.question, 40)}」的回答，点「✅ 提交回答」完成。`);
	}
	/** Drop every rendered ask and the custom-answer arm (the binding changed). */
	#clearAsks(state) {
		state.pendingAsks.clear();
		state.awaitingAskAnswer = void 0;
	}
	/**
	* Consume one free-text title a bare `/rename` is awaiting: apply it to the
	* bound session and confirm, cancel on blank text, and report when the
	* binding vanished meanwhile. Any non-command text counts as the title —
	* including backslash-escaped input, which never interprets as a command.
	* The pending flag clears before the first reply.
	* @param chatId - the sender chat id.
	* @param state - the chat's console state.
	* @param text - the candidate title text.
	* @returns after the rename or cancel dispatches.
	*/
	async #handlePendingRename(chatId, state, text) {
		state.awaitingRename = false;
		const title = text.trim();
		if (title === "") {
			await this.#reply(chatId, "↩️ 已取消重命名。");
			return;
		}
		/* v8 ignore start --
		* Defense-only: every flow that clears the binding reroutes through
		* handleMessage's command branch, which cancels the pending rename
		* first; only a future binding-clearing flow reaching this state
		* directly would trip it.
		*/
		const sessionId = state.sessionId;
		if (sessionId === void 0) {
			await this.#reply(chatId, "⛔ 当前无激活会话，无法重命名。请先绑定会话（如 /attach）。");
			return;
		}
		/* v8 ignore stop */
		try {
			const accepted = await this.#port.renameSession(sessionId, title);
			await this.#reply(chatId, `✅ 已重命名为 ${accepted}`);
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Forward one free-text prompt to the bound session.
	* @param chatId - the sender chat id.
	* @param state - the chat's console state.
	* @param text - the prompt text.
	* @returns after the forward dispatches (a refusal reply on failure).
	*/
	async #handlePrompt(chatId, state, text) {
		const sessionId = state.sessionId;
		if (sessionId === void 0) {
			await this.#reply(chatId, "还没有绑定会话。发 /attach（无参数先选工作区/未分组/归档）选择并绑定一个会话。");
			return;
		}
		if (text.trim() === "") return;
		try {
			if (state.typing) {
				await this.#port.sendPrompt(sessionId, "steer", text);
				return;
			}
			await this.#port.sendPrompt(sessionId, "queue", text);
			await this.#reply(chatId, `📥 已加入队列：${truncate(text, 200)}`);
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async #handleCommand(chatId, state, command) {
		if (state.awaitingConfirm !== void 0 && state.awaitingConfirm.command !== command.name) state.awaitingConfirm = void 0;
		switch (command.name) {
			case "start":
				await this.#resetActionRows(chatId, state);
				await this.#reply(chatId, HELP_TEXT);
				return;
			case "attach":
				await this.#commandAttach(chatId, state, command.args);
				return;
			case "keyboard":
				await this.#commandKeyboard(chatId, state);
				return;
			case "close": return this.#commandClose(chatId, state);
			case "stop":
				await this.#commandStop(chatId, state, command.args);
				return;
			case "status":
				await this.#commandStatus(chatId, state, command.args);
				return;
			case "model":
				await this.#commandModel(chatId, state, command.args);
				return;
			case "create": return this.#commandCreate(chatId, state);
			case "operate": return this.#commandOperate(chatId, state);
			case "new":
				await this.#commandNew(chatId, state, command.args);
				return;
			case "rename":
				await this.#commandRename(chatId, state, command.args);
				return;
			case "fork":
				await this.#commandFork(chatId, state, command.args);
				return;
			case "archive":
				await this.#commandArchive(chatId, state, command.args);
				return;
			case "delete":
				await this.#commandDelete(chatId, state, command.args);
				return;
			case "curtasks":
				await this.#commandCurTasks(chatId, state);
				return;
			case "preset":
				await this.#commandPreset(chatId, state, command.args);
				return;
			default: await this.#reply(chatId, `未知命令 /${command.name}。发送 /start 查看可用命令。`);
		}
	}
	/**
	* Print the visible session list with a reply keyboard whose session
	* buttons carry finished `/delete <n> · <title>` commands — tapping sends
	* the command verbatim, so a parameterless invocation never dead-ends on a
	* missing-argument error. Updates `state.rows` and clears the /attach
	* scope-picker state, so a following numeric `/attach <n>` resolves inside
	* this list; an empty list degrades to a hint. Records the list as the
	* chat's visible keyboard, so a delete or rename re-emits it with the same
	* hint. (/stop and /status never reach here — their lists are inline.)
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param hint - the header line above the list.
	* @returns after the keyboard message dispatches.
	*/
	async #sessionListKeyboard(chatId, state, hint) {
		const visible = (await this.#port.listSessions()).filter((item) => !item.blank && item.origin !== "subagent");
		state.rows = visible;
		state.attachScopes = false;
		state.attachKeyboard = void 0;
		if (visible.length === 0) {
			state.keyboard = void 0;
			await this.#reply(chatId, "当前没有可用会话。用 /new 创建一个。");
			return;
		}
		state.keyboard = {
			kind: "sessions",
			hint,
			recipe: { list: "full" }
		};
		const now = this.#now();
		const body = visible.slice(0, 15).map((item, index) => sessionRow(index + 1, item, now)).join("\n");
		await this.#transport.sendReplyKeyboard(chatId, `${hint}\n\n${body}`, sessionKeyboardRows(visible, "delete"));
	}
	/**
	* Print the visible session list as an inline keyboard whose buttons carry
	* callback actions — `/stop` stops the tapped session, `/status` shows its
	* details — the `/attach`-picker interaction, so the reply keyboard area
	* stays untouched. Updates `state.rows` so the typed `/status <n>` path
	* keeps working; an empty list degrades to a hint.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param hint - the header line above the list.
	* @param verb - the action the buttons carry (`stop` or `status`).
	* @returns after the keyboard message dispatches.
	*/
	async #sessionListInline(chatId, state, hint, verb) {
		const visible = (await this.#port.listSessions()).filter((item) => !item.blank && item.origin !== "subagent");
		state.rows = visible;
		state.attachScopes = false;
		if (visible.length === 0) {
			state.keyboard = void 0;
			await this.#reply(chatId, "当前没有可用会话。用 /new 创建一个。");
			return;
		}
		const now = this.#now();
		const body = visible.slice(0, 15).map((item, index) => sessionRow(index + 1, item, now)).join("\n");
		await this.#transport.sendInlineKeyboard(chatId, `${hint}\n\n${body}\n\n${SESSION_STATE_LEGEND}`, sessionActionButtons(visible, verb));
	}
	/**
	* Print the workspace list with a reply keyboard whose buttons carry
	* `/new <n> · <title>` (create a session inside that workspace) plus the
	* ungrouped-create row — a parameterless creation flow that never needs an
	* id. Updates `state.workspaces` for `/new <n>` selectors; an empty
	* registry degrades to a hint.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param hint - the header line above the list.
	* @returns after the keyboard message dispatches.
	*/
	async #workspaceListKeyboard(chatId, state, hint) {
		const items = await this.#port.listWorkspaces();
		state.workspaces = [...items];
		state.attachKeyboard = void 0;
		if (items.length === 0) {
			state.keyboard = void 0;
			await this.#reply(chatId, "还没有工作区。发 /new <服务器目录路径> 新建工作区并创建会话，或 /new none 创建未分类会话。");
			return;
		}
		state.keyboard = { kind: "workspaces" };
		const body = items.slice(0, 15).map((item, index) => workspaceRow(index + 1, item)).join("\n");
		await this.#transport.sendReplyKeyboard(chatId, `${hint}\n\n${body}`, workspaceKeyboardRows(items));
	}
	/**
	* Resolve a bare index as a 1-based row of the last workspace-keyboard
	* output (opened by a bare `/new`).
	* @param state - the chat's console state.
	* @param raw - the numeric selector.
	* @returns the workspace row, or undefined when the index is stale.
	*/
	#resolveWorkspace(state, raw) {
		/* v8 ignore start --
		* Only #commandNew calls this, and only after its own /^\d+$/ check, so
		* the non-numeric guard here is defense-only dead code.
		*/
		if (!/^\d+$/.test(raw)) return void 0;
		return state.workspaces?.at(Number(raw) - 1);
		/* v8 ignore stop */
	}
	/**
	* The sessions the /attach scopes surface, partitioned once: archived
	* membership wins over workspace accounting (an archived session stays
	* hidden from its workspace group), then the owning workspace, then
	* ungrouped. Display order follows the session list (updatedAt descending).
	* @returns the partition for the /attach scope flow.
	*/
	async #partitionSessions() {
		const [items, archivedIds, workspaces] = await Promise.all([
			this.#port.listSessions(),
			this.#port.listArchivedSessionIds(),
			this.#port.listWorkspaces()
		]);
		const visible = items.filter((item) => !item.blank && item.origin !== "subagent");
		const archived = new Set(archivedIds);
		const archivedList = [];
		const ungrouped = [];
		const byWorkspace = /* @__PURE__ */ new Map();
		for (const item of visible) {
			if (archived.has(item.sessionId)) {
				archivedList.push(item);
				continue;
			}
			const workspace = workspaces.find((entry) => entry.sessionIds.includes(item.sessionId));
			if (workspace === void 0) {
				ungrouped.push(item);
				continue;
			}
			const bucket = byWorkspace.get(workspace.workspaceId);
			if (bucket === void 0) byWorkspace.set(workspace.workspaceId, [item]);
			else bucket.push(item);
		}
		return {
			workspaces,
			archived: archivedList,
			ungrouped,
			byWorkspace
		};
	}
	/**
	* Bind this chat to the target session and show its last {@link ATTACH_ROUNDS}
	* user/assistant exchanges. A bare invocation opens the scope picker as
	* inline buttons (workspaces, ungrouped, archived) and installs the attach
	* keyboard (running sessions, then the five most recently completed) beside
	* it; `none` lists the ungrouped sessions, `arc` (or `archived`) the
	* archived ones, and picking a workspace or a session is a tap on the
	* picker's inline buttons. While the attach keyboard is installed a numeric
	* `/attach <n>` binds its rows (typed or tapped alike); with no attach
	* keyboard up a number still selects the workspace row, and otherwise the
	* target resolves inside the last visible session list. The history read
	* happens before the binding changes, so a bad id never displaces an open
	* session.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param args - the argument text.
	* @returns after the bind or list reply dispatches.
	*/
	async #commandAttach(chatId, state, args) {
		await this.#resetActionRows(chatId, state);
		const [rawTarget] = splitArgs(args);
		if (rawTarget === "") {
			await this.#attachScopePicker(chatId, state);
			return;
		}
		if (rawTarget === "none") {
			await this.#attachUngrouped(chatId, state);
			return;
		}
		if (rawTarget === "arc" || rawTarget === "archived") {
			await this.#attachArchived(chatId, state);
			return;
		}
		if (/^\d+$/.test(rawTarget) && state.attachKeyboard !== void 0) {
			const row = state.attachKeyboard.at(Number(rawTarget) - 1);
			if (row === void 0) {
				await this.#reply(chatId, `序号 ${rawTarget} 超出范围：先 /attach 刷新列表`);
				return;
			}
			await this.#performAttach(chatId, state, row.sessionId);
			return;
		}
		if (state.attachScopes && /^\d+$/.test(rawTarget)) {
			const workspace = state.workspaces?.at(Number(rawTarget) - 1);
			if (workspace === void 0) {
				await this.#reply(chatId, `工作区序号 ${rawTarget} 超出范围：先 /attach 刷新范围列表`);
				return;
			}
			await this.#attachWorkspaceSessions(chatId, state, workspace.workspaceId);
			return;
		}
		const resolved = this.#resolveTarget(state, rawTarget);
		if ("miss" in resolved) {
			await this.#reply(chatId, resolved.miss);
			return;
		}
		await this.#performAttach(chatId, state, resolved.id);
	}
	/**
	* Bind this chat to one session and show its attach preview: the last
	* {@link ATTACH_ROUNDS} assistant replies (user messages never render),
	* the in-progress marker while the turn is still open, and any
	* unanswered ask re-rendered as an answerable keyboard. A finished session
	* (its latest turn has ended) closes the preview with the same token-usage
	* footer a streamed turn ends with — the `assistant/message` usage of its
	* last completed turn. The binding also reconciles the chat's live-stream
	* state with the attached history: an open turn drives the typing
	* indicator and seeds the turn usage/footer clock, a closed one stops any
	* leftover typing and drops a stale stream from a previous binding. Shared
	* by the typed `/attach <id>` path and the inline session buttons.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param sessionId - the session to bind.
	* @returns after the preview dispatches.
	*/
	async #performAttach(chatId, state, sessionId) {
		const events = await this.#port.readHistory(sessionId, 40);
		const open = turnOpen(events);
		state.sessionId = sessionId;
		this.#clearAsks(state);
		state.stream = void 0;
		state.turnActions = [];
		state.typing = open;
		state.turnStartTime = open ? latestTurnStartTime(events) : void 0;
		state.turnUsage = open ? openTurnUsage(events) : emptyRoundUsage();
		const replies = assistantTail(events, 2);
		const preview = replies.length === 0 ? "（空白会话）" : replies.map((text) => `${ASSISTANT_ROLE_GLYPH} ${text}`).join("\n");
		const header = `🔗 已绑定 ${sessionId}（${shortSessionId(sessionId)}）\n\n最近 2 轮对话：`;
		for (const chunk of chunkText(`${header}\n${preview}`)) await this.#transport.sendMessageHtml(chatId, markdownToTelegramHtml(chunk));
		if (open) {
			const toolHtml = stepActionsHtml(events, this.#now(), 20);
			if (toolHtml !== "") await this.#transport.sendMessageHtml(chatId, "🔧 进行中：\n" + toolHtml);
			else await this.#transport.sendMessageHtml(chatId, "⏳ 进行中…");
		}
		for (const batch of pendingAskBatches(events)) await this.#renderAsk(chatId, state, sessionId, batch.id, batch.questions);
		if (!open) {
			const footer = roundUsageFooter(lastTurnUsage(events));
			if (footer !== "") await this.#transport.sendMessageHtml(chatId, footer);
		}
	}
	/** The scope picker: workspaces first, then ungrouped and archived when non-empty. */
	async #attachScopePicker(chatId, state) {
		const { workspaces, ungrouped, archived } = await this.#partitionSessions();
		state.workspaces = [...workspaces];
		state.rows = void 0;
		state.attachScopes = true;
		state.keyboard = { kind: "scopes" };
		const body = workspaces.length === 0 ? "还没有工作区。" : workspaces.slice(0, 15).map((item, index) => workspaceRow(index + 1, item)).join("\n");
		const scopes = [...ungrouped.length > 0 ? ["/attach none（未分组）"] : [], ...archived.length > 0 ? ["/attach arc（归档）"] : []];
		const header = scopes.length === 0 ? "选择会话范围：点下方的范围按钮，或直接 /attach <会话id>。" : `选择会话范围：点下方的范围按钮（或 ${scopes.join("、")}），或直接 /attach <会话id>。`;
		await this.#attachKeyboardInstall(chatId, state);
		await this.#transport.sendInlineKeyboard(chatId, `${header}\n\n${body}`, attachScopeButtons(workspaces, {
			ungrouped: ungrouped.length > 0,
			archived: archived.length > 0
		}));
	}
	/**
	* List one scope's sessions with inline bind buttons; the numbered rows
	* keep the typed `/attach <n>` path working alongside the taps. Records
	* the list as the chat's visible keyboard with its re-emission recipe, so
	* a delete or rename re-emits the same scoped list; an empty scope
	* degrades to a hint.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param hint - the header line above the list.
	* @param items - the scope's session summaries in display order.
	* @param recipe - the keyboard's re-emission recipe.
	* @returns after the keyboard message dispatches.
	*/
	async #attachList(chatId, state, hint, items, recipe) {
		state.rows = [...items];
		state.attachScopes = false;
		if (items.length === 0) {
			state.keyboard = void 0;
			await this.#reply(chatId, `${hint}（暂无会话）`);
			return;
		}
		state.keyboard = {
			kind: "sessions",
			hint,
			recipe
		};
		const now = this.#now();
		const body = items.slice(0, 15).map((item, index) => sessionRow(index + 1, item, now)).join("\n");
		await this.#transport.sendInlineKeyboard(chatId, `${hint}\n\n${body}\n\n${SESSION_STATE_LEGEND}`, attachSessionButtons(items));
		if (state.attachKeyboard === void 0) await this.#attachKeyboardInstall(chatId, state);
	}
	/**
	* The /attach keyboard's fixed content: every running session (no count
	* cap), then the five most recently completed ones, mixed globally across
	* scopes. Blank, subagent-internal, and archived sessions stay out of the
	* keyboard (an archived session surfaces only through the /attach arc
	* scope), so the keyboard mirrors the non-archived scope lists.
	* @returns the keyboard's session summaries in display order.
	*/
	async #attachKeyboardItems() {
		const [items, archivedIds] = await Promise.all([this.#port.listSessions(), this.#port.listArchivedSessionIds()]);
		const archived = new Set(archivedIds);
		const visible = items.filter((item) => !item.blank && item.origin !== "subagent" && !archived.has(item.sessionId));
		const running = visible.filter((item) => item.running);
		const completed = visible.filter((item) => !item.running).sort((a, b) => b.updatedAt - a.updatedAt);
		return [...running, ...completed.slice(0, 5)];
	}
	/**
	* Install the /attach keyboard: the shared action rows plus one bind button
	* per highlight (running sessions, then the five most recently completed,
	* archived excluded), so the keyboard area always shows just those
	* sessions. The inline scope lists stay the chat-text surface (unchanged),
	* and the keyboard's own rows back the numeric `/attach <n>` selector while
	* it is installed — typed and tapped alike, because the install also
	* records the list as the session-list `state.rows` (the last session list
	* output), so every numeric selector resolves against the same fresh list.
	* @param chatId - the target chat.
	* @param state - the chat's console state (records the keyboard's rows).
	* @returns after the keyboard message dispatches.
	*/
	async #attachKeyboardInstall(chatId, state) {
		const items = await this.#attachKeyboardItems();
		if (items.length === 0) return;
		state.attachKeyboard = items;
		state.rows = items;
		await this.#transport.sendReplyKeyboard(chatId, "🔗 快捷绑定：运行中的全部会话，加最近完成的 5 个。点按钮直接绑定（或 /attach <序号>）。", attachKeyboardRows(items));
	}
	async #attachUngrouped(chatId, state) {
		const { ungrouped } = await this.#partitionSessions();
		await this.#attachList(chatId, state, "未分组会话：", ungrouped, { list: "ungrouped" });
	}
	async #attachArchived(chatId, state) {
		const { archived } = await this.#partitionSessions();
		await this.#attachList(chatId, state, "归档会话：", archived, { list: "archived" });
	}
	async #attachWorkspaceSessions(chatId, state, workspaceId) {
		const { workspaces, byWorkspace } = await this.#partitionSessions();
		const workspace = workspaces.find((item) => item.workspaceId === workspaceId);
		if (workspace === void 0) {
			await this.#reply(chatId, "⛔ 该工作区已失效，请重新 /attach。");
			return;
		}
		await this.#attachList(chatId, state, `工作区「${workspace.title}」的会话：`, byWorkspace.get(workspaceId) ?? [], {
			list: "workspace",
			workspaceId
		});
	}
	/**
	* Dismiss the chat's reply keyboard behind a second confirmation: the first
	* `/close` arms, the second executes. The session binding stays — prompts
	* keep flowing to the bound session, and only the tappable command surface
	* goes away; any other command or free text cancels the arm.
	* @param chatId - the target chat.
	* @param state - the chat's console state (clears the visible-keyboard tracking).
	* @returns after the confirmation or dismissal message dispatches.
	*/
	async #commandClose(chatId, state) {
		if (state.awaitingConfirm?.command === "close") {
			state.awaitingConfirm = void 0;
			state.keyboard = void 0;
			state.attachKeyboard = void 0;
			await this.#transport.removeKeyboard(chatId, "已收起快捷键盘，会话绑定不变。");
			return;
		}
		state.awaitingConfirm = { command: "close" };
		await this.#reply(chatId, "⚠️ 确认收起快捷键盘？再次发送 /close 确认（会话绑定不变；其它命令或文字可取消）。");
	}
	/**
	* Reset a stale reply keyboard to the shared action rows when a command
	* whose own surface is not a reply keyboard runs, so picker rows (a
	* previous `/model`, `/preset`, `/new`, `/create`, or `/operate` list)
	* never linger in the input row. Live session lists — the `/delete`
	* reply list and the inline `/attach` lists — and the inline scope
	* picker stay untouched: the list-refresh path re-emits them, and no
	* keyboard pops where none is showing.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @returns after the keyboard message dispatches, if one does.
	*/
	/**
	* Re-show the reply-keyboard area on demand (`/keyboard`): a chat with the
	* attach keyboard installed gets it re-installed with a fresh running-first
	* list (same refresh a bare `/attach` flow performs); any other chat gets
	* the shared action rows — so the keyboard area can always be brought back
	* after `/close` dismissed it or a picker replaced it.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @returns after the keyboard message dispatches.
	*/
	async #commandKeyboard(chatId, state) {
		state.keyboard = { kind: "home" };
		if (state.attachKeyboard !== void 0) {
			await this.#attachKeyboardInstall(chatId, state);
			return;
		}
		await this.#transport.sendReplyKeyboard(chatId, "已打开键盘区。", KEYBOARD_ACTION_ROWS.map((row) => [...row]));
	}
	async #resetActionRows(chatId, state) {
		const keyboard = state.keyboard;
		if (keyboard === void 0) return;
		if (keyboard.kind === "home" || keyboard.kind === "sessions" || keyboard.kind === "scopes") return;
		state.keyboard = { kind: "home" };
		await this.#transport.sendReplyKeyboard(chatId, "📌 快捷键盘已回到常用操作。", KEYBOARD_ACTION_ROWS.map((row) => [...row]));
	}
	async #commandStop(chatId, state, args) {
		await this.#resetActionRows(chatId, state);
		const [rawTarget] = splitArgs(args);
		if (rawTarget !== "") {
			await this.#reply(chatId, "⛔ /stop 不需要参数：它停止当前绑定的会话。");
			return;
		}
		const bound = state.sessionId;
		if (bound === void 0) {
			await this.#sessionListInline(chatId, state, "没有打开会话。点下方按钮停止对应会话：", "stop");
			return;
		}
		try {
			await this.#port.stopSession(bound);
			await this.#reply(chatId, "⏹ 已请求停止。");
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async #commandStatus(chatId, state, args) {
		await this.#resetActionRows(chatId, state);
		const [rawTarget] = splitArgs(args);
		if (rawTarget === "") {
			const bound = state.sessionId;
			if (bound === void 0) {
				await this.#sessionListInline(chatId, state, "没有打开会话。点下方按钮查看会话详情：", "status");
				return;
			}
			const details = await this.#statusDetails(chatId, bound);
			if (details !== void 0) await this.#reply(chatId, details);
			return;
		}
		const resolved = this.#resolveTarget(state, rawTarget);
		if ("miss" in resolved) {
			await this.#reply(chatId, resolved.miss);
			return;
		}
		const details = await this.#statusDetails(chatId, resolved.id);
		if (details !== void 0) await this.#reply(chatId, details);
	}
	/**
	* Render one session's status lines, or a user-facing miss when it
	* vanished. The reply leads with the console version
	* ({@link TELEGRAM_VERSION}); the main line is the session's latest activity
	* from the history
	* tail (last assistant text, or the pending tool call when one is open, or
	* a hint for a blank page); the running state and metadata rows follow as
	* auxiliary lines, and the tail is a usage block — the history page's
	* user/assistant/tool counts and its display-character estimate
	* ({@link statusStats}, bounded by {@link HISTORY_DEFAULT_LIMIT} messages),
	* whose scope the printed message count makes explicit.
	*/
	async #statusDetails(chatId, id) {
		const summaryItem = (await this.#port.listSessions()).find((item) => item.sessionId === id);
		if (summaryItem === void 0) {
			await this.#reply(chatId, `会话 ${shortSessionId(id)} 不存在。`);
			return;
		}
		const events = await this.#port.readHistory(id, 20);
		const now = this.#now();
		const title = summaryItem.projections?.values.title;
		const stats = statusStats(events);
		return [
			`版本: ${TELEGRAM_VERSION}`,
			`📊 ${shortSessionId(summaryItem.sessionId)}`,
			summaryItem.running ? "🟢 运行中" : "⚪ 空闲",
			"",
			statusMainText(events),
			"",
			`目录: ${summaryItem.cwd ?? "（未记录）"}`,
			`更新: ${timeAgo(summaryItem.updatedAt, now)}`,
			`预设: ${summaryItem.agentPreset ?? "默认"}`,
			...title === void 0 || title === null ? [] : [`标题: ${truncate(title, 80)}`],
			`消息: 用户 ${stats.users} · 助手 ${stats.assistants} · 工具调用 ${stats.tools}`,
			`上下文 ~${stats.chars} 字符（近 ${stats.users + stats.assistants} 条消息）`
		].join("\n");
	}
	/**
	* Set the global default model every future Agent starts from — no bound
	* session required. A bare invocation replaces the reply keyboard with the
	* configured model list (one `/model <provider>/<model-id>` button per
	* model); a named argument resolves by exact provider/model route first,
	* then by id or display-name prefix. A successful set confirms on a message
	* that dismisses the keyboard.
	* @param chatId - the target chat.
	* @param state - the chat's console state (clears the visible-keyboard tracking on confirm).
	* @param args - the argument text.
	* @returns after the picker or the set reply dispatches.
	*/
	async #commandModel(chatId, state, args) {
		const name = args.trim();
		if (name === "") {
			await this.#modelListKeyboard(chatId, state);
			return;
		}
		const catalog = await this.#port.listGlobalModels();
		const match = this.#findModel(catalog, name);
		if (match === void 0) {
			await this.#reply(chatId, `没有找到模型 ${name}。发送 /model 查看可配置模型列表。`);
			return;
		}
		try {
			await this.#port.setGlobalDefaultModel(match.provider, match.model);
			state.keyboard = void 0;
			await this.#transport.removeKeyboard(chatId, `✅ 已设置全局默认模型 ${match.providerName}/${match.modelName}`);
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Replace the reply keyboard with one button per configured model; tapping
	* one sends `/model <provider>/<model-id>` verbatim, so the tap applies
	* through the same named path and the keyboard dismisses on confirm.
	* @param chatId - the target chat.
	* @param state - the chat's console state (records the model picker as visible).
	* @returns after the keyboard message dispatches.
	*/
	async #modelListKeyboard(chatId, state) {
		const catalog = await this.#port.listGlobalModels();
		const buttons = catalog.groups.flatMap((group) => group.models.map((model) => `/model ${group.id}/${model.id}`));
		if (buttons.length === 0) {
			state.keyboard = void 0;
			state.attachKeyboard = void 0;
			await this.#reply(chatId, "暂无可用模型。");
			return;
		}
		state.keyboard = { kind: "model" };
		state.attachKeyboard = void 0;
		let text = "🎛 设置全局默认模型：\n\n点按钮选择，或发送 /model <模型名> 直接指定。";
		if (buttons.length > 20) text += `\n\n还有 ${buttons.length - 20} 个模型未显示。`;
		if (catalog.failures.length > 0) text += `\n\n⚠️ 部分模型加载失败：\n${catalog.failures.map((failure) => `${failure.name}（${failure.message}）`).join("\n")}`;
		await this.#transport.sendReplyKeyboard(chatId, text, buttons.slice(0, 20).map((button) => [button]));
	}
	/**
	* The creation sub-menu: a reply keyboard with the two ways to start a
	* session — `/new` (fresh, workspace/ungrouped/path) and `/fork` (from the
	* bound session's last completed turn). Tapping either sends its command
	* verbatim, so the existing `/new` and `/fork` handlers run unchanged.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @returns after the menu dispatches.
	*/
	async #commandCreate(chatId, state) {
		state.keyboard = { kind: "create" };
		state.attachKeyboard = void 0;
		await this.#transport.sendReplyKeyboard(chatId, "创建会话：选择一种方式。\n\n· /new — 新建会话（选工作区 / 未分类 / 路径）\n· /fork — 分叉当前会话（从最后一个已完成回合）", [["/new", "/fork"]]);
	}
	/**
	* The operation sub-menu: a reply keyboard with the current-session actions
	* — `/archive` (archive into the archived scope), `/stop` (cancel the active
	* turn), and `/curTasks` (print the todo list). Tapping any sends its
	* command verbatim, so the existing handlers run unchanged.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @returns after the menu dispatches.
	*/
	async #commandOperate(chatId, state) {
		state.keyboard = { kind: "operate" };
		state.attachKeyboard = void 0;
		await this.#transport.sendReplyKeyboard(chatId, "操作会话：选择一项。\n\n· /archive — 归档当前会话\n· /stop — 停止进行中的回合\n· /curTasks — 查看任务列表", [
			["/archive"],
			["/stop"],
			["/curTasks"]
		]);
	}
	/**
	* Create a session inside a workspace, ungrouped, or from a server
	* directory path. Without arguments the workspace keyboard opens: one
	* `/new <n> · <title>` button per workspace plus the ungrouped-create row.
	* `none` creates an ungrouped session (deployment default directory), a
	* bare index targets the last workspace-keyboard row, and anything else
	* names a directory path the host registers as a workspace (idempotently)
	* before creating the session inside it.
	* @param chatId - the target chat.
	* @param state - the chat's console state (cleared caches on success).
	* @param args - the argument text.
	* @returns after the create reply dispatches.
	*/
	async #commandNew(chatId, state, args) {
		const [rawTarget] = splitArgs(args);
		if (rawTarget === "") {
			await this.#workspaceListKeyboard(chatId, state, "在哪个工作区创建会话？点按钮即可，或 /new <服务器目录路径> 新建工作区。");
			return;
		}
		try {
			const preset = state.nextPreset;
			let sessionId;
			let location;
			let presetNote = "";
			if (rawTarget === "none") {
				sessionId = await this.#port.createSession(preset === void 0 ? void 0 : { agentPreset: preset });
				location = "未分类";
			} else if (/^\d+$/.test(rawTarget)) {
				const workspace = this.#resolveWorkspace(state, rawTarget);
				if (workspace === void 0) {
					await this.#reply(chatId, `工作区序号 ${rawTarget} 超出范围：发送 /new 重新看看工作区列表`);
					return;
				}
				sessionId = await this.#port.createSession(preset === void 0 ? { workspaceId: workspace.workspaceId } : {
					workspaceId: workspace.workspaceId,
					agentPreset: preset
				});
				location = `工作区「${workspace.title}」`;
			} else {
				const workspace = await this.#port.createWorkspace(rawTarget);
				sessionId = await this.#port.createSession(preset === void 0 ? { workspaceId: workspace.workspaceId } : {
					workspaceId: workspace.workspaceId,
					agentPreset: preset
				});
				location = `工作区「${workspace.title}」`;
			}
			if (preset !== void 0) {
				state.nextPreset = void 0;
				presetNote = ` · 模式 ${preset}`;
			}
			state.sessionId = sessionId;
			state.rows = void 0;
			state.workspaces = void 0;
			state.attachScopes = false;
			state.keyboard = void 0;
			state.attachKeyboard = void 0;
			state.typing = false;
			this.#clearAsks(state);
			await this.#reply(chatId, `🔗 已创建新会话 ${sessionId}（${shortSessionId(sessionId)}）· ${location}${presetNote}`);
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Archive the bound session (or a selector target) into the archived scope
	* — the same durable hide as /delete, aimed at the open session — behind a
	* second confirmation: the first `/archive <target>` arms the target, the
	* second executes it; a different selector re-arms instead of silently
	* switching, and any other command or free text cancels. Archiving the
	* bound session unbinds the chat. A successful archive re-emits the
	* visible session list keyboard, so the archived row disappears without a
	* manual refresh.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param args - the argument text (empty archives the bound session).
	* @returns after the confirmation, archive reply, or list refresh dispatch.
	*/
	async #commandArchive(chatId, state, args) {
		await this.#resetActionRows(chatId, state);
		const [rawTarget] = splitArgs(args);
		const resolved = this.#resolveArgOrBound(state, rawTarget, "archive");
		if ("miss" in resolved) {
			await this.#reply(chatId, resolved.miss);
			return;
		}
		const pending = state.awaitingConfirm;
		if (pending?.command === "archive") {
			if (pending.sessionId !== resolved.id) {
				state.awaitingConfirm = {
					command: "archive",
					sessionId: resolved.id
				};
				await this.#reply(chatId, `⚠️ 已改选会话 ${shortSessionId(resolved.id)}，再次发送 /archive 确认归档。`);
				return;
			}
			state.awaitingConfirm = void 0;
		} else {
			state.awaitingConfirm = {
				command: "archive",
				sessionId: resolved.id
			};
			await this.#reply(chatId, `⚠️ 确认归档会话 ${shortSessionId(resolved.id)}？再次发送 /archive 确认（其它命令或文字可取消）。`);
			return;
		}
		try {
			await this.#port.archiveSession(resolved.id);
			if (state.sessionId === resolved.id) {
				state.sessionId = void 0;
				state.typing = false;
				state.stream = void 0;
				this.#clearAsks(state);
			}
			await this.#reply(chatId, `📦 已归档会话 ${shortSessionId(resolved.id)}（加入归档区，从列表与工作区隐藏）`);
			await this.#refreshSessionList(chatId, state);
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Archive (delete) one session: bare invocation opens the session keyboard
	* with `delete` buttons, a selector archives the target directly. Deleting
	* the bound session unbinds the chat. The session stays durable
	* (regained only by host-side restore), hidden from every grouping surface.
	* A successful archive re-emits the visible session list keyboard, so the
	* deleted row disappears without a manual refresh.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param args - the argument text.
	* @returns after the archive reply and any list refresh dispatch.
	*/
	async #commandDelete(chatId, state, args) {
		const [rawTarget] = splitArgs(args);
		if (rawTarget === "") {
			await this.#sessionListKeyboard(chatId, state, "点下方按钮删除对应会话（删除后从列表隐藏）：");
			return;
		}
		await this.#resetActionRows(chatId, state);
		const resolved = this.#resolveTarget(state, rawTarget);
		if ("miss" in resolved) {
			await this.#reply(chatId, resolved.miss);
			return;
		}
		try {
			await this.#port.archiveSession(resolved.id);
			if (state.sessionId === resolved.id) {
				state.sessionId = void 0;
				state.typing = false;
				state.stream = void 0;
				this.#clearAsks(state);
			}
			await this.#reply(chatId, `🗑 已删除会话 ${shortSessionId(resolved.id)}（从列表与工作区隐藏）`);
			await this.#refreshSessionList(chatId, state);
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Rename a session. A bare invocation with a bound session enters the
	* pending-rename state — the next non-command text becomes the title —
	* and reports the absence of a binding otherwise. With args, the first
	* token doubles as the target selector only when it parses as one;
	* the title keeps all remaining text. A successful rename re-emits the
	* visible session list keyboard, so the new title shows on the buttons
	* without a manual refresh.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param args - the argument text.
	* @returns after the rename, prompt, or miss reply dispatches.
	*/
	async #commandRename(chatId, state, args) {
		await this.#resetActionRows(chatId, state);
		const raw = args.trim();
		if (raw === "") {
			if (state.sessionId === void 0) {
				await this.#reply(chatId, "当前无激活会话。请先绑定会话（如 /attach），再发 /rename 重命名。");
				return;
			}
			state.awaitingRename = true;
			state.awaitingAskAnswer = void 0;
			await this.#reply(chatId, "/rename：请再次输入标题，当前会话将重命名为（即重命名当前绑定会话）。");
			return;
		}
		const space = raw.search(/\s+/);
		const firstToken = space === -1 ? "" : raw.slice(0, space);
		const rest = space === -1 ? "" : raw.slice(space + 1);
		const rawTarget = rest !== "" && this.#looksLikeSelector(firstToken) ? firstToken : "";
		const title = rawTarget === "" ? raw : rest;
		const resolved = this.#resolveArgOrBound(state, rawTarget, "rename");
		if ("miss" in resolved) {
			await this.#reply(chatId, resolved.miss);
			return;
		}
		try {
			const accepted = await this.#port.renameSession(resolved.id, title);
			await this.#reply(chatId, `✅ 已重命名为 ${accepted}`);
			await this.#refreshSessionList(chatId, state);
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Fork one session from its last completed turn and bind this chat to the
	* child — the same shape as /new binding a fresh session, so the fork is
	* immediately the open conversation. A bare invocation forks the bound
	* session; a selector forks that target.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param args - the argument text.
	* @returns after the fork reply dispatches.
	*/
	async #commandFork(chatId, state, args) {
		await this.#resetActionRows(chatId, state);
		const [rawTarget] = splitArgs(args);
		const resolved = this.#resolveArgOrBound(state, rawTarget, "fork");
		if ("miss" in resolved) {
			await this.#reply(chatId, resolved.miss);
			return;
		}
		try {
			const childId = await this.#port.forkSession(resolved.id);
			state.sessionId = childId;
			state.rows = void 0;
			state.workspaces = void 0;
			state.attachScopes = false;
			state.keyboard = void 0;
			state.typing = false;
			state.stream = void 0;
			this.#clearAsks(state);
			await this.#reply(chatId, `🔀 已分叉会话 ${shortSessionId(resolved.id)}：新会话 ${childId}（${shortSessionId(childId)}），已绑定到新会话。`);
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Print the bound session's todo list (the agent's own task list via
	* `todo/write`, the same source the web sidebar's task summary reads).
	* Unbound or empty degrade to a hint; no binding is created here.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @returns after the list (or its degrade hint) dispatches.
	*/
	async #commandCurTasks(chatId, state) {
		await this.#resetActionRows(chatId, state);
		const sessionId = state.sessionId;
		if (sessionId === void 0) {
			await this.#reply(chatId, "还没有绑定会话。发 /attach（或 /new 创建）绑定一个会话后，用 /curTasks 查看它的任务列表。");
			return;
		}
		try {
			const todos = await this.#port.listTodos(sessionId);
			if (todos === null || todos.length === 0) {
				await this.#reply(chatId, "当前会话暂无任务列表。");
				return;
			}
			await this.#reply(chatId, renderTodoList(todos));
		} catch (error) {
			await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Choose the agent mode (preset) for a session. Bare invocation opens the
	* preset picker keyboard; a selector (index or id) applies the preset to
	* the bound session when it is still blank — the host refuses otherwise,
	* and the refusal replies and stages the choice for the next `/new`.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param args - the argument text.
	* @returns after the picker, apply reply, or staging reply dispatches.
	*/
	async #commandPreset(chatId, state, args) {
		const [rawTarget] = splitArgs(args);
		if (rawTarget === "") {
			await this.#presetListKeyboard(chatId, state);
			return;
		}
		const presets = await this.#port.listPresets();
		const chosen = /^\d+$/.test(rawTarget) ? presets.at(Number(rawTarget) - 1) : presets.find((preset) => preset.id === rawTarget);
		if (chosen === void 0) {
			await this.#reply(chatId, `没有找到模式 ${rawTarget}。发送 /preset 查看可选模式。`);
			return;
		}
		const label = chosen.name ?? chosen.id;
		await this.#applyPreset(chatId, state, chosen.id, label);
	}
	/**
	* Apply one preset to the bound session, or stage it for the next /new
	* when no session is bound or the bound one already started (the host
	* refuses a started session's recomposition).
	* @param chatId - the target chat.
	* @param state - the chat's console state (stages into nextPreset on refusal).
	* @param presetId - the preset to apply.
	* @param label - the preset display label (name or id).
	* @returns after the apply or staging reply dispatches.
	*/
	async #applyPreset(chatId, state, presetId, label) {
		const sessionId = state.sessionId;
		if (sessionId === void 0) {
			state.nextPreset = presetId;
			await this.#reply(chatId, `暂存模式「${label}」：下一次 /new 创建会话时生效。`);
			return;
		}
		try {
			await this.#port.selectPreset(sessionId, presetId);
			await this.#reply(chatId, `✅ 已切换会话模式为「${label}」。`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("（agent-preset-locked）")) {
				state.nextPreset = presetId;
				await this.#reply(chatId, `当前会话已开始，模式已固定。已暂存「${label}」：下一次 /new 创建会话时生效。`);
				return;
			}
			await this.#reply(chatId, `⛔ ${message}`);
		}
	}
	/**
	* Replace the reply keyboard with one button per deployment preset (PTC,
	* standard, minimal, cordis…); tapping one sends `/preset <n> · <name>`
	* verbatim, so the tap applies through the same named path.
	* @param chatId - the target chat.
	* @param state - the chat's console state (records the picker as visible).
	* @returns after the keyboard message dispatches.
	*/
	async #presetListKeyboard(chatId, state) {
		const presets = await this.#port.listPresets();
		if (presets.length === 0) {
			state.keyboard = void 0;
			state.attachKeyboard = void 0;
			await this.#reply(chatId, "此部署未配置预设模式。");
			return;
		}
		state.keyboard = { kind: "presets" };
		state.attachKeyboard = void 0;
		let text = "🎛 选择会话模式：\n\n点按钮选择，或发送 /preset <模式名> 直接指定。绑定会话未开始时立即生效；已开始或未绑定时暂存给下一次 /new。";
		if (state.nextPreset !== void 0) {
			const staged = presets.find((preset) => preset.id === state.nextPreset);
			text += `\n\n已暂存：${staged?.name ?? staged?.id ?? state.nextPreset}（下一次 /new 生效）`;
		}
		await this.#transport.sendReplyKeyboard(chatId, text, presetKeyboardRows(presets));
	}
	/**
	* Re-emit the session list keyboard this chat currently shows, after a
	* delete or rename changed the listed sessions: the same hint and the same
	* listed scope re-render from the registry, so visible rows never go
	* stale, and a list emptied by the change degrades to its send path's
	* empty hint. A no-op when the visible keyboard is not a session list (or
	* none is tracked).
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @returns after the re-emitted keyboard (or its degrade hint) dispatches.
	*/
	async #refreshSessionList(chatId, state) {
		const keyboard = state.keyboard;
		if (keyboard?.kind !== "sessions") return;
		switch (keyboard.recipe.list) {
			case "full":
				await this.#sessionListKeyboard(chatId, state, keyboard.hint);
				return;
			case "ungrouped":
				await this.#attachUngrouped(chatId, state);
				return;
			case "archived":
				await this.#attachArchived(chatId, state);
				return;
			case "workspace": {
				const { byWorkspace } = await this.#partitionSessions();
				await this.#attachList(chatId, state, keyboard.hint, byWorkspace.get(keyboard.recipe.workspaceId) ?? [], keyboard.recipe);
				return;
			}
		}
	}
	/**
	* First catalog entry that names `name`, scanning providers in order. An
	* exact `provider/model` route wins over prefix matching, so a keyboard
	* tap resolves to the model its button advertised even when another model
	* id shares its prefix.
	* @param catalog - the host-wide model catalog.
	* @param name - the user-typed route or prefix.
	* @returns the matched route with display names, or undefined.
	*/
	#findModel(catalog, name) {
		const needle = name.toLowerCase();
		const slash = needle.indexOf("/");
		if (slash !== -1) {
			const providerId = needle.slice(0, slash);
			const modelId = needle.slice(slash + 1);
			const group = catalog.groups.find((candidate) => candidate.id.toLowerCase() === providerId);
			const model = group?.models.find((candidate) => candidate.id.toLowerCase() === modelId);
			if (group !== void 0 && model !== void 0) return {
				provider: group.id,
				providerName: group.name,
				model: model.id,
				modelName: model.name
			};
		}
		for (const group of catalog.groups) for (const model of group.models) if (model.id.toLowerCase().startsWith(needle) || model.name.toLowerCase().startsWith(needle)) return {
			provider: group.id,
			providerName: group.name,
			model: model.id,
			modelName: model.name
		};
	}
	/**
	* Whether a token parses as a session selector: a bare integer (a 1-based
	* index into the last session list output) or a UUID-shaped session id.
	* @param token - the candidate selector token.
	* @returns whether the token should be read as a selector.
	*/
	#looksLikeSelector(token) {
		if (/^\d+$/.test(token)) return true;
		return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(token);
	}
	/**
	* Resolve a selector for a command that may fall back to the bound session:
	* a bare integer is a 1-based index into the last session list output,
	* anything else is taken as a session id; an empty argument uses the open
	* binding when one exists.
	* @param state - the chat's console state.
	* @param raw - the argument text.
	* @param verb - the command name for the empty-argument hint.
	* @returns the resolved session id, or a user-facing miss message.
	*/
	#resolveArgOrBound(state, raw, verb) {
		if (raw.trim() === "") {
			if (state.sessionId !== void 0) return {
				ok: true,
				id: state.sessionId
			};
			return { miss: `没有打开的会话。带参数使用 /${verb} <序号|id> 指定会话。` };
		}
		return this.#resolveTarget(state, raw);
	}
	/**
	* Resolve a selector: a bare integer is a 1-based index into the last
	* session list output, anything else is taken as a session id.
	* @param state - the chat's console state.
	* @param raw - the argument text.
	* @returns the resolved session id, or a user-facing miss message.
	*/
	#resolveTarget(state, raw) {
		if (/^\d+$/.test(raw)) {
			const index = Number(raw);
			const row = state.rows?.at(index - 1);
			if (row !== void 0) return {
				ok: true,
				id: row.sessionId
			};
			return { miss: `序号 ${index} 超出范围：先 /attach 刷新列表` };
		}
		/* v8 ignore start --
		* Every caller splits args and short-circuits an empty target before
		* resolving, so this guard is defense-only dead code.
		*/
		if (raw.trim() === "") return { miss: "缺少会话参数（<序号|id>）。" };
		return {
			ok: true,
			id: SessionId(raw)
		};
		/* v8 ignore stop */
	}
	async #reply(chatId, text) {
		for (const chunk of chunkText(text)) await this.#transport.sendMessage(chatId, chunk);
	}
	/**
	* Publish one assistant text block on the chat's live stream: edit the
	* stream message when the fused text stays within the chunk budget, send a
	* fresh chunked message otherwise (and after a failed edit, which falls back
	* so no text is lost). The stream follows the last message sent, so further
	* steps keep editing the newest message.
	* @param chatId - the target chat.
	* @param state - the chat's console state.
	* @param block - the trimmed assistant text block.
	* @returns after the edit or send dispatches.
	*/
	async #publishAssistant(chatId, state, block) {
		const stream = state.stream;
		const first = stream === void 0 || stream.text === "";
		const header = first && state.turnStartTime !== void 0 ? `${startClockLabel(state.turnStartTime, this.#now())}\n` : "";
		const body = first ? `${header}🤖 ${block}` : stream.text + block;
		const shown = body + STREAM_REPLYING_SUFFIX;
		if (stream !== void 0 && Array.from(shown).length <= 3500) try {
			await this.#transport.editMessage(chatId, stream.messageId, shown);
			stream.text = body;
			return;
		} catch (error) {
			console.warn(`telegram: stream edit failed, sending a fresh message instead: ${String(error)}`);
		}
		let messageId = 0;
		let text = "";
		for (const chunk of chunkText(shown)) {
			messageId = await this.#transport.sendMessage(chatId, chunk);
			text = chunk;
		}
		text = stripStreamSuffix(text);
		state.stream = {
			messageId,
			text
		};
	}
};
/**
* Turn outcome text for the stream finalization: the {@link turnEndLabel}
* glyph plus, for an `error` end carrying a structured failure, the failure
* message on its own line. The reason is capped at
* {@link TURN_ERROR_REASON_MAX} code points; an empty or absent reason leaves
* the bare label. TurnEndReason variants are merge-extensible: an `error`-kind
* variant without the `error` field renders the plain label.
* @param reason - the turn outcome.
* @returns the label text for the outcome.
*/
function turnOutcomeLabel(reason) {
	const label = turnEndLabel(reason);
	if (reason.kind !== "error" || !("error" in reason)) return label;
	const message = reason.error.message.trim();
	return message === "" ? label : `${label}\n${truncate(message, TURN_ERROR_REASON_MAX)}`;
}
/** Failure-reason cap on the error turn label. */
const TURN_ERROR_REASON_MAX = 1e3;
/** Split command args on the first whitespace run into at most two parts. */
function splitArgs(args) {
	const trimmed = args.trim();
	const space = trimmed.search(/\s+/);
	if (space === -1) return [trimmed, ""];
	return [trimmed.slice(0, space), trimmed.slice(space + 1)];
}
const HELP_TEXT = [
	"🤖 dsh 会话遥控台",
	"",
	`/attach [序号|id|none|arc] — 绑定会话并显示最近 2 轮对话：无参数选工作区/未分组/归档；none=未分组；arc=归档；序号=当前范围里的会话`,
	"/create — 创建会话菜单：下一级为 /new（新建）与 /fork（分叉）",
	"/operate — 操作会话菜单：下一级为 /archive（归档）、/stop（停止）、/curTasks（任务列表）",
	"/new [路径|序号|none] — 创建会话：无参数弹出工作区选；none=未分类；序号=工作区；路径=服务器目录自动注册",
	"/fork [序号|id] — 分叉会话：从最后一个已完成回合开新会话并绑定（无参数作用于当前绑定）",
	"/archive [序号|id] — 归档会话加入归档区（无参数作用于当前会话；需再次发送 /archive 确认）",
	"/delete [序号|id] — 删除（归档）会话，无参数弹出选择",
	"/stop — 停止进行中的回合（作用于当前绑定会话；未绑定会话时点下方按钮选择）",
	"/status [序号|id] — 会话详情（无参数作用于当前会话；未绑定会话时点下方按钮选择）",
	"/model [模型名] — 设置全局默认模型（无参数弹出模型键盘选择）",
	"/rename [标题] — 重命名会话：无参数交互输入标题（作用于当前绑定会话）；<序号|id> <标题> 指定会话",
	"/curTasks — 查看当前会话的任务列表（与 Web 侧栏任务同源）",
	"/preset [模式名|序号] — 选择会话模式（PTC/标准/极简/创造预设）：无参数弹出预设键盘；已开始会话会暂存到下一次 /new",
	"/close — 收起快捷键盘（需再次发送 /close 确认；会话绑定不变）",
	"",
	"会话/工作区列表下方会出现快捷键盘：点按钮 = 自动发送对应命令，无需复制 id。",
	"/ 命令菜单从 /keyboard 开始（一键唤醒键盘区），接着 /attach（绑定入口），其余只保留键盘上没有的命令：/status、/model、/delete、/rename、/preset、/start。",
	"运行 /attach、/status、/stop 等不带键盘的命令后，快捷键盘会回到常用操作行（/create /archive /attach /close）。",
	"绑定会话后，agent 的回复会实时推送到这里。",
	"以 / 开头的消息是命令；要用 / 开头的内容发给 harness，",
	"请在前面加 \\ 转义（如 \\/model）。"
].join("\n");
//#endregion
//#region lib/types/index.js
/**
* Telegram remote-control surface for harness sessions. A grammY long-polling
* bot answers whitelisted chats with the console commands and forwards free
* text as user prompts through the host ApiProxy — the exact path the web UI
* uses, including cold-session resume.
* Realtime pushes stream each turn back to the chat on one live message
* (edited in place for assistant steps; non-completed outcomes append their
* label). Reply keyboards carry the one-tap actions (`/create`, `/operate`,
* `/attach`, `/close` and their sub-menus `/new`, `/fork`, `/archive`,
* `/stop`, `/curTasks`); a command whose surface is not a reply keyboard
* resets a stale keyboard to those shared action rows. The input-box
* `/` menu leads with `/keyboard` (wake the keyboard area) then `/attach`
* (the binding entry), and then exposes only the typing-only commands
* (`/status`, `/model`, `/delete`, `/rename`, `/preset`, `/start`).
* Workspace lists and the `/delete` session list carry reply keyboards whose
* buttons are finished commands, so a tap binds or deletes without typing or
* copying ids; `/stop` and `/status` pick their targets from inline
* session-action lists (tap to stop, tap to view) like the `/attach` picker.
* `/model` replaces the keyboard with the configured model list, and a tap
* there saves the global default model through the shared settings section
* the web composer's switch also writes.
*
* The plugin registers no network listener: all traffic is outbound Telegram
* API long polling, tunneled through {@link Config.proxy} (defaulting to the
* process `ALL_PROXY`/`HTTPS_PROXY`).
* @module @deepseek-ai/dsh-host-telegram
*/
/** Interval between typing-indicator pumps for chats with a running turn. */
const TYPING_PUMP_INTERVAL_MS = 5e3;
/** Rejection reply for chats outside the allowlist (no session facts leak). */
const DENIED_REPLY = "⛔ 无权访问。";
/**
* The command table registered with Telegram at bot startup
* (`bot.api.setMyCommands`), so the input box's `/` menu leads with
* `/keyboard` (wake the reply-keyboard area — the one-tap recovery after
* `/close` dismissed it), then `/attach` (the binding entry), and then
* carries only the typing-only commands (`/status`, `/model`, `/delete`,
* `/rename`, `/preset`, `/start`). Every
* keyboard-covered command (`/create`, `/operate`, `/new`, `/fork`,
* `/archive`, `/stop`, `/curTasks`, `/close`) is one tap on the reply
* keyboards (the `/create` `/archive` `/attach` action row plus the
* `/stop` `/close` row, with `/create` opening the `/new`/`/fork` sub-menu
* and `/operate` staying typed) and stays out of the `/` menu; all of them
* still work when typed. Descriptions mirror the in-chat help
* text; command names follow the Telegram character rule (lowercase
* letters, digits, underscores).
*/
const COMMANDS = [
	{
		command: "keyboard",
		description: "唤醒/刷新下方键盘区（恢复常用命令按钮与运行中会话的快捷绑定）"
	},
	{
		command: "attach",
		description: "选择会话并绑定（<序号|id|none|arc>；会话列表时键盘区可直接点选）"
	},
	{
		command: "status",
		description: "查看会话详情"
	},
	{
		command: "model",
		description: "设置全局默认模型（无参数弹出模型列表）"
	},
	{
		command: "delete",
		description: "删除（归档）会话 <序号|id>，无参数弹出选择"
	},
	{
		command: "rename",
		description: "重命名会话 <标题>"
	},
	{
		command: "preset",
		description: "选择会话模式（PTC/标准/极简/创造等预设）<模式名|序号>"
	},
	{
		command: "start",
		description: "显示帮助与全部命令"
	}
];
/** The settings namespace this surface edits (model-visible from the settings pages). */
const TELEGRAM_SETTINGS_NAMESPACE = settingsNamespace("telegram");
/**
* The settings section the harness reads the global default model selection
* from. Same branded value as `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE` in
* `@deepseek-ai/dsh-agent-default-model` — the section `AgentDefaultModelConfig`
* registers — so a write here is what new sessions and sessions whose own log
* names no selection start from.
*/
const GLOBAL_DEFAULT_MODEL_NAMESPACE = settingsNamespace("agent-default-model");
/** Schemastery configuration for the Telegram console consumer. */
const Config = z.object({
	botToken: z.string().required(),
	allowChatIds: z.array(z.number()).required(),
	proxy: z.string()
});
/** Cordis function-plugin name. */
const name = "telegram";
/** Services required before the console can drive sessions. */
const inject = ["apiProxy"];
/** The proxy this deployment uses, or undefined for a direct connection. */
function resolveProxy(config) {
	return config.proxy ?? process.env.ALL_PROXY ?? process.env.HTTPS_PROXY ?? void 0;
}
/**
* Adapt the host ApiProxy to the console port. RPC refusals become
* UI-ready errors. Exported for unit tests and for deployments that want to
* drive the console from another ApiProxy face.
* @param api - the host ApiProxy.
* @returns the console port.
*/
function createPort(api) {
	const rpcId = () => RpcId(randomUUID());
	const failure = (message, code) => /* @__PURE__ */ new Error(`${message}（${code}）`);
	return {
		async listSessions() {
			const response = await api.sessions.list({
				rpcId: rpcId(),
				payload: {}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return response.result.value.items;
		},
		async readHistory(sessionId, maxMessages) {
			const payload = {
				sessionId,
				...maxMessages === void 0 ? {} : { maxMessages }
			};
			const response = await api.sessions.history({
				rpcId: rpcId(),
				payload
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return response.result.value.events.map((entry) => entry.event);
		},
		async sendPrompt(sessionId, mode, text) {
			const response = await api.sessions.prompt({
				rpcId: rpcId(),
				payload: {
					sessionId,
					mode,
					content: [{
						type: "text",
						text
					}]
				}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
		},
		async stopSession(sessionId) {
			const response = await api.sessions.cancel({
				rpcId: rpcId(),
				payload: { sessionId }
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
		},
		async listGlobalModels() {
			const response = await api.llm.models({
				rpcId: rpcId(),
				payload: {}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return response.result.value;
		},
		async setGlobalDefaultModel(provider, model) {
			const response = await api.settings.update({
				rpcId: rpcId(),
				payload: {
					ns: GLOBAL_DEFAULT_MODEL_NAMESPACE,
					patch: {
						provider,
						model
					}
				}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
		},
		async createSession(options) {
			const payload = {
				...options?.workspaceId === void 0 ? {} : { workspaceId: options.workspaceId },
				...options?.cwd === void 0 ? {} : { cwd: options.cwd },
				...options?.agentPreset === void 0 ? {} : { agentPreset: options.agentPreset }
			};
			const response = await api.sessions.create({
				rpcId: rpcId(),
				payload
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return response.result.value.sessionId;
		},
		async listWorkspaces() {
			const response = await api.workspace.list({
				rpcId: rpcId(),
				payload: {}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return response.result.value.items;
		},
		async listArchivedSessionIds() {
			const response = await api.workspace.list({
				rpcId: rpcId(),
				payload: {}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return response.result.value.archivedSessionIds;
		},
		async createWorkspace(path) {
			const response = await api.workspace.create({
				rpcId: rpcId(),
				payload: { path }
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return response.result.value.workspace;
		},
		async archiveSession(sessionId) {
			const response = await api.workspace.archiveSession({
				rpcId: rpcId(),
				payload: { sessionId }
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
		},
		async renameSession(sessionId, title) {
			const response = await api.sessions.rename({
				rpcId: rpcId(),
				payload: {
					sessionId,
					title
				}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return response.result.value.title;
		},
		async forkSession(sessionId) {
			const response = await api.sessions.fork({
				rpcId: rpcId(),
				payload: { sessionId }
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return response.result.value.sessionId;
		},
		async listTodos(sessionId) {
			const response = await api.sessions.history({
				rpcId: rpcId(),
				payload: {
					sessionId,
					maxMessages: 20
				}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			const values = response.result.value.projections?.values;
			if (values?.todos !== void 0) return values.todos;
			return lastTodoWrite(response.result.value.events.map((entry) => entry.event));
		},
		async listPresets() {
			const response = await api.agentPresets.list({
				rpcId: rpcId(),
				payload: {}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
			return [...response.result.value.presets];
		},
		async selectPreset(sessionId, agentPreset) {
			const response = await api.agentPresets.select({
				rpcId: rpcId(),
				payload: {
					sessionId,
					agentPreset
				}
			});
			if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
		},
		async answerQuestion(rpcId, sessionId, answer) {
			const response = await api.respond({
				type: "client-response",
				rpcId,
				result: {
					ok: true,
					value: {
						sessionId,
						answer
					}
				}
			});
			if (!response.accepted) throw new Error(`提问回答被拒绝（${response.reason}）`);
		},
		async cancelQuestion(rpcId) {
			const response = await api.respond({
				type: "client-response",
				rpcId,
				result: {
					ok: false,
					error: {
						code: "cancelled",
						message: "the user closed this question request",
						details: {}
					}
				}
			});
			if (!response.accepted) throw new Error(`提问取消失败（${response.reason}）`);
		}
	};
}
/** Map console answer buttons to the Telegram inline-keyboard wire rows. */
function inlineKeyboardMarkup(rows) {
	return rows.map((row) => row.map((button) => ({
		text: button.text,
		callback_data: button.data
	})));
}
/**
* Build the grammY client for one bot session: route every Telegram API call
* through the CONNECT proxy tunnel when one is configured.
* @param config - the session configuration (provides the bot token).
* @param proxyAgent - the prebuilt undici proxy agent, or undefined for a direct connection.
* @returns the configured grammY bot.
*/
function createBot(config, proxyAgent) {
	return new Bot(config.botToken, proxyAgent === void 0 ? {} : { client: { fetch: ((url, init) => {
		const { signal: _signal, ...rest } = init ?? {};
		return fetch(url, {
			...rest,
			dispatcher: proxyAgent
		});
	}) } });
}
/**
* Fixed scopes whose stale command tables would shadow the default table in
* their surface: BotFather's prompt-time presets (e.g. a fresh bot ships
* `/start` `/help` `/status` under `all_private_chats`) win over
* `botCommandScopeDefault` even when both exist. Cleared before registering
* {@link COMMANDS} so the `/` menu is identical everywhere.
*/
const PRESET_COMMAND_SCOPES = [
	{ type: "all_private_chats" },
	{ type: "all_group_chats" },
	{ type: "all_chat_administrators" }
];
/**
* Best-effort command menu sync: tear down stale fixed scopes, then register
* {@link COMMANDS} on the default scope. Any failure only warns — a menu
* hiccup never blocks the long-poll loop.
* @param bot - the grammY client.
* @param logger - the plugin logger.
*/
function syncCommandMenu(bot, logger) {
	(async () => {
		for (const scope of PRESET_COMMAND_SCOPES) await bot.api.deleteMyCommands({ scope }).catch((error) => {
			logger.warn(`telegram: stale menu scope teardown failed for ${scope.type}: ${String(error)}`);
		});
		await bot.api.setMyCommands(COMMANDS).catch((error) => {
			logger.warn(`telegram: command menu registration failed: ${String(error)}`);
		});
	})();
}
/**
* Build one bot session for the given configuration. The session owns the
* grammY client (with its proxy tunnel), the console, and the realtime event
* feed; settings changes rebuild the session by stopping the old one. At
* startup the command menu ({@link COMMANDS}) registers through
* {@link syncCommandMenu}.
* @param options - the session inputs.
* @returns the session handle.
*/
function startBotSession(options) {
	const { config, api, events, logger, onListened } = options;
	const allowed = new Set(config.allowChatIds);
	const proxy = resolveProxy(config);
	const proxyAgent = proxy === void 0 ? void 0 : new ProxyAgent(proxy);
	const bot = (options.createBot ?? createBot)(config, proxyAgent);
	bot.catch((error) => {
		logger.warn(`telegram: bot error: ${error.message}`);
	});
	const telegramConsole = new TelegramConsole(createPort(api), {
		sendMessage: async (chatId, text) => {
			return (await bot.api.sendMessage(chatId, text)).message_id;
		},
		editMessage: async (chatId, messageId, text) => {
			await bot.api.editMessageText(chatId, messageId, text);
		},
		sendMessageHtml: async (chatId, html) => {
			return (await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" })).message_id;
		},
		editMessageHtml: async (chatId, messageId, html) => {
			await bot.api.editMessageText(chatId, messageId, html, { parse_mode: "HTML" });
		},
		sendChatAction: async (chatId, action) => {
			await bot.api.sendChatAction(chatId, action);
		},
		sendReplyKeyboard: async (chatId, text, rows) => {
			return (await bot.api.sendMessage(chatId, text, { reply_markup: {
				keyboard: rows.map((row) => row.map((text) => ({ text }))),
				resize_keyboard: true,
				is_persistent: true,
				input_field_placeholder: "向 agent 发消息，或 /start 查看命令"
			} })).message_id;
		},
		removeKeyboard: async (chatId, text) => {
			return (await bot.api.sendMessage(chatId, text, { reply_markup: { remove_keyboard: true } })).message_id;
		},
		sendInlineKeyboard: async (chatId, text, rows) => {
			return (await bot.api.sendMessage(chatId, text, { reply_markup: { inline_keyboard: inlineKeyboardMarkup(rows) } })).message_id;
		},
		editInlineKeyboard: async (chatId, messageId, text, rows) => {
			await bot.api.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: inlineKeyboardMarkup(rows) } });
		}
	});
	bot.on("message:text", (messageContext) => {
		const chatId = messageContext.chat.id;
		if (!allowed.has(chatId)) {
			logger.warn(`telegram: chat ${chatId} refused: not in allowChatIds`);
			bot.api.sendMessage(chatId, `${DENIED_REPLY} 如需访问，请将 chat id ${chatId} 加入 allowChatIds 白名单。`).catch((error) => {
				logger.debug(`telegram: denial reply failed: ${String(error)}`);
			});
			return;
		}
		telegramConsole.handleMessage(chatId, messageContext.message.text).catch((error) => {
			logger.warn(`telegram: message handling failed: ${String(error)}`);
		});
	});
	bot.on("callback_query", (callbackContext) => {
		const { message, data } = callbackContext.callbackQuery;
		bot.api.answerCallbackQuery(callbackContext.callbackQuery.id).catch((error) => {
			logger.debug(`telegram: callback ack failed: ${String(error)}`);
		});
		const chatId = message?.chat.id;
		if (chatId === void 0 || data === void 0) return;
		if (!allowed.has(chatId)) {
			logger.warn(`telegram: chat ${chatId} refused: not in allowChatIds`);
			return;
		}
		telegramConsole.handleCallback(chatId, data).catch((error) => {
			logger.warn(`telegram: callback handling failed: ${String(error)}`);
		});
	});
	const stopEvents = events.on("session/event", (session, event) => {
		telegramConsole.onSessionEvent(session.id, event).catch((error) => {
			logger.warn(`telegram: event push failed: ${String(error)}`);
		});
	});
	const typingTimer = setInterval(() => {
		telegramConsole.pumpTyping().catch((error) => {
			logger.warn(`telegram: typing pump failed: ${String(error)}`);
		});
	}, TYPING_PUMP_INTERVAL_MS);
	let stopped = false;
	bot.start({ onStart: (botInfo) => {
		syncCommandMenu(bot, logger);
		onListened(config, botInfo.username);
	} }).catch((error) => {
		logger.error(`telegram: long polling start failed: ${String(error)}`);
	});
	return { async stop() {
		if (stopped) return;
		stopped = true;
		stopEvents();
		clearInterval(typingTimer);
		await bot.stop();
	} };
}
/**
* Install the Telegram surface: bot lifecycle, access gate, the console
* wiring, and the settings namespace that pages edit. Configuration comes
* from the `telegram` settings namespace when one exists (the composition
* entry stays the base layer); any committed change rebuilds the bot session
* so tokens, allowlists, and proxies take effect without a restart.
* @param ctx - the plugin context (carries `apiProxy` after inject).
* @param config - validated plugin configuration (the settings base layer).
*/
function apply(ctx, config) {
	console.log(`telegram: configuring bot for ${config.allowChatIds.length} allowed chat ids`);
	ctx.inject(["apiProxy"], (apiCtx) => {
		const logger = ctx.logger;
		let session;
		let sessionGeneration = 0;
		const startSession = (cfg) => {
			const generation = ++sessionGeneration;
			(async () => {
				await session?.stop();
				if (generation !== sessionGeneration) return;
				session = startBotSession({
					config: cfg,
					api: apiCtx.apiProxy,
					events: apiCtx,
					logger,
					onListened: (current, username) => {
						console.log(`telegram: bot @${username} listening`);
						logger.info(`telegram: bot @${username} listening with ${current.allowChatIds.length} allowed chat ids`);
					}
				});
			})().catch((error) => {
				logger.error(`telegram: bot session start failed: ${String(error)}`);
			});
		};
		const reconciler = () => {
			const next = configSource();
			if (JSON.stringify(next) === JSON.stringify(config)) return;
			config = next;
			console.log(`telegram: reconfiguring bot for ${next.allowChatIds.length} allowed chat ids`);
			startSession(next);
		};
		let configSource = () => config;
		installSettingsSection(ctx, TELEGRAM_SETTINGS_NAMESPACE, Config, config, {
			setSource: (current) => {
				configSource = current;
			},
			onChange: reconciler
		});
		ctx.effect(() => async () => {
			sessionGeneration += 1;
			await session?.stop();
		}, "telegram.lifecycle()");
		startSession(config);
	});
}
//#endregion
export { COMMANDS, Config, DENIED_REPLY, GLOBAL_DEFAULT_MODEL_NAMESPACE, TELEGRAM_SETTINGS_NAMESPACE, TYPING_PUMP_INTERVAL_MS, apply, createPort, inject, name, startBotSession };
