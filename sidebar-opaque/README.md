# 左侧栏不透明 · dsh-sidebar-opaque

把 DeepSeek Harness **macOS 客户端左侧栏**的透明毛玻璃效果去掉：左栏不再透出窗口背后的
桌面/壁纸，而是铺上和对话区完全一致的背景色。**深色、浅色主题都生效**（直接读主题 token，
没有硬编码颜色），切换主题时不需要重载。

## 效果

| | 原样 | 装插件后 |
| --- | --- | --- |
| 深色 | 左栏 = 半透明渐变 + 窗口 vibrancy，比对话区亮/偏色 | 左栏 = 对话区同色 `--dsw-alias-bg-base` |
| 浅色 | 左栏 = 半透明渐变 + 窗口 vibrancy | 左栏 = 对话区同色 `--dsw-alias-bg-base` |
| 左栏与对话区之间的分隔线 | 0.5px `--dsw-alias-border-l3` | 保留同样粗细/颜色的竖线（和「对话 / 轨迹」tab 下面那条横线同款） |

只在左栏是「常驻列」时生效；窗口很窄时左栏会变成浮层抽屉（drawer），抽屉保留原来的浮层
外观，方便和遮罩区分层次。

## 原理

问题不在左栏内容本身，而在外壳的两层 CSS：

1. `ui-layout` 在 darwin 上给 `sidebarCol` 铺的是

   ```css
   background: linear-gradient(...),
     color-mix(in srgb, color-mix(in srgb, var(--dsw-specific-sidebar-fill) 97%, #7a9bf0) 40%, transparent);
   ```

   复合后 alpha < 1，于是透出窗口 vibrancy。
2. `ui-sidebar` 的 `SidebarRoot` 在 darwin 上又把自己的背景清成 `background: 0 0`，
   所以最终看到的就是那层半透明渐变。

插件只注入一张 stylesheet，把左栏背景改成 `var(--dsw-alias-bg-base)`——这正是对话区
`centerCol` 用的 token；同时给 `centerCol` 补回一条 `border-left: .5px solid
var(--dsw-alias-border-l3)`，和对话区标题栏（「对话 / 轨迹」tab 那一行）的 `border-bottom`
用的是同一个 token，所以两条线在深浅色下都一致。选择器用 CSS Module 的 local-name 后缀
（`_sidebarCol` / `_centerCol`），不依赖构建 hash 前缀，外壳重新构建后仍能命中。

竖线只在左栏展开为常驻列时出现：左栏收起（宽 0）或窗口过窄变成抽屉（drawer）时，沿用外壳
原来的边缘处理，不会在窗口左边缘多出一条线。

## 文件

- `client.js` — 全部逻辑：注入并托管那张 stylesheet（`ctx.effect` 负责卸载时清理）
- `index.js` — Host 端空壳，只作为 bundle 锚点
- `cordis.patch.yml` — 插入 `sidebar-opaque` 这一行
- `locale/{zh,en}.json` — 插件市场/设置里显示的标题与描述
- `icon.svg` — 插件图标

## 安装 / 卸载

```text
plugin_manager install_bundle  target=/Users/lihangyu/.dsh/my-plugins/sidebar-opaque
```

不想要了就在「设置 → 插件」里禁用或移除这个 bundle；`client.js` 卸载时会移除 style 标签，
左栏立刻恢复原样，不需要重启。
