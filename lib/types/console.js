/**
 * Chat-bound remote console over a {@link SessionConsolePort}: command
 * routing, session binding, prompt forwarding, and realtime push of the bound
 * session's events. Pure orchestration — I/O goes through the injected port
 * and transport, so unit tests drive the full flow without a live bot or
 * harness.
 * @module @deepseek-ai/dsh-host-telegram/console
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import { ASSISTANT_ROLE_GLYPH, HISTORY_DEFAULT_LIMIT, KEYBOARD_ACTION_ROWS, QUEUE_ACK_MAX, SESSION_KEYBOARD_MAX, SESSION_STATE_LEGEND, STREAM_REPLYING_SUFFIX, TELEGRAM_CHUNK_MAX, TELEGRAM_VERSION, WORKSPACE_KEYBOARD_MAX, accumulateRoundUsage, assistantTail, attachScopeButtons, attachSessionButtons, blockText, chunkText, emptyRoundUsage, stripStreamSuffix, actionsHtml, messageActions, stepActionsHtml, turnOpen, parseAttachCallback, parseQuestionCallback, parseSessionListCallback, pendingAskBatches, presetKeyboardRows, questionKeyboard, questionMessageText, renderTodoList, attachKeyboardRows, lastTurnUsage, latestTurnStartTime, openTurnUsage, roundUsageFooter, sessionActionButtons, sessionKeyboardRows, startClockLabel, sessionRow, shortSessionId, statusMainText, statusStats, timeAgo, truncate, turnEndLabel, workspaceKeyboardRows, workspaceRow, } from "./render.js";
import { markdownToTelegramHtml } from "./markdown.js";
/**
 * Interpret one incoming text: a leading backslash escapes the following
 * text verbatim (so `/`-leading text reaches the harness), a leading `/`
 * names a console command (with any `@bot` suffix stripped), and anything
 * else is a prompt for the open session.
 * @param text - the raw incoming text.
 * @returns the command or prompt interpretation.
 */
