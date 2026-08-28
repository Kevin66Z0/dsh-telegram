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
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { Bot } from 'grammy';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { TelegramConsole } from "./console.js";
import { lastTodoWrite } from "./render.js";
/** Interval between typing-indicator pumps for chats with a running turn. */
export const TYPING_PUMP_INTERVAL_MS = 5000;
/** Rejection reply for chats outside the allowlist (no session facts leak). */
export const DENIED_REPLY = '⛔ 无权访问。';
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
export const COMMANDS = [
    { command: 'keyboard', description: '唤醒/刷新下方键盘区（恢复常用命令按钮与运行中会话的快捷绑定）' },
    { command: 'attach', description: '选择会话并绑定（<序号|id|none|arc>；会话列表时键盘区可直接点选）' },
    { command: 'status', description: '查看会话详情' },
    { command: 'model', description: '设置全局默认模型（无参数弹出模型列表）' },
    { command: 'delete', description: '删除（归档）会话 <序号|id>，无参数弹出选择' },
    { command: 'rename', description: '重命名会话 <标题>' },
    { command: 'preset', description: '选择会话模式（PTC/标准/极简/创造等预设）<模式名|序号>' },
    { command: 'start', description: '显示帮助与全部命令' },
];
/** The settings namespace this surface edits (model-visible from the settings pages). */
export const TELEGRAM_SETTINGS_NAMESPACE = settingsNamespace('telegram');
/**
 * The settings section the harness reads the global default model selection
 * from. Same branded value as `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE` in
 * `@deepseek-ai/dsh-agent-default-model` — the section `AgentDefaultModelConfig`
 * registers — so a write here is what new sessions and sessions whose own log
 * names no selection start from.
 */
export const GLOBAL_DEFAULT_MODEL_NAMESPACE = settingsNamespace('agent-default-model');
/** Schemastery configuration for the Telegram console consumer. */
export const Config = z.object({
    botToken: z.string().required(),
    allowChatIds: z.array(z.number()).required(),
    proxy: z.string(),
});
/** Cordis function-plugin name. */
export const name = 'telegram';
/** Services required before the console can drive sessions. */
export const inject = ['apiProxy'];
/** The proxy this deployment uses, or undefined for a direct connection. */
function resolveProxy(config) {
    return config.proxy ?? process.env.ALL_PROXY ?? process.env.HTTPS_PROXY ?? undefined;
}
/**
 * Adapt the host ApiProxy to the console port. RPC refusals become
 * UI-ready errors. Exported for unit tests and for deployments that want to
 * drive the console from another ApiProxy face.
 * @param api - the host ApiProxy.
 * @returns the console port.
 */
