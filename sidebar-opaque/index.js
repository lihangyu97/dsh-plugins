/**
 * Host half of `sidebar-opaque`.
 *
 * The whole capability is a browser-side stylesheet: the macOS shell paints the
 * left column with a translucent gradient over the window's vibrancy material,
 * and the Client half repaints that column with the conversation surface token.
 * The Host registers nothing, so this module only anchors the bundle row.
 */
export function apply() {}
