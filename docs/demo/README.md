# 演示素材(Demo media)

本目录存放 README「效果展示」表格引用的动图/截图,由仓库维护者提供:

| 文件名 | 内容建议 |
| --- | --- |
| `attach-stream.gif` | `/attach` 绑定会话 → 发一条 prompt → 实时流式回复在同一条消息上原地编辑 → 最终渲染为 HTML 回复 |
| `keyboards.gif` | 用回复键盘一路点按:`/create` → `/new` → 派个任务 → `/stop` 取消 |
| `ask-question.gif` | Agent 调用 `ask_user_question` → 弹出内联按钮 → 点按作答 → Agent 继续 |

## 录制建议

- 每条 10–20 秒,单文件 ≤ 2 MB。
- 可用真实任务(如"总结这个仓库")或演示脚本任务;建议在 Telegram 桌面/移动端各录一条移动端效果。
- 录制工具:macOS QuickTime / OBS / 手机自带录屏;GIF 导出用 `ffmpeg` 或 [gifski](https://gif.ski)。

## 放置与更新

- 文件直接放本目录,保持 README 表格里的相对路径不变(`docs/demo/<文件名>.gif`)。
- GitHub 支持 GIF 首帧预览;若想更清晰可附 `.webm`/`.mp4` 链接。
- 替换前 README 中对应图片会显示为 broken image,属预期状态。