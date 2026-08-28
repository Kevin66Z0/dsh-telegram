# Telegram style reference

Read-this-first reference for any Telegram reply-format, keyboard, or message-formatting requirement on the `@deepseek-ai/dsh-host-telegram` surface. It maps the surface's own rendering code and links a local mirror of the official Bot API. Read both before editing `../src`.

## The surface, mapped

| Concern | Home |
| --- | --- |
| Reply keyboard layout — shared action rows (`/create /archive /attach` on the first row, `/stop` `/close` on the second; `/create` opens the `/new`/`/fork` sub-menu, `/archive` archives the bound session, `/stop` cancels the bound session's active turn, `/operate` stays typed), the session / workspace / preset rows (examples `/delete 2 · …`, `/new 1 · 项目`, `/preset 1 · …`), the attach keyboard (installed by bare `/attach` beside the scope picker, refreshed to a fresh running-first list on every bare `/attach` flow and kept by every attach session list — action rows plus one bind button per highlight: all running sessions then the five most recently completed, globally; its numbered rows back `/attach <n>` until another surface takes over, backed by `#attachKeyboardItems` / `#attachKeyboardInstall` in `console.ts`), the `/keyboard` command that re-opens the reply-keyboard area (refreshing the attach list when one is installed), the `/close` and `/archive` second-confirmation flow (`#commandClose` / `#commandArchive` arm on the first send, execute on the identical second send, cancel on any other command or free text; different `/archive` targets re-arm), and the stale-keyboard reset — a command whose surface is not a reply keyboard resets a picker keyboard to those action rows (`#resetActionRows` in `console.ts`) | `../src/render.ts` (`KEYBOARD_ACTION_ROWS`, `sessionKeyboardRows`, `attachKeyboardRows`, `workspaceKeyboardRows`, `presetKeyboardRows`) |
| `/attach` inline picker — scope buttons (`📁 <title>`, 未分组, 归档) and session bind buttons; callback tokens `atw` / `atn` / `ata` / `ats`. The attach preview closes a finished session (latest turn ended) with the last completed turn's token-usage footer (`roundUsageFooter` over `lastTurnUsage`, `⚡ 本轮`) | `../src/render.ts` (`attachScopeButtons`, `attachSessionButtons`, `parseAttachCallback`) |
| Session action-list inline surface — unbound `/stop` (stop buttons) and `/status` (status buttons) session lists, one tap-to-act button per session; callback tokens `stp` / `sta` | `../src/render.ts` (`sessionStopData`, `sessionStatusData`, `sessionActionButtons`, `parseSessionListCallback`), routed in `handleCallback` |
| `ask_user_question` inline keyboard — option, submit, cancel, custom-answer buttons; callback tokens `qo` / `qt` / `qs` / `qx` | `../src/render.ts` (`questionMessageText`, `questionKeyboard`, `parseQuestionCallback`) |
| grammY wire markup — `reply_keyboard` (with `resize_keyboard`, `is_persistent`, `input_field_placeholder`), `inline_keyboard`, `remove_keyboard` | `../src/index.ts` (`sendReplyKeyboard`, `sendInlineKeyboard`, `editInlineKeyboard`, `removeKeyboard`, `inlineKeyboardMarkup`) |
| Markdown to Telegram HTML — bold/italic/strikethrough, inline and fenced code, quote, lists, tables, links | `../src/markdown.ts` (`markdownToTelegramHtml`) |
| Command and `ask_user_question` behavior contract | `../README.md`, `../README.zh.md` |

## Official Bot API (local mirror)

- `./official/bot-api.md` — the full Bot API reference: `sendMessage` `reply_markup`, `InlineKeyboardMarkup` / `InlineKeyboardButton`, `ReplyKeyboardMarkup` / `KeyboardButton`, `ReplyKeyboardRemove`, `ForceReply`, `Formatting options`, `MessageEntity`, and the per-field length and byte limits.
- `./official/bot-features.md` — the Bot Features walkthroughs: Commands, Keyboards, Inline Keyboards.

Upstream pages are https://core.telegram.org/bots/api and https://core.telegram.org/bots/features. The mirror is a third-party reference snapshot, English-only and unpaired (it is not repo prose).

## Style essentials

- **Parse modes.** `parse_mode` is `HTML` or `MarkdownV2`. The surface renders a finished reply as Telegram HTML (`markdownToTelegramHtml`) and keeps streaming text plain, because the chunker cuts HTML tags mid-stream. Telegram HTML supports `<b>`/`<strong>`, `<i>`/`<em>`, `<u>`/`<ins>`, `<s>`/`<strike>`/`<del>`, `<span class="tg-spoiler">`/`<tg-spoiler>`, `<tg-emoji emoji-id="...">`, `<a href="...">`, `<code>`, `<pre>`, `<pre><code class="language-...">`, `<blockquote>`, and `<blockquote expandable>`. HTML text escapes `&`, `<`, `>` before markup (`escapeHtml`); the exhaustive tag and escaping rules live under `Formatting options` in `./official/bot-api.md`.
- **Reply markup kinds.** The `reply_markup` field of `sendMessage` takes `ReplyKeyboardMarkup` (persistent reply keyboard: `keyboard` rows plus `resize_keyboard`, `one_time_keyboard`, `is_persistent`, `input_field_placeholder`, `selective`), `InlineKeyboardMarkup` (message-attached buttons carrying `callback_data`, `url`, `web_app`, etc.), `ReplyKeyboardRemove`, or `ForceReply`. Field tables are in `./official/bot-api.md`.
- **Limits that bite this surface.** Message text is 1–4096 characters; the surface chunks at `TELEGRAM_CHUNK_MAX` (3500) to stay under it. Caption is 1–1024. Inline-keyboard `callback_data` is 1–64 bytes — why the question buttons pack `qo|qt|qs|qx:<rpcId>[:<q>[:<o>]]` to fit. `input_field_placeholder` is 1–64 characters. The surface's own budget (`SESSION_KEYBOARD_TITLE_MAX`, `WORKSPACE_KEYBOARD_TITLE_MAX`) keeps each reply-keyboard button label on one narrow-phone line.

## Refresh

The mirror is a snapshot. To refresh it, re-download the two upstream pages (through the deployment proxy), extract the `dev_page_content` div, and convert to Markdown with a GFM table rule; bump the download date in each `./official/*.md` header and the source note here.
