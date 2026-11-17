/**
 * Client half of `sidebar-opaque`.
 *
 * The macOS shell gives the left column a translucent surface: `AppFrame`
 * paints it with `linear-gradient(...)` plus
 * `color-mix(in srgb, var(--dsw-specific-sidebar-fill) 40%, transparent)`, and
 * `SidebarRoot` explicitly clears its own background (`background: 0 0`) on
 * darwin, so the window's vibrancy material shows through the column. The
 * conversation column next to it paints `--dsw-alias-bg-base` opaquely.
 *
 * This module only installs one stylesheet: the column gets the same
 * `--dsw-alias-bg-base` surface, so light and dark themes read the token
 * instead of a hard-coded color, and the two columns stay separated by the
 * same `.5px var(--dsw-alias-border-l3)` divider the conversation tab strip
 * uses as its bottom edge.
 *
 * Selectors use the CSS-module local-name suffix (`_frame`, `_sidebarCol`,
 * `_centerCol`) rather than the build hash prefix, so a rebuild of the shell
 * keeps matching. They are scoped to the wide column; the narrow-window drawer
 * keeps the shipped floating-panel treatment.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-opaque',
  factory() {
    /** Marker of the plugin's single stylesheet, also used to drop stale copies. */
    const STYLE_ID = 'sidebar-opaque';

    const CSS = [
      '/* The macOS shell paints the left column over the window vibrancy',
      '   material; repaint it with the token the conversation column uses. */',
      'html[data-platform="darwin"] [class*="_frame"]:not([data-sidebar-drawer]) [class*="_sidebarCol"] {',
      '  background: var(--dsw-alias-bg-base) !important;',
      '}',
      '/* Keep the seam between the two columns, matching the rule under the',
      '   conversation tab strip: the same .5px --dsw-alias-border-l3 line.',
      '   Collapsed and drawer layouts hide or float the column, so they keep',
      '   the shipped edge treatment. */',
      'html[data-platform="darwin"] [class*="_frame"]:not([data-sidebar-drawer]):not([data-sidebar-collapsed]) [class*="_centerCol"] {',
      '  border-left: .5px solid var(--dsw-alias-border-l3) !important;',
      '}',
    ].join('\n');

    /** Insert the stylesheet and return the disposer that removes it. */
    function installStyle() {
      for (const stale of document.querySelectorAll(`style[data-dsh-plugin-style="${STYLE_ID}"]`)) {
        stale.remove();
      }
      const tag = document.createElement('style');
      tag.dataset.dshPluginStyle = STYLE_ID;
      tag.textContent = CSS;
      document.head.append(tag);
      return () => tag.remove();
    }

    return {
      apply(ctx) {
        ctx.effect(installStyle, 'sidebar-opaque:styles');
      },
    };
  },
});