export function interpretInput(text) {
    if (text.startsWith('\\'))
        return { kind: 'prompt', text: text.slice(1) };
    if (!text.startsWith('/'))
        return { kind: 'prompt', text };
    // The leading '/' check keeps the first whitespace token non-empty and
    // slash-headed; strip the `@bot` suffix, then the slash. The two fallbacks
    // only satisfy noUncheckedIndexedAccess on arrays that cannot be empty.
    /* v8 ignore start -- the command branch guarantees a leading-token split. */
    const [rawName, ...rest] = text.split(/\s+/);
    const withoutSuffix = (rawName ?? '').split('@')[0] ?? '';
    /* v8 ignore stop */
    return { name: withoutSuffix.toLowerCase().slice(1), args: rest.join(' ') };
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
export class TelegramConsole {
    #port;
    #transport;
    #now;
    #chats = new Map();
    /**
     * One chat's in-flight event-push chain. Events bound to the same chat are
     * serialized so a later event never reads stream state mid-edit of an
     * earlier one (e.g. `turn/end` must see the assistant text its edit
     * finalized, not the empty stream of the still-in-flight edit).
     */
    #chains = new Map();
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
        if ('kind' in input) {
            // Free-text flows consume this message: a pending rename first, then an
            // armed custom-answer; only text with neither forwards as a prompt. A
            // pending destructive confirmation is never confirmed by free text — it
            // cancels with the message.
            state.awaitingConfirm = undefined;
            if (state.awaitingRename) {
                await this.#handlePendingRename(chatId, state, input.text);
                return;
            }
            if (state.awaitingAskAnswer !== undefined) {
                await this.#handleAskCustomText(chatId, state, state.awaitingAskAnswer, input.text);
                return;
            }
            await this.#handlePrompt(chatId, state, input.text);
            return;
        }
        // Any / command cancels a pending rename and a custom-answer arm; the
        // command itself runs normally. The destructive-confirmation arm is
        // handled inside #handleCommand: re-sending the same command confirms,
        // any other command cancels it.
        state.awaitingRename = false;
        state.awaitingAskAnswer = undefined;
        const command = input;
        try {
            await this.#handleCommand(chatId, state, command);
        }
        catch (error) {
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
        // Each chat's pushes run on its own chain: the next event's handler only
        // starts after the previous one settled, so `turn/end` never reads stream
        // state mid-edit of the assistant message it depends on. The awaited
        // results rethrow the first failure so the caller keeps today's failure
        // surface.
        const pushes = [];
        for (const [chatId, state] of this.#chats) {
            if (state.sessionId !== sessionId)
                continue;
            const previous = this.#chains.get(chatId) ?? Promise.resolve();
            const push = previous.then(() => this.#pushEvent(chatId, state, sessionId, event));
            this.#chains.set(chatId, push.then(() => undefined, () => undefined));
            pushes.push(push);
        }
        const results = await Promise.allSettled(pushes);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure !== undefined)
            throw failure.reason;
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
            case 'turn/start': {
                const messageId = await this.#transport.sendMessage(chatId, '🤔 thinking…');
                state.stream = { messageId, text: '' };
                state.turnUsage = emptyRoundUsage();
                state.turnActions = [];
                state.turnStartTime = event.time;
                state.typing = true;
                break;
            }
            case 'assistant/message': {
                accumulateRoundUsage(state.turnUsage, event.data.usage);
                const text = blockText(event.data.message.content);
                if (text !== '')
                    await this.#publishAssistant(chatId, state, text);
                state.turnActions.push(...messageActions(event.data.message, event.time));
                break;
            }
            case 'turn/end': {
                const stream = state.stream;
                const reason = event.data.reason;
                // A completed reply finalizes its own stream message: the final edit
                // drops the in-flight replying marker (its text is the bare body).
                // Only an empty stream (the unfulfilled `🤔 thinking…` spinner) and
                // non-completed outcomes get the outcome label, so replies keep their
                // text alone.
                const label = reason.kind === 'completed' && stream !== undefined && stream.text !== ''
                    ? undefined
                    : turnOutcomeLabel(reason);
                const footer = roundUsageFooter(state.turnUsage);
                const toolHtml = actionsHtml(state.turnActions, this.#now());
                // Clear the live-stream state before any outbound await: a failed ask
                // keyboard edit must never leave the typing pump or the stream stuck
                // on a turn that already ended.
                state.stream = undefined;
                state.typing = false;
                state.turnActions = [];
                state.turnStartTime = undefined;
                // An ask answered mid-turn waits for the turn to close: only then
                // is the agent's reply complete, so the in-progress label becomes
                // the final 已回答 mark.
                for (const [rpcId, pending] of [...state.pendingAsks]) {
                    if (!pending.answered)
                        continue;
                    await this.#transport.editInlineKeyboard(chatId, pending.messageId, '✅ 已回答。', []);
                    state.pendingAsks.delete(rpcId);
                }
                if (footer === '' && toolHtml === '') {
                    try {
                        if (stream !== undefined) {
                            // The reply body (or body + label) without the replying marker.
                            await this.#transport.editMessage(chatId, stream.messageId, label === undefined ? stream.text : stream.text === '' ? label : `${stream.text}\n${label}`);
                        }
                        else {
                            await this.#reply(chatId, label ?? '');
                        }
                    }
                    catch (error) {
                        if (stream === undefined)
                            throw error;
                        console.warn(`telegram: turn label edit failed, sending a fresh message instead: ${String(error)}`);
                        if (label !== undefined)
                            await this.#reply(chatId, label);
                    }
                    break;
                }
                // The footer and the collapsible tool-call blockquote render in HTML
                // mode, so the final message is emitted whole: the assistant's markdown
                // body is projected to Telegram HTML, then the tool blockquote and the
                // `<pre>` footer are appended. The body keeps the plain path's
                // stream/label layout.
                // The body carries the same stream/label layout as the plain path; on
                // the empty-body arm `label` is always defined (the undefined label
                // requires a non-empty stream, the opposite of this arm), so the
                // `?? ''` backstop below is unreachable and coverage-exempt.
                let body;
                if (stream === undefined || stream.text === '') {
                    // v8 ignore next -- unreachable: an empty body implies a defined label
                    body = label ?? '';
                }
                else if (label === undefined) {
                    body = stream.text;
                }
                else {
                    body = `${stream.text}\n${label}`;
                }
                const html = markdownToTelegramHtml(body) + (toolHtml === '' ? '' : '\n\n' + toolHtml) + footer;
                try {
                    if (stream !== undefined) {
                        await this.#transport.editMessageHtml(chatId, stream.messageId, html);
                    }
                    else {
                        await this.#transport.sendMessageHtml(chatId, html);
                    }
                }
                catch (error) {
                    if (stream === undefined)
                        throw error;
                    console.warn(`telegram: turn footer edit failed, sending a fresh message instead: ${String(error)}`);
                    await this.#transport.sendMessageHtml(chatId, html);
                }
                break;
            }
            default:
                break;
            case 'question/asked': {
                await this.#renderAsk(chatId, state, sessionId, event.data.id, event.data.questions);
                break;
            }
            case 'question/decided': {
                await this.#settleAsk(chatId, state, event.data.id, event.data.outcome);
                break;
            }
        }
    }
    /**
     * Drive the Telegram typing indicator for chats whose bound session runs a
     * turn. Called on a fixed interval by the entry.
     * @returns after every pending chat action dispatched.
     */
    async pumpTyping() {
        for (const [chatId, state] of this.#chats) {
            if (state.typing) {
                await this.#transport.sendChatAction(chatId, 'typing');
            }
        }
    }
    #state(chatId) {
        let state = this.#chats.get(chatId);
        if (state === undefined) {
            state = {
                sessionId: undefined,
                rows: undefined,
                workspaces: undefined,
                attachScopes: false,
                keyboard: undefined,
                attachKeyboard: undefined,
                typing: false,
                stream: undefined,
                turnUsage: emptyRoundUsage(),
                turnActions: [],
                turnStartTime: undefined,
                awaitingRename: false,
                pendingAsks: new Map(),
                awaitingAskAnswer: undefined,
                nextPreset: undefined,
                awaitingConfirm: undefined,
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
        if (attach !== undefined) {
            try {
                switch (attach.kind) {
                    case 'session':
                        await this.#performAttach(chatId, state, attach.sessionId);
                        break;
                    case 'workspace':
                        await this.#attachWorkspaceSessions(chatId, state, attach.workspaceId);
                        break;
                    case 'ungrouped':
                        await this.#attachUngrouped(chatId, state);
                        break;
                    case 'archived':
                        await this.#attachArchived(chatId, state);
                        break;
                }
            }
            catch (error) {
                await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
        }
        const list = parseSessionListCallback(data);
        if (list !== undefined) {
            try {
                if (list.kind === 'stop') {
                    await this.#port.stopSession(list.sessionId);
                    await this.#reply(chatId, '⏹ 已请求停止。');
                }
                else {
                    const details = await this.#statusDetails(chatId, list.sessionId);
                    if (details !== undefined)
                        await this.#reply(chatId, details);
                }
            }
            catch (error) {
                await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
        }
        const parsed = parseQuestionCallback(data);
        if (parsed === undefined) {
            await this.#reply(chatId, '⛔ 未知按钮。');
            return;
        }
        const pending = state.pendingAsks.get(parsed.rpcId);
        if (pending === undefined || pending.answered) {
            await this.#reply(chatId, '⛔ 该提问已失效（可能已在别处回答）。');
            return;
        }
        try {
            switch (parsed.kind) {
                case 'option': {
                    await this.#tapOption(chatId, pending, parsed.questionIndex, parsed.optionIndex);
                    break;
                }
                case 'custom': {
                    await this.#armCustom(chatId, state, pending, parsed.questionIndex);
                    break;
                }
                case 'submit': {
                    await this.#submitAsk(chatId, pending);
                    break;
                }
                case 'cancel': {
                    await this.#cancelAsk(chatId, state, pending);
                    break;
                }
            }
        }
        catch (error) {
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
        const messageId = await this.#transport.sendInlineKeyboard(chatId, questionMessageText(questions), questionKeyboard(questions, questions.map(() => []), questions.map(() => undefined), rpcId));
        state.pendingAsks.set(rpcId, {
            rpcId,
            sessionId,
            messageId,
            questions,
            selected: questions.map(() => []),
            custom: questions.map(() => undefined),
            answered: false,
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
        if (pending === undefined)
            return;
        if (state.awaitingAskAnswer?.rpcId === rpcId)
            state.awaitingAskAnswer = undefined;
        if (outcome === 'cancelled') {
            await this.#transport.editInlineKeyboard(chatId, pending.messageId, '🚫 已取消。', []);
            state.pendingAsks.delete(rpcId);
            return;
        }
        await this.#transport.editInlineKeyboard(chatId, pending.messageId, '⏳ 回答中…', []);
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
        if (question === undefined || option === undefined) {
            // The pending ask lives but this button is outside its current options —
            // the keyboard was re-rendered meanwhile (or the data is foreign).
            await this.#reply(chatId, '⛔ 该提问已失效（选项已更新，请重选）。');
            return;
        }
        const isMulti = question.multiSelect === true;
        const selected = pending.selected[questionIndex];
        /* v8 ignore next -- #renderAsk seeds every question with an empty selection array */
        if (selected === undefined)
            return;
        if (isMulti) {
            const at = selected.indexOf(option.label);
            if (at === -1)
                selected.push(option.label);
            else
                selected.splice(at, 1);
        }
        else {
            pending.selected[questionIndex] = [option.label];
            // Custom and picked options stay mutually exclusive for single-select.
            pending.custom[questionIndex] = undefined;
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
        if (question === undefined)
            return;
        if (question.multiSelect !== true)
            pending.selected[questionIndex] = [];
        state.awaitingRename = false;
        state.awaitingAskAnswer = { rpcId: pending.rpcId, questionIndex };
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
            if (custom !== undefined && custom !== '') {
                // The `?? []` guards only noUncheckedIndexedAccess: #renderAsk seeds every
                // question with an empty selection array and no path removes one.
                /* v8 ignore next -- multiSelect selections are always present arrays */
                return { id: question.id, selected: question.multiSelect === true ? (selected ?? []) : [], custom };
            }
            if (selected !== undefined && selected.length > 0) {
                return { id: question.id, selected };
            }
            return undefined;
        });
        const incomplete = pending.questions.findIndex((_, index) => answers[index] === undefined);
        if (incomplete !== -1) {
            const question = pending.questions[incomplete];
            /* v8 ignore next -- findIndex only returns indexes inside the batch */
            if (question === undefined)
                return;
            await this.#reply(chatId, `⛔ 还有问题「${truncate(question.question, 40)}」未回答：选择选项或点「✍️ 自定义回答」。`);
            return;
        }
        await this.#port.answerQuestion(pending.rpcId, pending.sessionId, {
            answers: answers,
        });
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
        if (state.awaitingAskAnswer?.rpcId === pending.rpcId)
            state.awaitingAskAnswer = undefined;
        await this.#reply(chatId, '🚫 已取消该提问。');
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
        state.awaitingAskAnswer = undefined;
        const pending = state.pendingAsks.get(awaiting.rpcId);
        /* v8 ignore next -- settleAsk and cancelAsk clear the arm together with the pending entry */
        if (pending === undefined) {
            await this.#reply(chatId, '⛔ 该提问已失效（可能已在别处回答）。');
            return;
        }
        const question = pending.questions[awaiting.questionIndex];
        /* v8 ignore next -- the arm index is bounded by #armCustom's own guard */
        if (question === undefined)
            return;
        const custom = text.trim();
        if (custom === '') {
            await this.#reply(chatId, '↩️ 已取消自定义回答。');
            return;
        }
        if (question.multiSelect !== true)
            pending.selected[awaiting.questionIndex] = [];
        pending.custom[awaiting.questionIndex] = custom;
        await this.#refreshAskKeyboard(chatId, pending);
        await this.#reply(chatId, `✅ 已记录对「${truncate(question.question, 40)}」的回答，点「✅ 提交回答」完成。`);
    }
    /** Drop every rendered ask and the custom-answer arm (the binding changed). */
    #clearAsks(state) {
        state.pendingAsks.clear();
        state.awaitingAskAnswer = undefined;
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
        if (title === '') {
            await this.#reply(chatId, '↩️ 已取消重命名。');
            return;
        }
        /* v8 ignore start --
         * Defense-only: every flow that clears the binding reroutes through
         * handleMessage's command branch, which cancels the pending rename
         * first; only a future binding-clearing flow reaching this state
         * directly would trip it.
         */
        const sessionId = state.sessionId;
        if (sessionId === undefined) {
            await this.#reply(chatId, '⛔ 当前无激活会话，无法重命名。请先绑定会话（如 /attach）。');
            return;
        }
        /* v8 ignore stop */
        try {
            const accepted = await this.#port.renameSession(sessionId, title);
            await this.#reply(chatId, `✅ 已重命名为 ${accepted}`);
        }
        catch (error) {
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
        if (sessionId === undefined) {
            await this.#reply(chatId, '还没有绑定会话。发 /attach（无参数先选工作区/未分组/归档）选择并绑定一个会话。');
            return;
        }
        if (text.trim() === '')
            return;
        try {
            if (state.typing) {
                await this.#port.sendPrompt(sessionId, 'steer', text);
                return;
            }
            // An idle turn queues the prompt: acknowledge with the pending content,
            // so the sender sees what is waiting to run (the agent's reply streams
            // on the turn it opens). A steering interjection needs no ack — it is
            // already part of the running turn's stream.
            await this.#port.sendPrompt(sessionId, 'queue', text);
            await this.#reply(chatId, `📥 已加入队列：${truncate(text, QUEUE_ACK_MAX)}`);
        }
        catch (error) {
            await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async #handleCommand(chatId, state, command) {
        // A `/close` or `/archive` re-sent while its confirmation is armed stays
        // armed so the handler executes on the second send; any other command
        // cancels the arm and runs normally.
        if (state.awaitingConfirm !== undefined && state.awaitingConfirm.command !== command.name) {
            state.awaitingConfirm = undefined;
        }
        switch (command.name) {
            case 'start':
                await this.#resetActionRows(chatId, state);
                await this.#reply(chatId, HELP_TEXT);
                return;
            case 'attach':
                await this.#commandAttach(chatId, state, command.args);
                return;
            case 'keyboard':
                await this.#commandKeyboard(chatId, state);
                return;
            case 'close':
                return this.#commandClose(chatId, state);
            case 'stop':
                await this.#commandStop(chatId, state, command.args);
                return;
            case 'status':
                await this.#commandStatus(chatId, state, command.args);
                return;
            case 'model':
                await this.#commandModel(chatId, state, command.args);
                return;
            case 'create':
                return this.#commandCreate(chatId, state);
            case 'operate':
                return this.#commandOperate(chatId, state);
            case 'new':
                await this.#commandNew(chatId, state, command.args);
                return;
            case 'rename':
                await this.#commandRename(chatId, state, command.args);
                return;
            case 'fork':
                await this.#commandFork(chatId, state, command.args);
                return;
            case 'archive':
                await this.#commandArchive(chatId, state, command.args);
                return;
            case 'delete':
                await this.#commandDelete(chatId, state, command.args);
                return;
            case 'curtasks':
                await this.#commandCurTasks(chatId, state);
                return;
            case 'preset':
                await this.#commandPreset(chatId, state, command.args);
                return;
            default:
                await this.#reply(chatId, `未知命令 /${command.name}。发送 /start 查看可用命令。`);
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
        const items = await this.#port.listSessions();
        const visible = items.filter(item => !item.blank && item.origin !== 'subagent');
        state.rows = visible;
        state.attachScopes = false;
        state.attachKeyboard = undefined;
        if (visible.length === 0) {
            state.keyboard = undefined;
            await this.#reply(chatId, '当前没有可用会话。用 /new 创建一个。');
            return;
        }
        state.keyboard = { kind: 'sessions', hint, recipe: { list: 'full' } };
        const now = this.#now();
        const body = visible
            .slice(0, SESSION_KEYBOARD_MAX)
            .map((item, index) => sessionRow(index + 1, item, now)).join('\n');
        await this.#transport.sendReplyKeyboard(chatId, `${hint}\n\n${body}`, sessionKeyboardRows(visible, 'delete'));
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
        const items = await this.#port.listSessions();
        const visible = items.filter(item => !item.blank && item.origin !== 'subagent');
        state.rows = visible;
        state.attachScopes = false;
        if (visible.length === 0) {
            state.keyboard = undefined;
            await this.#reply(chatId, '当前没有可用会话。用 /new 创建一个。');
            return;
        }
        const now = this.#now();
        const body = visible
            .slice(0, SESSION_KEYBOARD_MAX)
            .map((item, index) => sessionRow(index + 1, item, now)).join('\n');
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
        state.attachKeyboard = undefined;
        if (items.length === 0) {
            state.keyboard = undefined;
            await this.#reply(chatId, '还没有工作区。发 /new <服务器目录路径> 新建工作区并创建会话，或 /new none 创建未分类会话。');
            return;
        }
        state.keyboard = { kind: 'workspaces' };
        const body = items
            .slice(0, WORKSPACE_KEYBOARD_MAX)
            .map((item, index) => workspaceRow(index + 1, item)).join('\n');
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
        if (!/^\d+$/.test(raw))
            return undefined;
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
            this.#port.listWorkspaces(),
        ]);
        const visible = items.filter(item => !item.blank && item.origin !== 'subagent');
        const archived = new Set(archivedIds);
        const archivedList = [];
        const ungrouped = [];
        const byWorkspace = new Map();
        for (const item of visible) {
            if (archived.has(item.sessionId)) {
                archivedList.push(item);
                continue;
            }
            const workspace = workspaces.find(entry => entry.sessionIds.includes(item.sessionId));
            if (workspace === undefined) {
                ungrouped.push(item);
                continue;
            }
            const bucket = byWorkspace.get(workspace.workspaceId);
            if (bucket === undefined)
                byWorkspace.set(workspace.workspaceId, [item]);
            else
                bucket.push(item);
        }
        return { workspaces, archived: archivedList, ungrouped, byWorkspace };
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
        if (rawTarget === '') {
            await this.#attachScopePicker(chatId, state);
            return;
        }
        if (rawTarget === 'none') {
            await this.#attachUngrouped(chatId, state);
            return;
        }
        if (rawTarget === 'arc' || rawTarget === 'archived') {
            await this.#attachArchived(chatId, state);
            return;
        }
        // The attach keyboard is the numbered surface while installed — a bare
        // number binds its rows (typed or tapped alike); the workspace selector
        // only serves the picker when no attach keyboard is up (e.g. an empty
        // registry); otherwise the last session list resolves.
        if (/^\d+$/.test(rawTarget) && state.attachKeyboard !== undefined) {
            const row = state.attachKeyboard.at(Number(rawTarget) - 1);
            if (row === undefined) {
                await this.#reply(chatId, `序号 ${rawTarget} 超出范围：先 /attach 刷新列表`);
                return;
            }
            await this.#performAttach(chatId, state, row.sessionId);
            return;
        }
        if (state.attachScopes && /^\d+$/.test(rawTarget)) {
            const workspace = state.workspaces?.at(Number(rawTarget) - 1);
            if (workspace === undefined) {
                await this.#reply(chatId, `工作区序号 ${rawTarget} 超出范围：先 /attach 刷新范围列表`);
                return;
            }
            await this.#attachWorkspaceSessions(chatId, state, workspace.workspaceId);
            return;
        }
        const resolved = this.#resolveTarget(state, rawTarget);
        if ('miss' in resolved) {
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
        const events = await this.#port.readHistory(sessionId, ATTACH_READ_LIMIT);
        const open = turnOpen(events);
        state.sessionId = sessionId;
        this.#clearAsks(state);
        // The live-stream state follows the attached session, not the previous
        // binding: a leftover stream from another session's open turn must never
        // receive this session's edits, and a closed session stops the typing
        // pump (a previous binding's open turn would otherwise keep it pumping
        // forever, because its later events no longer reach this chat). An open
        // turn drives the typing indicator and seeds the turn's usage and start
        // clock, so the first pushed reply and the turn-end footer stay accurate
        // for a chat that joined mid-turn.
        state.stream = undefined;
        state.turnActions = [];
        state.typing = open;
        state.turnStartTime = open ? latestTurnStartTime(events) : undefined;
        state.turnUsage = open ? openTurnUsage(events) : emptyRoundUsage();
        const replies = assistantTail(events, ATTACH_ROUNDS);
        const preview = replies.length === 0
            ? '（空白会话）'
            : replies.map(text => `${ASSISTANT_ROLE_GLYPH} ${text}`).join('\n');
        // The preview is chunked in the markdown plane, then each chunk is
        // converted to HTML separately: one Telegram message over 4096
        // characters is rejected with "message is too long", and splitting
        // already-converted HTML would cut a tag open.
        const header = `🔗 已绑定 ${sessionId}（${shortSessionId(sessionId)}）\n\n最近 ${ATTACH_ROUNDS} 轮对话：`;
        for (const chunk of chunkText(`${header}\n${preview}`)) {
            await this.#transport.sendMessageHtml(chatId, markdownToTelegramHtml(chunk));
        }
        // A still-running turn keeps a visible in-progress marker: its actions
        // (one line each) in one expandable blockquote, or a bare 进行中 hint
        // while the model composes its first reply with no action recorded yet —
        // including while it reasons with no tool call pending. A finished turn
        // stands on the reply text above, so its actions stay out of the attach
        // preview. Then re-render any unanswered ask so the user can answer it
        // directly from the attach preview, and close a finished session with
        // its last completed turn's token-usage footer (the same `⚡ 本轮` bar a
        // streamed turn ends with) at the very bottom.
        if (open) {
            const toolHtml = stepActionsHtml(events, this.#now(), ATTACH_ACTION_LIMIT);
            if (toolHtml !== '') {
                await this.#transport.sendMessageHtml(chatId, '🔧 进行中：\n' + toolHtml);
            }
            else {
                await this.#transport.sendMessageHtml(chatId, '⏳ 进行中…');
            }
        }
        for (const batch of pendingAskBatches(events)) {
            await this.#renderAsk(chatId, state, sessionId, batch.id, batch.questions);
        }
        if (!open) {
            const footer = roundUsageFooter(lastTurnUsage(events));
            if (footer !== '') {
                await this.#transport.sendMessageHtml(chatId, footer);
            }
        }
    }
    /** The scope picker: workspaces first, then ungrouped and archived when non-empty. */
    async #attachScopePicker(chatId, state) {
        const { workspaces, ungrouped, archived } = await this.#partitionSessions();
        state.workspaces = [...workspaces];
        state.rows = undefined;
        state.attachScopes = true;
        state.keyboard = { kind: 'scopes' };
        const body = workspaces.length === 0
            ? '还没有工作区。'
            : workspaces
                .slice(0, WORKSPACE_KEYBOARD_MAX)
                .map((item, index) => workspaceRow(index + 1, item)).join('\n');
        const scopes = [
            ...ungrouped.length > 0 ? ['/attach none（未分组）'] : [],
            ...archived.length > 0 ? ['/attach arc（归档）'] : [],
        ];
        const header = scopes.length === 0
            ? '选择会话范围：点下方的范围按钮，或直接 /attach <会话id>。'
            : `选择会话范围：点下方的范围按钮（或 ${scopes.join('、')}），或直接 /attach <会话id>。`;
        // The attach keyboard installs with the picker itself and refreshes on
        // every bare `/attach` flow: the keyboard area always mirrors the current
        // running-first + recent-five highlight, so a session that started running
        // (or a new session) since the last install lands at the top of the
        // numbered rows, which back `/attach <n>` while installed. An empty
        // registry keeps the keyboard area clean (the picker text covers the void).
        await this.#attachKeyboardInstall(chatId, state);
        await this.#transport.sendInlineKeyboard(chatId, `${header}\n\n${body}`, attachScopeButtons(workspaces, { ungrouped: ungrouped.length > 0, archived: archived.length > 0 }));
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
            state.keyboard = undefined;
            await this.#reply(chatId, `${hint}（暂无会话）`);
            return;
        }
        state.keyboard = { kind: 'sessions', hint, recipe };
        const now = this.#now();
        const body = items
            .slice(0, SESSION_KEYBOARD_MAX)
            .map((item, index) => sessionRow(index + 1, item, now)).join('\n');
        await this.#transport.sendInlineKeyboard(chatId, `${hint}\n\n${body}\n\n${SESSION_STATE_LEGEND}`, attachSessionButtons(items));
        // The keyboard-area attach list: installed with the first list of an
        // attach flow, then kept (it is global — scope hops need no re-send).
        if (state.attachKeyboard === undefined) {
            await this.#attachKeyboardInstall(chatId, state);
        }
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
        const [items, archivedIds] = await Promise.all([
            this.#port.listSessions(),
            this.#port.listArchivedSessionIds(),
        ]);
        const archived = new Set(archivedIds);
        const visible = items.filter(item => !item.blank && item.origin !== 'subagent' && !archived.has(item.sessionId));
        const running = visible.filter(item => item.running);
        const completed = visible.filter(item => !item.running).sort((a, b) => b.updatedAt - a.updatedAt);
        return [...running, ...completed.slice(0, ATTACH_KEYBOARD_RECENT)];
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
        if (items.length === 0)
            return;
        state.attachKeyboard = items;
        state.rows = items;
        await this.#transport.sendReplyKeyboard(chatId, '🔗 快捷绑定：运行中的全部会话，加最近完成的 5 个。点按钮直接绑定（或 /attach <序号>）。', attachKeyboardRows(items));
    }
    async #attachUngrouped(chatId, state) {
        const { ungrouped } = await this.#partitionSessions();
        await this.#attachList(chatId, state, '未分组会话：', ungrouped, { list: 'ungrouped' });
    }
    async #attachArchived(chatId, state) {
        const { archived } = await this.#partitionSessions();
        await this.#attachList(chatId, state, '归档会话：', archived, { list: 'archived' });
    }
    async #attachWorkspaceSessions(chatId, state, workspaceId) {
        const { workspaces, byWorkspace } = await this.#partitionSessions();
        const workspace = workspaces.find(item => item.workspaceId === workspaceId);
        if (workspace === undefined) {
            await this.#reply(chatId, '⛔ 该工作区已失效，请重新 /attach。');
            return;
        }
        await this.#attachList(chatId, state, `工作区「${workspace.title}」的会话：`, byWorkspace.get(workspaceId) ?? [], { list: 'workspace', workspaceId });
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
        if (state.awaitingConfirm?.command === 'close') {
            state.awaitingConfirm = undefined;
            state.keyboard = undefined;
            state.attachKeyboard = undefined;
            await this.#transport.removeKeyboard(chatId, '已收起快捷键盘，会话绑定不变。');
            return;
        }
        state.awaitingConfirm = { command: 'close' };
        await this.#reply(chatId, '⚠️ 确认收起快捷键盘？再次发送 /close 确认（会话绑定不变；其它命令或文字可取消）。');
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
        state.keyboard = { kind: 'home' };
        if (state.attachKeyboard !== undefined) {
            await this.#attachKeyboardInstall(chatId, state);
            return;
        }
        await this.#transport.sendReplyKeyboard(chatId, '已打开键盘区。', KEYBOARD_ACTION_ROWS.map(row => [...row]));
    }
    async #resetActionRows(chatId, state) {
        const keyboard = state.keyboard;
        if (keyboard === undefined)
            return;
        if (keyboard.kind === 'home' || keyboard.kind === 'sessions' || keyboard.kind === 'scopes')
            return;
        state.keyboard = { kind: 'home' };
        await this.#transport.sendReplyKeyboard(chatId, '📌 快捷键盘已回到常用操作。', KEYBOARD_ACTION_ROWS.map(row => [...row]));
    }
    async #commandStop(chatId, state, args) {
        await this.#resetActionRows(chatId, state);
        // /stop owns no selector: a bare invocation stops the bound session;
        // an unbound chat gets the inline stop list instead.
        const [rawTarget] = splitArgs(args);
        if (rawTarget !== '') {
            await this.#reply(chatId, '⛔ /stop 不需要参数：它停止当前绑定的会话。');
            return;
        }
        const bound = state.sessionId;
        if (bound === undefined) {
            await this.#sessionListInline(chatId, state, '没有打开会话。点下方按钮停止对应会话：', 'stop');
            return;
        }
        try {
            await this.#port.stopSession(bound);
            await this.#reply(chatId, '⏹ 已请求停止。');
        }
        catch (error) {
            await this.#reply(chatId, `⛔ ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async #commandStatus(chatId, state, args) {
        await this.#resetActionRows(chatId, state);
        const [rawTarget] = splitArgs(args);
        if (rawTarget === '') {
            const bound = state.sessionId;
            if (bound === undefined) {
                await this.#sessionListInline(chatId, state, '没有打开会话。点下方按钮查看会话详情：', 'status');
                return;
            }
            const details = await this.#statusDetails(chatId, bound);
            if (details !== undefined)
                await this.#reply(chatId, details);
            return;
        }
        const resolved = this.#resolveTarget(state, rawTarget);
        if ('miss' in resolved) {
            await this.#reply(chatId, resolved.miss);
            return;
        }
        const details = await this.#statusDetails(chatId, resolved.id);
        if (details !== undefined)
            await this.#reply(chatId, details);
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
        const items = await this.#port.listSessions();
        const summaryItem = items.find(item => item.sessionId === id);
        if (summaryItem === undefined) {
            await this.#reply(chatId, `会话 ${shortSessionId(id)} 不存在。`);
            return undefined;
        }
        const events = await this.#port.readHistory(id, HISTORY_DEFAULT_LIMIT);
        const now = this.#now();
        const title = summaryItem.projections?.values.title;
        const stats = statusStats(events);
        return [
            `版本: ${TELEGRAM_VERSION}`,
            `📊 ${shortSessionId(summaryItem.sessionId)}`,
            summaryItem.running ? '🟢 运行中' : '⚪ 空闲',
            '',
            statusMainText(events),
            '',
            `目录: ${summaryItem.cwd ?? '（未记录）'}`,
            `更新: ${timeAgo(summaryItem.updatedAt, now)}`,
            `预设: ${summaryItem.agentPreset ?? '默认'}`,
            ...title === undefined || title === null ? [] : [`标题: ${truncate(title, 80)}`],
            `消息: 用户 ${stats.users} · 助手 ${stats.assistants} · 工具调用 ${stats.tools}`,
            `上下文 ~${stats.chars} 字符（近 ${stats.users + stats.assistants} 条消息）`,
        ].join('\n');
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
        if (name === '') {
            await this.#modelListKeyboard(chatId, state);
            return;
        }
        const catalog = await this.#port.listGlobalModels();
        const match = this.#findModel(catalog, name);
        if (match === undefined) {
            await this.#reply(chatId, `没有找到模型 ${name}。发送 /model 查看可配置模型列表。`);
            return;
        }
        try {
            await this.#port.setGlobalDefaultModel(match.provider, match.model);
            state.keyboard = undefined;
            await this.#transport.removeKeyboard(chatId, `✅ 已设置全局默认模型 ${match.providerName}/${match.modelName}`);
        }
        catch (error) {
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
        const buttons = catalog.groups.flatMap(group => group.models.map(model => `/model ${group.id}/${model.id}`));
        if (buttons.length === 0) {
            state.keyboard = undefined;
            state.attachKeyboard = undefined;
            await this.#reply(chatId, '暂无可用模型。');
            return;
        }
        state.keyboard = { kind: 'model' };
        state.attachKeyboard = undefined;
        let text = '🎛 设置全局默认模型：\n\n点按钮选择，或发送 /model <模型名> 直接指定。';
        if (buttons.length > MODEL_KEYBOARD_LIMIT) {
            text += `\n\n还有 ${buttons.length - MODEL_KEYBOARD_LIMIT} 个模型未显示。`;
        }
        if (catalog.failures.length > 0) {
            text += `\n\n⚠️ 部分模型加载失败：\n${catalog.failures.map(failure => `${failure.name}（${failure.message}）`).join('\n')}`;
        }
        await this.#transport.sendReplyKeyboard(chatId, text, buttons.slice(0, MODEL_KEYBOARD_LIMIT).map(button => [button]));
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
        state.keyboard = { kind: 'create' };
        state.attachKeyboard = undefined;
        await this.#transport.sendReplyKeyboard(chatId, '创建会话：选择一种方式。\n\n· /new — 新建会话（选工作区 / 未分类 / 路径）\n· /fork — 分叉当前会话（从最后一个已完成回合）', [['/new', '/fork']]);
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
        state.keyboard = { kind: 'operate' };
        state.attachKeyboard = undefined;
        await this.#transport.sendReplyKeyboard(chatId, '操作会话：选择一项。\n\n· /archive — 归档当前会话\n· /stop — 停止进行中的回合\n· /curTasks — 查看任务列表', [['/archive'], ['/stop'], ['/curTasks']]);
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
        if (rawTarget === '') {
            await this.#workspaceListKeyboard(chatId, state, '在哪个工作区创建会话？点按钮即可，或 /new <服务器目录路径> 新建工作区。');
            return;
        }
        try {
            const preset = state.nextPreset;
            let sessionId;
            let location;
            let presetNote = '';
            if (rawTarget === 'none') {
                sessionId = await this.#port.createSession(preset === undefined ? undefined : { agentPreset: preset });
                location = '未分类';
            }
            else if (/^\d+$/.test(rawTarget)) {
                const workspace = this.#resolveWorkspace(state, rawTarget);
                if (workspace === undefined) {
                    await this.#reply(chatId, `工作区序号 ${rawTarget} 超出范围：发送 /new 重新看看工作区列表`);
                    return;
                }
                sessionId = await this.#port.createSession(preset === undefined ? { workspaceId: workspace.workspaceId } : { workspaceId: workspace.workspaceId, agentPreset: preset });
                location = `工作区「${workspace.title}」`;
            }
            else {
                const workspace = await this.#port.createWorkspace(rawTarget);
                sessionId = await this.#port.createSession(preset === undefined ? { workspaceId: workspace.workspaceId } : { workspaceId: workspace.workspaceId, agentPreset: preset });
                location = `工作区「${workspace.title}」`;
            }
            // Consume the staged preset only once the session actually exists: a
            // refused create (or an out-of-range pick) keeps it for the next try.
            if (preset !== undefined) {
                state.nextPreset = undefined;
                presetNote = ` · 模式 ${preset}`;
            }
            state.sessionId = sessionId;
            state.rows = undefined;
            state.workspaces = undefined;
            state.attachScopes = false;
            state.keyboard = undefined;
            state.attachKeyboard = undefined;
            state.typing = false;
            this.#clearAsks(state);
            await this.#reply(chatId, `🔗 已创建新会话 ${sessionId}（${shortSessionId(sessionId)}）· ${location}${presetNote}`);
        }
        catch (error) {
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
        const resolved = this.#resolveArgOrBound(state, rawTarget, 'archive');
        if ('miss' in resolved) {
            await this.#reply(chatId, resolved.miss);
            return;
        }
        const pending = state.awaitingConfirm;
        if (pending?.command === 'archive') {
            if (pending.sessionId !== resolved.id) {
                state.awaitingConfirm = { command: 'archive', sessionId: resolved.id };
                await this.#reply(chatId, `⚠️ 已改选会话 ${shortSessionId(resolved.id)}，再次发送 /archive 确认归档。`);
                return;
            }
            state.awaitingConfirm = undefined;
        }
        else {
            state.awaitingConfirm = { command: 'archive', sessionId: resolved.id };
            await this.#reply(chatId, `⚠️ 确认归档会话 ${shortSessionId(resolved.id)}？再次发送 /archive 确认（其它命令或文字可取消）。`);
            return;
        }
        try {
            await this.#port.archiveSession(resolved.id);
            if (state.sessionId === resolved.id) {
                state.sessionId = undefined;
                state.typing = false;
                state.stream = undefined;
                this.#clearAsks(state);
            }
            await this.#reply(chatId, `📦 已归档会话 ${shortSessionId(resolved.id)}（加入归档区，从列表与工作区隐藏）`);
            await this.#refreshSessionList(chatId, state);
        }
        catch (error) {
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
        if (rawTarget === '') {
            await this.#sessionListKeyboard(chatId, state, '点下方按钮删除对应会话（删除后从列表隐藏）：');
            return;
        }
        await this.#resetActionRows(chatId, state);
        const resolved = this.#resolveTarget(state, rawTarget);
        if ('miss' in resolved) {
            await this.#reply(chatId, resolved.miss);
            return;
        }
        try {
            await this.#port.archiveSession(resolved.id);
            if (state.sessionId === resolved.id) {
                state.sessionId = undefined;
                state.typing = false;
                state.stream = undefined;
                this.#clearAsks(state);
            }
            await this.#reply(chatId, `🗑 已删除会话 ${shortSessionId(resolved.id)}（从列表与工作区隐藏）`);
            await this.#refreshSessionList(chatId, state);
        }
        catch (error) {
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
        if (raw === '') {
            const bound = state.sessionId;
            if (bound === undefined) {
                await this.#reply(chatId, '当前无激活会话。请先绑定会话（如 /attach），再发 /rename 重命名。');
                return;
            }
            state.awaitingRename = true;
            state.awaitingAskAnswer = undefined;
            await this.#reply(chatId, '/rename：请再次输入标题，当前会话将重命名为（即重命名当前绑定会话）。');
            return;
        }
        // The first token doubles as the target selector only when it parses as
        // one (a bare row index or a UUID session id); the title keeps the full
        // remaining text — never just the first word — or, without a selector,
        // the entire args.
        const space = raw.search(/\s+/);
        const firstToken = space === -1 ? '' : raw.slice(0, space);
        const rest = space === -1 ? '' : raw.slice(space + 1);
        const rawTarget = rest !== '' && this.#looksLikeSelector(firstToken) ? firstToken : '';
        const title = rawTarget === '' ? raw : rest;
        const resolved = this.#resolveArgOrBound(state, rawTarget, 'rename');
        if ('miss' in resolved) {
            await this.#reply(chatId, resolved.miss);
            return;
        }
        try {
            const accepted = await this.#port.renameSession(resolved.id, title);
            await this.#reply(chatId, `✅ 已重命名为 ${accepted}`);
            await this.#refreshSessionList(chatId, state);
        }
        catch (error) {
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
        const resolved = this.#resolveArgOrBound(state, rawTarget, 'fork');
        if ('miss' in resolved) {
            await this.#reply(chatId, resolved.miss);
            return;
        }
        try {
            const childId = await this.#port.forkSession(resolved.id);
            state.sessionId = childId;
            state.rows = undefined;
            state.workspaces = undefined;
            state.attachScopes = false;
            state.keyboard = undefined;
            state.typing = false;
            state.stream = undefined;
            this.#clearAsks(state);
            await this.#reply(chatId, `🔀 已分叉会话 ${shortSessionId(resolved.id)}：新会话 ${childId}（${shortSessionId(childId)}），已绑定到新会话。`);
        }
        catch (error) {
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
        if (sessionId === undefined) {
            await this.#reply(chatId, '还没有绑定会话。发 /attach（或 /new 创建）绑定一个会话后，用 /curTasks 查看它的任务列表。');
            return;
        }
        try {
            const todos = await this.#port.listTodos(sessionId);
            if (todos === null || todos.length === 0) {
                await this.#reply(chatId, '当前会话暂无任务列表。');
                return;
            }
            await this.#reply(chatId, renderTodoList(todos));
        }
        catch (error) {
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
        if (rawTarget === '') {
            await this.#presetListKeyboard(chatId, state);
            return;
        }
        const presets = await this.#port.listPresets();
        const chosen = /^\d+$/.test(rawTarget)
            ? presets.at(Number(rawTarget) - 1)
            : presets.find(preset => preset.id === rawTarget);
        if (chosen === undefined) {
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
        if (sessionId === undefined) {
            state.nextPreset = presetId;
            await this.#reply(chatId, `暂存模式「${label}」：下一次 /new 创建会话时生效。`);
            return;
        }
        try {
            await this.#port.selectPreset(sessionId, presetId);
            await this.#reply(chatId, `✅ 已切换会话模式为「${label}」。`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('（agent-preset-locked）')) {
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
            state.keyboard = undefined;
            state.attachKeyboard = undefined;
            await this.#reply(chatId, '此部署未配置预设模式。');
            return;
        }
        state.keyboard = { kind: 'presets' };
        state.attachKeyboard = undefined;
        let text = '🎛 选择会话模式：\n\n点按钮选择，或发送 /preset <模式名> 直接指定。绑定会话未开始时立即生效；已开始或未绑定时暂存给下一次 /new。';
        if (state.nextPreset !== undefined) {
            const staged = presets.find(preset => preset.id === state.nextPreset);
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
        if (keyboard?.kind !== 'sessions')
            return;
        switch (keyboard.recipe.list) {
            case 'full':
                await this.#sessionListKeyboard(chatId, state, keyboard.hint);
                return;
            case 'ungrouped':
                await this.#attachUngrouped(chatId, state);
                return;
            case 'archived':
                await this.#attachArchived(chatId, state);
                return;
            case 'workspace': {
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
        const slash = needle.indexOf('/');
        if (slash !== -1) {
            const providerId = needle.slice(0, slash);
            const modelId = needle.slice(slash + 1);
            const group = catalog.groups.find(candidate => candidate.id.toLowerCase() === providerId);
            const model = group?.models.find(candidate => candidate.id.toLowerCase() === modelId);
            if (group !== undefined && model !== undefined) {
                return { provider: group.id, providerName: group.name, model: model.id, modelName: model.name };
            }
        }
        for (const group of catalog.groups) {
            for (const model of group.models) {
                if (model.id.toLowerCase().startsWith(needle) || model.name.toLowerCase().startsWith(needle)) {
                    return { provider: group.id, providerName: group.name, model: model.id, modelName: model.name };
                }
            }
        }
        return undefined;
    }
    /**
     * Whether a token parses as a session selector: a bare integer (a 1-based
     * index into the last session list output) or a UUID-shaped session id.
     * @param token - the candidate selector token.
     * @returns whether the token should be read as a selector.
     */
    #looksLikeSelector(token) {
        if (/^\d+$/.test(token))
            return true;
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
        if (raw.trim() === '') {
            if (state.sessionId !== undefined)
                return { ok: true, id: state.sessionId };
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
            if (row !== undefined) {
                return { ok: true, id: row.sessionId };
            }
            return { miss: `序号 ${index} 超出范围：先 /attach 刷新列表` };
        }
        /* v8 ignore start --
         * Every caller splits args and short-circuits an empty target before
         * resolving, so this guard is defense-only dead code.
         */
        if (raw.trim() === '')
            return { miss: '缺少会话参数（<序号|id>）。' };
        return { ok: true, id: SessionId(raw) };
        /* v8 ignore stop */
    }
    async #reply(chatId, text) {
        for (const chunk of chunkText(text)) {
            await this.#transport.sendMessage(chatId, chunk);
        }
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
        const first = stream === undefined || stream.text === '';
        const header = first && state.turnStartTime !== undefined ? `${startClockLabel(state.turnStartTime, this.#now())}\n` : '';
        const body = first ? `${header}🤖 ${block}` : stream.text + block;
        // While the turn is still open the edited message carries the replying
        // marker after a blank line, so the reader always sees the reply is not
        // final; stream.text keeps the bare body the turn/end edit restores.
        const shown = body + STREAM_REPLYING_SUFFIX;
        if (stream !== undefined && Array.from(shown).length <= TELEGRAM_CHUNK_MAX) {
            try {
                await this.#transport.editMessage(chatId, stream.messageId, shown);
                stream.text = body;
                return;
            }
            catch (error) {
                console.warn(`telegram: stream edit failed, sending a fresh message instead: ${String(error)}`);
            }
        }
        let messageId = 0;
        let text = '';
        for (const chunk of chunkText(shown)) {
            messageId = await this.#transport.sendMessage(chatId, chunk);
            text = chunk;
        }
        text = stripStreamSuffix(text);
        state.stream = { messageId, text };
    }
}
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
    if (reason.kind !== 'error' || !('error' in reason))
        return label;
    const message = reason.error.message.trim();
    return message === '' ? label : `${label}\n${truncate(message, TURN_ERROR_REASON_MAX)}`;
}
/** Model-keyboard cap; larger catalogs hint at the omitted count. */
export const MODEL_KEYBOARD_LIMIT = 20;
/** Failure-reason cap on the error turn label. */
export const TURN_ERROR_REASON_MAX = 1000;
/** Completed sessions the /attach keyboard lists at most (besides all running ones). */
export const ATTACH_KEYBOARD_RECENT = 5;
/** History events read for the /attach dialogue page. */
export const ATTACH_READ_LIMIT = 40;
/** User/assistant exchanges /attach shows at most (anti-spam bound). */
export const ATTACH_ROUNDS = 2;
/** Action lines (reasoning passes and tool calls) /attach previews (anti-spam bound). */
export const ATTACH_ACTION_LIMIT = 20;
/** Split command args on the first whitespace run into at most two parts. */
function splitArgs(args) {
    const trimmed = args.trim();
    const space = trimmed.search(/\s+/);
    if (space === -1)
        return [trimmed, ''];
    return [trimmed.slice(0, space), trimmed.slice(space + 1)];
}
const HELP_TEXT = [
    '🤖 dsh 会话遥控台',
    '',
    `/attach [序号|id|none|arc] — 绑定会话并显示最近 ${ATTACH_ROUNDS} 轮对话：无参数选工作区/未分组/归档；none=未分组；arc=归档；序号=当前范围里的会话`,
    '/create — 创建会话菜单：下一级为 /new（新建）与 /fork（分叉）',
    '/operate — 操作会话菜单：下一级为 /archive（归档）、/stop（停止）、/curTasks（任务列表）',
    '/new [路径|序号|none] — 创建会话：无参数弹出工作区选；none=未分类；序号=工作区；路径=服务器目录自动注册',
    '/fork [序号|id] — 分叉会话：从最后一个已完成回合开新会话并绑定（无参数作用于当前绑定）',
    '/archive [序号|id] — 归档会话加入归档区（无参数作用于当前会话；需再次发送 /archive 确认）',
    '/delete [序号|id] — 删除（归档）会话，无参数弹出选择',
    '/stop — 停止进行中的回合（作用于当前绑定会话；未绑定会话时点下方按钮选择）',
    '/status [序号|id] — 会话详情（无参数作用于当前会话；未绑定会话时点下方按钮选择）',
    '/model [模型名] — 设置全局默认模型（无参数弹出模型键盘选择）',
    '/rename [标题] — 重命名会话：无参数交互输入标题（作用于当前绑定会话）；<序号|id> <标题> 指定会话',
    '/curTasks — 查看当前会话的任务列表（与 Web 侧栏任务同源）',
    '/preset [模式名|序号] — 选择会话模式（PTC/标准/极简/创造预设）：无参数弹出预设键盘；已开始会话会暂存到下一次 /new',
    '/close — 收起快捷键盘（需再次发送 /close 确认；会话绑定不变）',
    '',
    '会话/工作区列表下方会出现快捷键盘：点按钮 = 自动发送对应命令，无需复制 id。',
    '/ 命令菜单从 /keyboard 开始（一键唤醒键盘区），接着 /attach（绑定入口），其余只保留键盘上没有的命令：/status、/model、/delete、/rename、/preset、/start。',
    '运行 /attach、/status、/stop 等不带键盘的命令后，快捷键盘会回到常用操作行（/create /archive /attach /close）。',
    '绑定会话后，agent 的回复会实时推送到这里。',
    '以 / 开头的消息是命令；要用 / 开头的内容发给 harness，',
    '请在前面加 \\ 转义（如 \\/model）。',
].join('\n');
//# sourceMappingURL=console.js.map