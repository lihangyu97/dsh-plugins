# @local/dsh-menubar-status

macOS 菜单栏常驻一个鲸鱼图标，右侧显示 `N/M`，点击唤起 DeepSeek Harness。

- `N` = **正在运行**的会话数：这一轮还没结束，工作区列表里正在转圈的那些；
  因为问题/审批停在那里等你的会话也算——它的 turn 同样没结束。
- **已归档的会话不参与统计**（不在侧栏里，就不该占着数字）。
- `M` = **需要你处理**的会话数：绿色点（跑完了）和橙色点（等你回答）。
  点进去看过就清掉，不会再回来，除非它又跑完了新一轮。
- 子代理会话（`header.origin === 'subagent'` 或带 `header.parentSession`）不计入。
- 刚打开、一句话都没说的空会话既不算运行也不算完成。

所以一个会话可能同时出现在两个数字里：卡在提问上的会话既是「turn 没结束」（N），
也是「等你处理」（M）。这和列表里那两个标记是一一对应的。

## 右键菜单：直接告诉你「是哪个」

什么都没有的时候只留一个鲸鱼图标，不带 `0/0`（`emptyStyle: icon`，默认）。

图标右键会列出当前计入 M 的会话，最多 5 条，点一条就激活 App：

```
运行中 1 个 · 完成或待答复 2 个
────────────────────
🟢 已完成 · 24 分钟前 · 阅读页高亮与 Pin 播放页优化
🟠 待答复 · 3 分钟前 · 迁移脚本要不要保留旧表
… 还有 2 个
────────────────────
显示 DeepSeek Harness
退出菜单栏图标
```

绿 = 跑完了没看，橙 = 卡在提问/审批。

## 已读语义

M 不是「历史上完成过多少」，而是「现在有几件需要你看」：

- 会话视图一挂载就以 1 像素探针的形式向 Host 报到，Host 立刻把它标记为已读；
- 标记是**粘性**的：切走以后不会重新冒出来，除非这个会话又结束了一轮；
- 你正看着的那个会话跑完时不会计入 M（你已经在看着它完成了）；
- 后台标签页不算「看着」：`IntersectionObserver` 判定元素是否真的在屏幕上，
  再加 `document.hasFocus()` 判定窗口是否是当前窗口。

## 为什么需要一个原生小助手

插件跑在 DSH 的 Host Node 子进程里（Desktop 用 `spawn` 拉起 `@deepseek-ai/dsh-desktop-host`），
**没有 AppKit**；而 Desktop 自带的 `Tray` 只在 `process.platform === 'win32'` 时创建。
「macOS 菜单栏画个图标」这一步纯插件拿不到，必须由原生进程做。

```
Client (client.js)                     Host 插件 (index.js)              原生助手 (bin/dsh-menubar)
  探针报到「谁在屏幕上」──HTTP──▶  viewing / seenAt  ──stdin JSON 行──▶  NSStatusItem「鲸鱼 + N/M」
                                  折 session/event                            │
                                               左键 ──▶ 激活 DeepSeek Harness（右键出菜单）
```

要点：

- **不是 .app，也不需要 dmg / 签名 / 公证**。裸 Mach-O 可执行文件 + `setActivationPolicy(.accessory)` 就能拥有 `NSStatusItem`，且不进程序坞。
- 图标是 **template image**（只有 alpha），系统自动适配浅色/深色菜单栏；数字用 `NSFont.menuBarFont`，和右上角时钟的字号字重一致；鲸鱼由 `src/make-glyph.py` 从 App 自带图标抠出。
- 助手进程的生命周期由 stdin 决定：插件卸载或 Host 退出 → stdin EOF → 图标自己消失，**不会留下数字不动的僵尸图标**。
- 单实例：助手启动时读 `$TMPDIR/dsh-menubar.lock`，结束上一个还活着的实例，所以热重载不会叠出两个鲸鱼。
- 重载安全：路由注册挂在进程上、实例只换 handler（`Symbol.for('dsh.menubar-status.viewing-route')`），并且用 generation 计数保证只有最新实例写图标；否则 Cordis「先建新实例、后销毁旧实例」会让 `duplicate exact route` 把整个插件打挂。

## 归档如何排除

`workspaceRegistry` 没有公开「读归档集合」的接口，所以：

- 启动基线：用 `sessionController.list()`（侧栏那份可见列表）取可见会话集合，活会话里不在其中的直接排除；
- 运行期：订阅 `workspace/session-archived` / `workspace/session-unarchiving` / `api-session/added` 增量维护，
  归档即排除、取消归档即恢复。

## 统计窗口

Desktop 的 Host 能连开几天，所以「本进程内」不是有用的范围。范围是**最近活跃工作集**：

| 状态 | 条件 |
| --- | --- |
| 运行中 `N` | turn 未结束，且最近 `staleRunningMinutes`（默认 60）内还有事件 |
| 待答复 | turn 未结束 + 挂着 `ask_user_question` / `propose_action`（同时计入 N 和 M） |
| 已完成 `M` | turn 已结束，结束时间在 `activeWindowMinutes`（默认 120）内，且此后没被看过 |
| 不计入 | 其余会话（含上次退出留下的半截 turn，它会随窗口自然衰减） |

## 构建

只有第一次需要，产物已提交在 `bin/dsh-menubar`：

```bash
./build.sh                  # swiftc -O，约 2~3 秒，需要 Xcode Command Line Tools
python3 src/make-glyph.py   # 可选：从 App 图标重新生成菜单栏鲸鱼 PNG（需要 Pillow）
```

## 安装

```bash
dsh plugin --profile desktop add link:$PWD
```

然后把 `@local/dsh-menubar-status` 加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`。

## 配置

改 `cordis.patch.yml` 里 `menubar-status` 行的 `config`，保存后会重新加载这一行。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时不注册监听也不拉起助手 |
| `bundleId` | `com.deepseek.dsh` | 点击图标要激活的应用 |
| `iconPath` | `''` | 自定义菜单栏图标；留空用 `assets/menubar.png` |
| `emptyStyle` | `'icon'` | 什么都没有时的样子：`icon` 只留鲸鱼、`count` 显示 `0/0`、`hidden` 整个隐藏 |
| `activeWindowMinutes` | `120` | 会话在活跃工作集里保留多久 |
| `staleRunningMinutes` | `60` | 多久没有新事件就不再算运行中（滤掉上次留下的半截 turn） |
| `debug` | `false` | 把每个会话的折叠状态 dump 到 `$DSH_PROFILE_DIR/.menubar-status-debug.json` |

## 已知限制

- 只统计**当前 Host 里活着的会话**；完全没被本进程加载过的历史会话不参与计数。
- 「已读」只记在内存里：重启 App 之后，窗口内已完成的会话会重新算一次未读。
- 同时开两个 DSH 实例时，单实例锁会让后启动的胜出，最终只有一个图标。
- 归档排除的启动基线依赖 `sessionController.list()` 的「可见」语义；若某版本把它改成含归档会话，会退回成「只在运行期排除」。
- 属于非官方扩展点：依赖 `session/event` 事件流、`ctx.subprocess`、`webServer.register` 与 `conversation.input.overlay` 这个座位，DSH 大版本升级后需要复验。
- 只有 macOS 实现；Windows 上 Desktop 本身就有托盘，这个插件没有意义。
