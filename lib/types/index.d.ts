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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { Bot } from 'grammy';
import type { BotCommand } from 'grammy/types';
import { ProxyAgent } from 'undici';
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy';
import { type SessionConsolePort } from './console.ts';
/** Interval between typing-indicator pumps for chats with a running turn. */
export declare const TYPING_PUMP_INTERVAL_MS = 5000;
/** Rejection reply for chats outside the allowlist (no session facts leak). */
export declare const DENIED_REPLY = "\u26D4 \u65E0\u6743\u8BBF\u95EE\u3002";
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
export declare const COMMANDS: BotCommand[];
/** The settings namespace this surface edits (model-visible from the settings pages). */
export declare const TELEGRAM_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/**
 * The settings section the harness reads the global default model selection
 * from. Same branded value as `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE` in
 * `@deepseek-ai/dsh-agent-default-model` — the section `AgentDefaultModelConfig`
 * registers — so a write here is what new sessions and sessions whose own log
 * names no selection start from.
 */
export declare const GLOBAL_DEFAULT_MODEL_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/** Telegram remote-control plugin configuration. */
export interface Config {
    /** The bot token (create with @BotFather); usually supplied via `!!js process.env.TELEGRAM_BOT_TOKEN`. */
    botToken: string;
    /**
     * Chat ids allowed to use this bot (private chats and groups share the
     * numeric id space). Empty denies everything — the first run logs rejected
     * chat ids for the operator to copy.
     */
    allowChatIds: number[];
    /**
     * HTTP CONNECT proxy for Telegram API traffic; defaults to the process
     * `ALL_PROXY` then `HTTPS_PROXY`. Omit both when the deployment reaches
     * api.telegram.org directly.
     */
    proxy?: string;
}
/** Schemastery configuration for the Telegram console consumer. */
export declare const Config: z<Config>;
/** Cordis function-plugin name. */
export declare const name = "telegram";
/** Services required before the console can drive sessions. */
export declare const inject: string[];
/**
 * Adapt the host ApiProxy to the console port. RPC refusals become
 * UI-ready errors. Exported for unit tests and for deployments that want to
 * drive the console from another ApiProxy face.
 * @param api - the host ApiProxy.
 * @returns the console port.
 */
export declare function createPort(api: ApiProxy): SessionConsolePort;
/** One long-polling bot session: grammY wiring plus the console surface. */
interface BotSession {
    /** Tear the polling loop, event feed, and typing pump down (idempotent). */
    stop(): Promise<void>;
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
export declare function startBotSession(options: {
    config: Config;
    api: ApiProxy;
    events: Context;
    logger: Context['logger'];
    onListened: (config: Config, username: string) => void;
    /**
     * Replace the grammY client under test — the default builds a live
     * long-polling bot over the proxy tunnel.
     */
    createBot?: (config: Config, proxyAgent: ProxyAgent | undefined) => Bot;
}): BotSession;
/**
 * Install the Telegram surface: bot lifecycle, access gate, the console
 * wiring, and the settings namespace that pages edit. Configuration comes
 * from the `telegram` settings namespace when one exists (the composition
 * entry stays the base layer); any committed change rebuilds the bot session
 * so tokens, allowlists, and proxies take effect without a restart.
 * @param ctx - the plugin context (carries `apiProxy` after inject).
 * @param config - validated plugin configuration (the settings base layer).
 */
export declare function apply(ctx: Context, config: Config): void;
export {};
//# sourceMappingURL=index.d.ts.map