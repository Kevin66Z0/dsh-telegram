/**
 * Chat-bound remote console over a {@link SessionConsolePort}: command
 * routing, session binding, prompt forwarding, and realtime push of the bound
 * session's events. Pure orchestration — I/O goes through the injected port
 * and transport, so unit tests drive the full flow without a live bot or
 * harness.
 * @module @deepseek-ai/dsh-host-telegram/console
 */
import { SessionId, type SessionEvent, type SessionId as SessionIdBrand, type TodoItem } from '@deepseek-ai/dsh-session';
import type { AgentPresetEntry, ModelCatalogFailure, ModelProviderGroup, SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy';
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions';
import { type AnswerButton } from './render.ts';
/** Session operations this console needs; implemented over ApiProxy by the entry. */
export interface SessionConsolePort {
    /** Attached plus cold session summaries, updatedAt descending. */
    listSessions(): Promise<SessionSummary[]>;
    /** Raw tail page of session events (API-aligned message boundaries). */
    readHistory(sessionId: SessionIdBrand, maxMessages?: number): Promise<readonly SessionEvent[]>;
    /** Send one text prompt; resolves after durable host admission. Throws a UI-ready message on refusal. */
    sendPrompt(sessionId: SessionIdBrand, mode: 'queue' | 'steer', text: string): Promise<void>;
    /** Stop the session's active turn. Throws a UI-ready message on refusal. */
    stopSession(sessionId: SessionIdBrand): Promise<void>;
    /** Host-wide model catalog over every configured provider, needing no session. Throws a UI-ready message on refusal. */
    listGlobalModels(): Promise<{
        groups: ModelProviderGroup[];
        failures: ModelCatalogFailure[];
    }>;
    /** Persist the selection as the global default every future Agent starts from. Throws a UI-ready message on refusal. */
    setGlobalDefaultModel(provider: string, model: string): Promise<void>;
    /**
     * Create a real session with an idle agent. A `workspaceId` attaches the
     * session to that workspace; a bare `cwd` creates an ungrouped session
     * (absent both, the deployment default directory applies). Throws a
     * UI-ready message on refusal.
     */
    createSession(options?: {
        workspaceId?: WorkspaceId;
        cwd?: string;
        agentPreset?: string;
    }): Promise<SessionId>;
    /** Rename a session; resolves with the accepted title. Throws a UI-ready message on refusal. */
    renameSession(sessionId: SessionIdBrand, title: string): Promise<string>;
    /**
     * Fork one session from its last completed turn; resolves with the child
     * session id. Throws a UI-ready message on refusal (e.g. no completed turn).
     */
    forkSession(sessionId: SessionIdBrand): Promise<SessionId>;
    /**
     * The session's whole todo list (the latest `todo/write` snapshot), or
     * `null` before the first write. Throws a UI-ready message on refusal.
     */
    listTodos(sessionId: SessionIdBrand): Promise<TodoItem[] | null>;
    /** The deployment's preset entries (roster order). Throws a UI-ready message on refusal. */
    listPresets(): Promise<AgentPresetEntry[]>;
    /**
     * Recompose one session's agent from a different preset; only a blank
     * session accepts the switch. Throws a UI-ready message on refusal
     * (e.g. the conversation already started).
     */
    selectPreset(sessionId: SessionIdBrand, agentPreset: string): Promise<void>;
    /** The registry's workspace rows in display order. Throws a UI-ready message on refusal. */
    listWorkspaces(): Promise<WorkspaceView[]>;
    /**
     * Register an existing directory (already-owned paths resolve idempotently)
     * as a workspace. Throws a UI-ready message on refusal.
     * @param path - an existing directory path on the host.
     */
    createWorkspace(path: string): Promise<WorkspaceView>;
    /** Archive (hide from every grouping surface) one session. Throws a UI-ready message on refusal. */
    archiveSession(sessionId: SessionIdBrand): Promise<void>;
    /** The registry-global archived id set, for /attach's archived scope. Throws a UI-ready message on refusal. */
    listArchivedSessionIds(): Promise<SessionId[]>;
    /**
     * Settle one pending ask with a full answer batch. Throws a UI-ready message
     * on refusal (e.g. the ask was already claimed elsewhere).
     */
    answerQuestion(rpcId: string, sessionId: SessionIdBrand, answer: AskUserQuestionAnswer): Promise<void>;
    /** Cancel one pending ask. Throws a UI-ready message on refusal. */
    cancelQuestion(rpcId: string): Promise<void>;
}
/** Outbound Telegram surface this console drives. */
export interface ConsoleTransport {
    /**
       * Send one plain message; resolves with the message id for in-place edits.
       * @param chatId - the target chat.
       * @param text - the message text.
       * @returns the new message's Telegram message id.
       */
    sendMessage(chatId: number, text: string): Promise<number>;
    /**
     * Replace one message's text in place (the in-turn stream edit).
     * @param chatId - the chat holding the message.
     * @param messageId - the Telegram message id to edit.
     * @param text - the replacement text.
     * @returns after the edit is admitted.
     */
    editMessage(chatId: number, messageId: number, text: string): Promise<void>;
    /**
     * Send one HTML-parsed message; the turn finalization uses it to render the
     * token-usage footer in a small `<pre>` block.
     * @param chatId - the target chat.
     * @param html - the message text with Telegram HTML entities.
     * @returns the new message's Telegram message id.
     */
    sendMessageHtml(chatId: number, html: string): Promise<number>;
    /**
     * Replace one message's text with HTML parsing (the turn finalization with
     * its token-usage footer).
     * @param chatId - the chat holding the message.
     * @param messageId - the Telegram message id to edit.
     * @param html - the replacement text with Telegram HTML entities.
     * @returns after the edit is admitted.
     */
    editMessageHtml(chatId: number, messageId: number, html: string): Promise<void>;
    /**
     * Send one message whose reply keyboard stays shown for the chat; tapping a
     * button sends its text verbatim, so this surface uses finished command
     * lines (e.g. `/attach 3 · 标题`) as button texts. One reply keyboard per
     * chat: the latest send replaces any previous one.
     * @param chatId - the target chat.
     * @param text - the message text above the keyboard.
     * @param rows - the reply-keyboard rows (button texts).
     * @returns the new message's Telegram message id.
     */
    sendReplyKeyboard(chatId: number, text: string, rows: ReadonlyArray<ReadonlyArray<string>>): Promise<number>;
    /**
     * Send one message that dismisses the chat's reply keyboard.
     * @param chatId - the target chat.
     * @param text - the dismissal message text.
     * @returns the new message's Telegram message id.
     */
    removeKeyboard(chatId: number, text: string): Promise<number>;
    /** Drive the chat's typing indicator. */
    sendChatAction(chatId: number, action: 'typing'): Promise<void>;
    /**
     * Send one message with an inline keyboard: option and action buttons carry
     * callback data back to {@link TelegramConsole.handleCallback}. Tapping a
     * button only queries the bot — no text reaches the chat.
     * @param chatId - the target chat.
     * @param text - the message text above the buttons.
     * @param rows - the inline-keyboard rows (text + callback data).
     * @returns the new message's Telegram message id.
     */
    sendInlineKeyboard(chatId: number, text: string, rows: AnswerButton[][]): Promise<number>;
    /**
     * Replace one inline-keyboard message's text and buttons in place; empty
     * rows remove the keyboard.
     * @param chatId - the chat holding the message.
     * @param messageId - the Telegram message id to edit.
     * @param text - the replacement text.
     * @param rows - the replacement inline-keyboard rows; empty clears.
     * @returns after the edit is admitted.
     */
    editInlineKeyboard(chatId: number, messageId: number, text: string, rows: AnswerButton[][]): Promise<void>;
}
/** A parsed Telegram command. */
export interface Command {
    readonly name: string;
    readonly args: string;
}
/**
 * Interpret one incoming text: a leading backslash escapes the following
 * text verbatim (so `/`-leading text reaches the harness), a leading `/`
 * names a console command (with any `@bot` suffix stripped), and anything
 * else is a prompt for the open session.
 * @param text - the raw incoming text.
 * @returns the command or prompt interpretation.
 */
export declare function interpretInput(text: string): Command | {
    kind: 'prompt';
    text: string;
};
/**
 * Value injected for clock reads; real calls use the process clock.
 * @returns the current Unix epoch millisecond time.
 */
export type NowFn = () => number;
/**
 * Chat-bound remote console over the harness sessions.
 *
 * One console instance lives for the plugin lifetime. Command replies and
 * event pushes go through {@link ConsoleTransport}; session reads and writes
 * go through {@link SessionConsolePort}. Choose the prompt mode by the last
 * known agent activity: interject (`steer`) while the bound session runs,
 * queue otherwise — cold sessions resume through the port's prompt path.
 */
export declare class TelegramConsole {
    #private;
    /**
     * @param port - session operations (ApiProxy adapter).
     * @param transport - outbound Telegram surface.
     * @param now - clock injection for relative timestamp rendering.
     */
    constructor(port: SessionConsolePort, transport: ConsoleTransport, now?: NowFn);
    /**
     * Handle one allowed chat's incoming text message (commands and prompts).
     * @param chatId - the sender chat id.
     * @param text - the raw message text.
     * @returns after replies are dispatched.
     */
    handleMessage(chatId: number, text: string): Promise<void>;
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
    onSessionEvent(sessionId: SessionIdBrand, event: SessionEvent): Promise<void>;
    /**
     * Drive the Telegram typing indicator for chats whose bound session runs a
     * turn. Called on a fixed interval by the entry.
     * @returns after every pending chat action dispatched.
     */
    pumpTyping(): Promise<void>;
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
    handleCallback(chatId: number, data: string): Promise<void>;
}
/** Model-keyboard cap; larger catalogs hint at the omitted count. */
export declare const MODEL_KEYBOARD_LIMIT = 20;
/** Failure-reason cap on the error turn label. */
export declare const TURN_ERROR_REASON_MAX = 1000;
/** Completed sessions the /attach keyboard lists at most (besides all running ones). */
export declare const ATTACH_KEYBOARD_RECENT = 5;
/** History events read for the /attach dialogue page. */
export declare const ATTACH_READ_LIMIT = 40;
/** User/assistant exchanges /attach shows at most (anti-spam bound). */
export declare const ATTACH_ROUNDS = 2;
/** Action lines (reasoning passes and tool calls) /attach previews (anti-spam bound). */
export declare const ATTACH_ACTION_LIMIT = 20;
//# sourceMappingURL=console.d.ts.map