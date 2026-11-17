/**
 * Host half of `chat-web`.
 *
 * The capability is entirely browser-side: a `sidebar.panellist` entry that
 * addresses a `main` panel holding one long-lived webview guest, plus the site
 * switcher stored in the page's localStorage. The Host registers nothing, so
 * this module only anchors the bundle row.
 */
export function apply() {}
