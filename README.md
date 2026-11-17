# dsh-plugins

给 [DeepSeek Harness](https://github.com/deepseek-ai) 写的一些自用插件，都是 client 插件（`dsh.client.platform = web`），
装到 desktop / web profile 里生效。

| 插件 | 作用 | 版本 |
| --- | --- | --- |
| [`chat-web`](./chat-web) | 左侧栏入口 + 常驻内嵌浏览器，直接打开 DeepSeek 等聊天网页版，支持站点切换和自定义站点 | 2.0.0 |
| [`sidebar-opaque`](./sidebar-opaque) | 去掉 macOS 客户端左侧栏的透明毛玻璃，让左栏和对话区背景一致（深色/浅色都生效） | 1.1.0 |
| [`turn-notify`](./turn-notify) | 每轮回答结束后弹桌面系统通知（会话标题 + 回答摘要），点击通知跳回该会话 | 1.1.0 |

每个目录都是一个独立插件包（有自己的 `package.json`、`cordis.patch.yml`、`index.js` / `client.js`、`locale/`、`icon.svg`），
详细能力和实现说明见各目录下的 README。

## 安装

`dsh plugin` 会把参数转发给 profile 目录下的 pnpm，所以直接从本地克隆的路径 `link:` 进去即可（改完不用重装）：

```bash
git clone git@github.com:lihangyu97/dsh-plugins.git
cd dsh-plugins

# 以 desktop profile 为例
dsh plugin --profile desktop add link:$PWD/chat-web
dsh plugin --profile desktop add link:$PWD/sidebar-opaque
dsh plugin --profile desktop add link:$PWD/turn-notify
```

装完把对应的包名加进 profile 的 `dsh.profile.bundles` 里才会被加载，例如 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-turn-notify", "@local/dsh-sidebar-opaque"]
    }
  }
}
```

也可以直接用 `dsh plugin` 的启停命令管理，或用 `dsh plugin --profile <name> why <pkg>` 排查为什么没加载。

## 说明

- 包名统一是 `@local/dsh-*` 且 `private: true`，不打算发 npm，只通过 `link:` 使用。
- `turn-notify` 的桌面通知依赖 `notifier/` 里的构建脚本，首次使用需要按那个 README 跑一遍。
- 只在自己机器上验证过 macOS 客户端；Web/GUI 之外的表现没有专门测。