export function createPort(api) {
    const rpcId = () => RpcId(randomUUID());
    const failure = (message, code) => new Error(`${message}（${code}）`);
    return {
        async listSessions() {
            const response = await api.sessions.list({ rpcId: rpcId(), payload: {} });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return response.result.value.items;
        },
        async readHistory(sessionId, maxMessages) {
            const payload = { sessionId, ...(maxMessages === undefined ? {} : { maxMessages }) };
            const response = await api.sessions.history({ rpcId: rpcId(), payload });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return response.result.value.events.map(entry => entry.event);
        },
        async sendPrompt(sessionId, mode, text) {
            const response = await api.sessions.prompt({
                rpcId: rpcId(),
                payload: { sessionId, mode, content: [{ type: 'text', text }] },
            });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
        },
        async stopSession(sessionId) {
            const response = await api.sessions.cancel({ rpcId: rpcId(), payload: { sessionId } });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
        },
        async listGlobalModels() {
            const response = await api.llm.models({ rpcId: rpcId(), payload: {} });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return response.result.value;
        },
        async setGlobalDefaultModel(provider, model) {
            const response = await api.settings.update({
                rpcId: rpcId(),
                payload: { ns: GLOBAL_DEFAULT_MODEL_NAMESPACE, patch: { provider, model } },
            });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
        },
        async createSession(options) {
            const payload = {
                ...(options?.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
                ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options?.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
            };
            const response = await api.sessions.create({ rpcId: rpcId(), payload });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return response.result.value.sessionId;
        },
        async listWorkspaces() {
            const response = await api.workspace.list({ rpcId: rpcId(), payload: {} });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return response.result.value.items;
        },
        async listArchivedSessionIds() {
            const response = await api.workspace.list({ rpcId: rpcId(), payload: {} });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return response.result.value.archivedSessionIds;
        },
        async createWorkspace(path) {
            const response = await api.workspace.create({ rpcId: rpcId(), payload: { path } });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return response.result.value.workspace;
        },
        async archiveSession(sessionId) {
            const response = await api.workspace.archiveSession({ rpcId: rpcId(), payload: { sessionId } });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
        },
        async renameSession(sessionId, title) {
            const response = await api.sessions.rename({ rpcId: rpcId(), payload: { sessionId, title } });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return response.result.value.title;
        },
        async forkSession(sessionId) {
            const response = await api.sessions.fork({ rpcId: rpcId(), payload: { sessionId } });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return response.result.value.sessionId;
        },
        async listTodos(sessionId) {
            const response = await api.sessions.history({ rpcId: rpcId(), payload: { sessionId, maxMessages: 20 } });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            // `todos` rides the session-projection map as a whole-value key the todo
            // domain declares via declaration merging; the zod wire schema validates
            // it, so the local re-declaration stays a typed view of the same value.
            const values = response.result.value.projections?.values;
            if (values?.todos !== undefined)
                return values.todos;
            return lastTodoWrite(response.result.value.events.map(entry => entry.event));
        },
        async listPresets() {
            const response = await api.agentPresets.list({ rpcId: rpcId(), payload: {} });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
            return [...response.result.value.presets];
        },
        async selectPreset(sessionId, agentPreset) {
            const response = await api.agentPresets.select({ rpcId: rpcId(), payload: { sessionId, agentPreset } });
            if (!response.result.ok)
                throw failure(response.result.error.message, response.result.error.code);
        },
        async answerQuestion(rpcId, sessionId, answer) {
            const response = await api.respond({
                type: 'client-response',
                rpcId: rpcId,
                result: { ok: true, value: { sessionId, answer } },
            });
            if (!response.accepted) {
                throw new Error(`提问回答被拒绝（${response.reason}）`);
            }
        },
        async cancelQuestion(rpcId) {
            const response = await api.respond({
                type: 'client-response',
                rpcId: rpcId,
                result: {
                    ok: false,
                    error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
                },
            });
            if (!response.accepted) {
                throw new Error(`提问取消失败（${response.reason}）`);
            }
        },
    };
}
/** Map console answer buttons to the Telegram inline-keyboard wire rows. */
function inlineKeyboardMarkup(rows) {
    return rows.map(row => row.map(button => ({ text: button.text, callback_data: button.data })));
}
/**
 * Build the grammY client for one bot session: route every Telegram API call
 * through the CONNECT proxy tunnel when one is configured.
 * @param config - the session configuration (provides the bot token).
 * @param proxyAgent - the prebuilt undici proxy agent, or undefined for a direct connection.
 * @returns the configured grammY bot.
 */
function createBot(config, proxyAgent) {
    return new Bot(config.botToken, proxyAgent === undefined ? {} : {
        client: {
            // grammY's Node runner asks for a `typeof fetch` implementation;
            // undici's fetch signature is structurally identical plus its
            // non-standard `dispatcher` init field, which DOM RequestInit does not
            // carry. One architectural assertion bridges the two request shapes.
            fetch: ((url, init) => {
                // grammY's Node shim hands over its own AbortSignal class instance,
                // which undici's validator does not recognize; dropping it keeps the
                // proxy tunnel working — grammY settles timeouts by race, and
                // bot.stop() tears the connection down anyway.
                const { signal: _signal, ...rest } = init ?? {};
                return undiciFetch(url, { ...rest, dispatcher: proxyAgent });
            }),
        },
    });
}
/**
 * Fixed scopes whose stale command tables would shadow the default table in
 * their surface: BotFather's prompt-time presets (e.g. a fresh bot ships
 * `/start` `/help` `/status` under `all_private_chats`) win over
 * `botCommandScopeDefault` even when both exist. Cleared before registering
 * {@link COMMANDS} so the `/` menu is identical everywhere.
 */
const PRESET_COMMAND_SCOPES = [
    { type: 'all_private_chats' },
    { type: 'all_group_chats' },
    { type: 'all_chat_administrators' },
];
/**
 * Best-effort command menu sync: tear down stale fixed scopes, then register
 * {@link COMMANDS} on the default scope. Any failure only warns — a menu
 * hiccup never blocks the long-poll loop.
 * @param bot - the grammY client.
 * @param logger - the plugin logger.
 */
function syncCommandMenu(bot, logger) {
    void (async () => {
        for (const scope of PRESET_COMMAND_SCOPES) {
            await bot.api.deleteMyCommands({ scope }).catch((error) => {
                logger.warn(`telegram: stale menu scope teardown failed for ${scope.type}: ${String(error)}`);
            });
        }
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
export function startBotSession(options) {
    const { config, api, events, logger, onListened } = options;
    const allowed = new Set(config.allowChatIds);
    const proxy = resolveProxy(config);
    // grammY's Node runner fetches through its own node-fetch-compatible
    // request layer, which ignores undici's `dispatcher` init field; a custom
    // fetch routes every Telegram API call through the CONNECT proxy instead.
    const proxyAgent = proxy === undefined ? undefined : new ProxyAgent(proxy);
    const bot = (options.createBot ?? createBot)(config, proxyAgent);
    bot.catch((error) => {
        logger.warn(`telegram: bot error: ${error.message}`);
    });
    const transport = {
        sendMessage: async (chatId, text) => {
            const message = await bot.api.sendMessage(chatId, text);
            return message.message_id;
        },
        editMessage: async (chatId, messageId, text) => {
            await bot.api.editMessageText(chatId, messageId, text);
        },
        sendMessageHtml: async (chatId, html) => {
            const message = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
            return message.message_id;
        },
        editMessageHtml: async (chatId, messageId, html) => {
            await bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' });
        },
        sendChatAction: async (chatId, action) => {
            await bot.api.sendChatAction(chatId, action);
        },
        sendReplyKeyboard: async (chatId, text, rows) => {
            const sent = await bot.api.sendMessage(chatId, text, {
                reply_markup: {
                    keyboard: rows.map(row => row.map(text => ({ text }))),
                    resize_keyboard: true,
                    // Persist across the user's own messages, so the session buttons
                    // stay tappable through prompts until a command replaces them.
                    is_persistent: true,
                    input_field_placeholder: '向 agent 发消息，或 /start 查看命令',
                },
            });
            return sent.message_id;
        },
        removeKeyboard: async (chatId, text) => {
            const sent = await bot.api.sendMessage(chatId, text, {
                reply_markup: { remove_keyboard: true },
            });
            return sent.message_id;
        },
        sendInlineKeyboard: async (chatId, text, rows) => {
            const sent = await bot.api.sendMessage(chatId, text, {
                reply_markup: { inline_keyboard: inlineKeyboardMarkup(rows) },
            });
            return sent.message_id;
        },
        editInlineKeyboard: async (chatId, messageId, text, rows) => {
            await bot.api.editMessageText(chatId, messageId, text, {
                reply_markup: { inline_keyboard: inlineKeyboardMarkup(rows) },
            });
        },
    };
    const telegramConsole = new TelegramConsole(createPort(api), transport);
    bot.on('message:text', (messageContext) => {
        const chatId = messageContext.chat.id;
        if (!allowed.has(chatId)) {
            logger.warn(`telegram: chat ${chatId} refused: not in allowChatIds`);
            // The reply carries the caller's own chat id so the operator can paste
            // it straight into the allowlist; nothing else about the surface leaks.
            void bot.api.sendMessage(chatId, `${DENIED_REPLY} 如需访问，请将 chat id ${chatId} 加入 allowChatIds 白名单。`).catch((error) => {
                logger.debug(`telegram: denial reply failed: ${String(error)}`);
            });
            return;
        }
        void telegramConsole.handleMessage(chatId, messageContext.message.text).catch((error) => {
            logger.warn(`telegram: message handling failed: ${String(error)}`);
        });
    });
    bot.on('callback_query', (callbackContext) => {
        const { message, data } = callbackContext.callbackQuery;
        // Ack first (clears the tap spinner); the console then routes the button.
        void bot.api.answerCallbackQuery(callbackContext.callbackQuery.id).catch((error) => {
            logger.debug(`telegram: callback ack failed: ${String(error)}`);
        });
        const chatId = message?.chat.id;
        if (chatId === undefined || data === undefined)
            return;
        if (!allowed.has(chatId)) {
            logger.warn(`telegram: chat ${chatId} refused: not in allowChatIds`);
            return;
        }
        void telegramConsole.handleCallback(chatId, data).catch((error) => {
            logger.warn(`telegram: callback handling failed: ${String(error)}`);
        });
    });
    const stopEvents = events.on('session/event', (session, event) => {
        void telegramConsole.onSessionEvent(session.id, event).catch((error) => {
            logger.warn(`telegram: event push failed: ${String(error)}`);
        });
    });
    const typingTimer = setInterval(() => {
        void telegramConsole.pumpTyping().catch((error) => {
            logger.warn(`telegram: typing pump failed: ${String(error)}`);
        });
    }, TYPING_PUMP_INTERVAL_MS);
    let stopped = false;
    void bot.start({
        onStart: (botInfo) => {
            syncCommandMenu(bot, logger);
            onListened(config, botInfo.username);
        },
    })
        .catch((error) => {
        logger.error(`telegram: long polling start failed: ${String(error)}`);
    });
    return {
        async stop() {
            if (stopped)
                return;
            stopped = true;
            stopEvents();
            clearInterval(typingTimer);
            await bot.stop();
        },
    };
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
export function apply(ctx, config) {
    console.log(`telegram: configuring bot for ${config.allowChatIds.length} allowed chat ids`);
    ctx.inject(['apiProxy'], (apiCtx) => {
        const logger = ctx.logger;
        let session;
        let sessionGeneration = 0;
        const startSession = (cfg) => {
            const generation = ++sessionGeneration;
            void (async () => {
                await session?.stop();
                if (generation !== sessionGeneration)
                    return;
                session = startBotSession({
                    config: cfg,
                    api: apiCtx.apiProxy,
                    events: apiCtx,
                    logger,
                    onListened: (current, username) => {
                        console.log(`telegram: bot @${username} listening`);
                        logger.info(`telegram: bot @${username} listening with ${current.allowChatIds.length} allowed chat ids`);
                    },
                });
            })().catch((error) => {
                logger.error(`telegram: bot session start failed: ${String(error)}`);
            });
        };
        // The settings seam: registered as the `telegram` namespace with the
        // composition entry as base; a committed edit re-runs the session.
        const reconciler = () => {
            const next = configSource();
            if (JSON.stringify(next) === JSON.stringify(config))
                return;
            config = next;
            console.log(`telegram: reconfiguring bot for ${next.allowChatIds.length} allowed chat ids`);
            startSession(next);
        };
        let configSource = () => config;
        installSettingsSection(ctx, TELEGRAM_SETTINGS_NAMESPACE, Config, config, {
            setSource: (current) => {
                configSource = current;
            },
            onChange: reconciler,
        });
        ctx.effect(() => async () => {
            sessionGeneration += 1;
            await session?.stop();
        }, 'telegram.lifecycle()');
        startSession(config);
    });
}
//# sourceMappingURL=index.js.map