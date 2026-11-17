# Chat 网页版 · dsh-chat-web

给 DeepSeek Harness 的 Web UI 加一个**左侧栏入口**，点开后主面板里用内嵌浏览器打开聊天网页版
（内置 DeepSeek），右上角可以在多个站点之间切换，也可以自己添加网址。

## 用法

- 左侧栏点「Chat 网页版」→ 主面板打开当前站点。
- 工具条右侧是按站点排列的**切换按钮**（当前站点高亮），点一下即切换；内置 DeepSeek 不可删除，
  自定义站点按钮右侧有 `×` 可删。
- 同一排的「＋ 添加网站」在工具条内展开成两个输入框（名称 / 网址），回车或点「添加」即写入
  localStorage（键 `dsh.chat-web.sites.v1`），Esc 或「取消」收起；另有「刷新」和「在浏览器打开」。

切换按钮刻意做成工具条内的普通按钮，而不是下拉菜单/浮层：内嵌页是独立的合成层，
任何盖在内容区上方的浮层都会干扰它。

## 两个关键设计

**1. 页面跟随面板挂载（不保活）**

`<webview>` 直接挂在面板的 stage 里：离开面板就关掉 guest，回来重新打开当前站点。
曾经的「保活」实现（把 guest 放进页面级 fixed 容器、面板只同步矩形）在实机上会导致内嵌页被
反复停止/重载，所以放弃了；代价是切走再回来页面状态不保留。

**2. 一个 guest 服务所有站点**

切换站点是让同一个 guest `loadURL`，而不是每个站点开一个 renderer——N 个站点仍然只占一份内存。
代价是：切站点等于换页，**前一个站点的页面状态不保留**（登录态和 localStorage 按域名各自保留）。

## 内嵌凭什么能成

这些聊天站点都带 `content-security-policy: frame-ancestors 'none'`，iframe 必然白屏，
所以走桌面外壳的 webview 租约：

1. `dshDesktop.browser.acquire('plugin:chat-web')` → `{ lease, partition }`
2. 用 `about:blank#<lease>` + 同 `partition` 创建 `<webview>`，主进程 `will-attach-webview` 校验后放行
3. `dom-ready` 后 `loadURL(站点地址)`；guest 一直复用，直到插件卸载或页面重载
4. 卸载插件时 `release(lease)` 关闭 guest

纯浏览器（非桌面端）没有 webview，也无法绕过 `frame-ancestors`，面板会说明原因并给
「在浏览器中打开」按钮。

## 已知边界

- **只在桌面端（Electron 外壳）内嵌**；`http://127.0.0.1:<port>` 的浏览器访问是降级提示。
- **登录状态只在本次 App 运行期间保留**：外壳给内嵌页的存储分区是内存态的
  （`dsh-sidebar-browser-<uuid>`，没有 `persist:` 前缀），重启应用后要重新登录。这是外壳策略，
  插件改不了；内置的右侧栏浏览器同样如此。
- 外壳固定了内嵌页权限：下载、弹窗、摄像头/麦克风/定位一律拒绝，`alert`/`confirm` 被禁用。
- 内嵌页的主题由站点自己决定，不跟随 DSH 深浅色；工具条和菜单用的是 `--dsw-alias-*` token，会跟随。
- 站点列表存在页面 localStorage（`dsh-app://app` origin），自定义站点最多 24 个。

## 安装 / 卸载

```text
plugin_manager install_bundle  /Users/lihangyu/.dsh/my-plugins/chat-web
plugin_manager remove_bundle   @local/dsh-chat-web
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | bundle patch，插入一行 `chat-web` |
| `index.js` | Host 半：空的 `apply()`，只作 bundle 锚点 |
| `client.js` | 全部界面：两个 slot 注册、guest 保活与定位、站点切换器、自定义站点、样式 |
| `locale/zh.json`、`locale/en.json` | 插件管理页的标题 / 描述 |
| `icon.svg` | 插件列表图标（自绘） |

加内置站点：改 `client.js` 里的 `PRESET_SITES`（`{ name, url, preset: true }`），
内置站点在菜单里不可删除。加自定义站点不需要改代码，右上角直接加。
