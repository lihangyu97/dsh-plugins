# @local/dsh-turn-notify

每轮对话**回答结束后**弹一条桌面通知，点击通知跳回那个会话。

## 两条投递路径

| 场景 | 谁来发 | 归属应用 | 点击行为 | Script Editor |
| --- | --- | --- | --- | --- |
| 页面开着（含最小化/后台） | 页内 `client.js`，浏览器 Notification API | **DeepSeek Harness** | **跳回该会话**（`uiWorkspace.openSession`） | 不涉及 |
| 页面关掉了 | Host `index.js` | `terminal-notifier`（若装了）或 Script Editor | 只前置 App，不选会话 | terminal-notifier 没有；osascript 会有，插件会在 4 秒后退出它 |

页面每 15 秒向 Host 的 `/turn-notify/hello` 报到一次，并带上 `Notification.permission` 是否为 `granted`。
Host 只在这条心跳新鲜（45 秒内）且页面有通知权限时把通知交给页面，其余情况自己兜底——
所以页面没加载完、被关掉、或通知权限被拒，都不会丢通知。

- 触发点是持久化的 `turn/end` 会话事件，一个跑了很多步的轮次只提醒一次。
- 文案来自同一条事件流的折叠结果：会话标题（`sessionTitle`）、首条用户消息（标题还没生成时的兜底）、最新一条 assistant 回答。
- Host 兜底时所有可见文本都以 `argv` 传给通知程序，AppleScript 脚本本身不被插值。
- 未取走的通知最多留 60 秒、最多 20 条，页面重新连上时不会补一屏旧通知。

## 配置

改 `cordis.patch.yml` 里 `turn-notify` 行的 `config`，保存即热重载，重启后仍生效。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时插件激活但不注册监听 |
| `title` | `DeepSeek Harness` | Host 兜底通知的标题（页内通知的标题是会话标题） |
| `silent` | `false` | 静音开关 |
| `sound` | `''` | 提示音名，如 `Glass`、`Ping`；留空即无声（terminal-notifier 走 `default`） |
| `maxTopicChars` | `80` | 会话标题截断长度 |
| `maxBodyChars` | `140` | 回答摘要截断长度 |
| `skipSubagents` | `true` | 跳过子代理 / workflow 子会话，避免一次任务弹很多条 |
| `onlyCompleted` | `false` | 只提醒正常结束的轮次；`true` 时中断、报错、超长都不提醒 |
| `notifier` | `auto` | Host 兜底用哪个通知器：`auto`（有 terminal-notifier 就用）/ `osascript` / `terminal-notifier` |
| `terminalNotifierPath` | `''` | 指定 terminal-notifier 路径；留空自动探测 brew 位置 |
| `quitScriptEditor` | `true` | osascript 兜底弹完后退出 Script Editor（延迟 4 秒），防止它常驻程序坞 |

**想彻底告别 Script Editor**：`brew install terminal-notifier`，然后把 `notifier` 留 `auto` 即可自动切换。

## 行为细节

- 页内通知：标题 = 会话标题；正文 = 最后一条回答的压缩摘录（回答为空时显示「第 N 轮 · 完成」）；同一会话的通知用会话 id 做 `tag`，新的顶掉旧的。
- 非正常结束会带前缀，例如 `⚠️ 被中断：<摘要>`。
- 子代理会话（`header.origin === 'subagent'` 或有 `parentSession`）默认被跳过。
- 会话被销毁时清掉该会话的折叠缓存；通知失败只记一条 warn，不影响会话流程。
- 首次用页内通知时，macOS 可能弹一次「DeepSeek Harness 想要发送通知」，允许即可；拒绝也不影响通知，Host 会自动接管。

## 安装与生效

```bash
# 通过 plugin_manager install_bundle 安装，target 传本目录绝对路径
/Users/lihangyu/.dsh/my-plugins/turn-notify
```

- **改了 `index.js`（Host 半）之后需要重启 App**：Host 侧模块只在启动时导入一次，热重载不换 JS 实例。
- **改了 `client.js`（页内半）之后刷新页面即可**（Host 侧扫描到新 bundle；极端情况下也需重启）。
- 目录被移动过后要重新 `install_bundle`（profile 里存的是软链）。

## 一个已验证的弯路：别用 osacompile 的 applet 发通知

一度想用 `osacompile` 生成一个 `LSUIElement` 小 app 来避开 Script Editor。实测（用 `~/Library/Group Containers/group.com.apple.usernoted/db2/db` 的 `app` / `record` 表核对）**applet 根本不会投递通知**：既没有 app 注册记录，也没有投递记录，无论是否设 `LSUIElement`、是否 ad-hoc 签名、是否带 argv、直接执行还是 `open -a` 都一样。「进程里没有 Script Editor」只是因为它什么都没发出去。`notifier/build-notifier.sh` 保留在仓库里作为记录，默认不启用。
