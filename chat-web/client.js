/**
 * Client half of `chat-web`.
 *
 * A left-sidebar entry (`sidebar.panellist`) addresses a `main` panel that hosts
 * a chat site. The panel embeds the page in the desktop shell's `<webview>`
 * guest, because sites such as DeepSeek refuse framing
 * (`content-security-policy: frame-ancestors 'none'`) and an iframe would stay
 * blank.
 *
 * Two behaviours worth knowing before editing:
 *
 * 1. The guest is mounted, not kept. A `<webview>` is a child of the panel's
 *    stage, so leaving the panel closes its Chromium guest and coming back opens
 *    the active site again. Keeping one alive off-screen was tried and dropped:
 *    a fixed host overlapping the app page produced constant reloads.
 * 2. One guest serves every site. Switching sites navigates that guest instead
 *    of opening a second renderer, so N sites still cost one page's memory.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-chat-web',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace of every visible string in this plugin. */
    const NS = 'chatWeb';
    /** Sidebar list id; it must be shared by both registrations. */
    const PANEL_ID = 'chat-web';
    /** Storage keys of the site list and the last active site. */
    const SITES_KEY = 'dsh.chat-web.sites.v1';
    const ACTIVE_KEY = 'dsh.chat-web.active.v1';
    /** Storage identity of the guest partition, stable across panel remounts. */
    const GUEST_WORKSPACE = 'plugin:chat-web';
    /** Guard rails for user-entered sites. */
    const MAX_CUSTOM_SITES = 24;
    const NAME_LIMIT = 40;
    const URL_LIMIT = 2048;

    /** Sites that ship with the plugin; a preset cannot be removed. */
    const PRESET_SITES = [
      { name: 'DeepSeek', url: 'https://chat.deepseek.com/', preset: true },
    ];

    const COPY = {
      zh: {
        'nav.label': 'Chat 网页版',
        'panel.title': 'Chat 网页版',
        'action.reload': '刷新',
        'action.external': '在浏览器打开',
        'action.switch': '切换网站',
        'menu.preset': '内置',
        'menu.remove': '删除这个网站',
        'menu.add': '添加网站',
        'add.name': '名称',
        'add.namePlaceholder': '例如 豆包',
        'add.url': '网址',
        'add.urlPlaceholder': 'https://www.doubao.com/chat/',
        'add.submit': '添加',
        'add.cancel': '取消',
        'add.invalid': '网址无效：只支持 http/https，且不能带用户名密码。',
        'add.limit': '自定义网站数量已达上限。',
        'state.loading': '正在打开…',
        'state.error': '网页加载失败',
        'state.retry': '重试',
        'unsupported.title': '当前环境无法内嵌网页',
        'unsupported.body':
          '这些聊天网站普遍禁止被 iframe 嵌入（frame-ancestors），内嵌浏览器只在 DSH 桌面端可用。你仍然可以在系统浏览器中打开。',
        'unsupported.open': '在浏览器中打开',
      },
      en: {
        'nav.label': 'Chat Web',
        'panel.title': 'Chat Web',
        'action.reload': 'Reload',
        'action.external': 'Open in browser',
        'action.switch': 'Switch site',
        'menu.preset': 'Built-in',
        'menu.remove': 'Remove this site',
        'menu.add': 'Add site',
        'add.name': 'Name',
        'add.namePlaceholder': 'e.g. Doubao',
        'add.url': 'Address',
        'add.urlPlaceholder': 'https://www.doubao.com/chat/',
        'add.submit': 'Add',
        'add.cancel': 'Cancel',
        'add.invalid': 'Invalid address: only http/https, without a username or password.',
        'add.limit': 'The custom site limit is reached.',
        'state.loading': 'Opening…',
        'state.error': 'The page failed to load',
        'state.retry': 'Retry',
        'unsupported.title': 'This environment cannot embed web pages',
        'unsupported.body':
          'Chat sites generally refuse to be framed (frame-ancestors), so the embedded browser only works in the DSH desktop app. You can still open the page in your system browser.',
        'unsupported.open': 'Open in browser',
      },
    };

    const CSS = `
.dswb-root {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  flex: auto;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}
.dswb-toolbar {
  box-sizing: border-box;
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.dswb-title { font-size: 13px; font-weight: 600; line-height: 18px; white-space: nowrap; }
.dswb-subtitle {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dswb-spacer { flex: auto; }
.dswb-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
}
.dswb-button:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dswb-stage {
  flex: auto;
  min-height: 0;
  display: flex;
}
.dswb-content {
  flex: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.dswb-view {
  flex: auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  display: flex;
  background: var(--dsw-alias-bg-base);
}
.dswb-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 20px;
}
.dswb-card { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 420px; }
.dswb-card-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dswb-hint { margin: 0; color: var(--dsw-alias-label-secondary); }
.dswb-detail { margin: 0; font-size: 11.5px; color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.dswb-actions { display: flex; align-items: center; gap: 8px; }
.dswb-primary {
  height: 30px;
  padding: 0 14px;
  box-sizing: border-box;
  border: 0;
  border-radius: 7px;
  background: var(--dsw-alias-brand-primary);
  color: #ffffff;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.dswb-spinner {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: dswb-spin 0.8s linear infinite;
}
@keyframes dswb-spin { to { transform: rotate(360deg); } }
.dswb-switcher {
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  scrollbar-width: none;
}
.dswb-switcher::-webkit-scrollbar { display: none; }
.dswb-choice {
  flex: none;
  height: 26px;
  padding: 0 10px;
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
}
.dswb-choice[data-active='true'] {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.dswb-choice-remove {
  flex: none;
  height: 26px;
  width: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font: inherit;
  font-size: 13px;
  line-height: 26px;
  text-align: center;
  cursor: pointer;
}
.dswb-choice-remove:hover { color: var(--dsw-alias-state-error-primary); }
.dswb-add {
  flex: none;
  height: 26px;
  padding: 0 10px;
  box-sizing: border-box;
  border: 0.5px dashed var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dswb-add:hover { color: var(--dsw-alias-label-primary); }
.dswb-form {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dswb-input {
  box-sizing: border-box;
  height: 26px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
}
.dswb-input-name { width: 90px; }
.dswb-input-url { width: 220px; }
.dswb-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dswb-form-error {
  flex: none;
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-error-primary);
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) { .dswb-spinner { animation-duration: 2.4s; } }
`;

    /** Insert the plugin stylesheet, preferring the package-owned style service. */
    function insertStyles(css) {
      if (typeof styles !== 'undefined' && styles !== null && typeof styles.insert === 'function') {
        return styles.insert(css);
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/dsh-chat-web';
      tag.textContent = css;
      document.head.append(tag);
      return () => tag.remove();
    }

    /** Open an address outside the app: a tab in a browser, the system browser on desktop. */
    function openOutside(url) {
      try {
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch {
        // A blocked popup must not throw inside a click handler.
      }
    }

    /** The desktop guest transport, or undefined when this page has no Electron carrier. */
    function browserBridge() {
      const carrier = globalThis.dshDesktop;
      if (carrier === undefined || carrier === null) return undefined;
      if (carrier.protocolVersion !== 1) return undefined;
      if (carrier.browser === undefined || carrier.browser === null) return undefined;
      return carrier.browser;
    }

    /** Accept an http(s) address, adding https:// when the scheme is missing. */
    function normalizeUrl(input) {
      const raw = String(input === undefined || input === null ? '' : input).trim();
      if (raw === '' || raw.length > URL_LIMIT) return null;
      const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
      let url;
      try {
        url = new URL(candidate);
      } catch {
        return null;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (url.username !== '' || url.password !== '') return null;
      return url.href;
    }

    function hostOf(url) {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    }

    function readJson(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? undefined : JSON.parse(raw);
      } catch {
        return undefined;
      }
    }

    function writeJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Storage can be unavailable or full; the session still works in memory.
      }
    }

    /** Preset sites followed by the user's own, dropping anything malformed. */
    function readSites() {
      const stored = readJson(SITES_KEY);
      const custom = [];
      if (Array.isArray(stored)) {
        for (const item of stored) {
          if (item === null || typeof item !== 'object') continue;
          const url = normalizeUrl(item.url);
          if (url === null) continue;
          const name =
            typeof item.name === 'string' && item.name.trim() !== ''
              ? item.name.trim().slice(0, NAME_LIMIT)
              : hostOf(url);
          if (custom.some((site) => site.url === url)) continue;
          custom.push({ name, url, preset: false });
        }
      }
      return [...PRESET_SITES, ...custom.slice(0, MAX_CUSTOM_SITES)];
    }

    function writeCustomSites(sites) {
      writeJson(
        SITES_KEY,
        sites.filter((site) => !site.preset).map((site) => ({ name: site.name, url: site.url }))
      );
    }

    function readActiveUrl(sites) {
      const stored = readJson(ACTIVE_KEY);
      if (typeof stored === 'string' && sites.some((site) => site.url === stored)) return stored;
      return sites[0].url;
    }

    /**
     * Site list, active site, and the guest of the current panel mount.
     *
     * The guest lives exactly as long as the panel is mounted: it is a child of
     * the panel's own stage, so leaving the panel closes it and coming back opens
     * the active site again. Sites and status outlive the panel in this runtime,
     * which is owned by the plugin activation.
     */
    function createRuntime() {
      let sites = readSites();
      let activeUrl = readActiveUrl(sites);
      let status = 'idle';
      let detail = '';
      let snapshot = null;
      const listeners = new Set();

      let stage = null;
      let view = null;
      let bridge = null;
      let lease = null;
      let ready = false;
      let creating = null;
      let offOpen = null;

      const activeSite = () => sites.find((site) => site.url === activeUrl) ?? sites[0];

      function publish() {
        snapshot = {
          sites,
          activeUrl,
          site: activeSite(),
          status,
          detail,
          host: hostOf(activeUrl),
        };
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // A subscriber that throws must not break the others.
          }
        }
      }

      function setStatus(next, nextDetail) {
        status = next;
        detail = nextDetail === undefined ? '' : nextDetail;
        publish();
      }

      function setActive(next) {
        if (activeUrl === next) return;
        activeUrl = next;
        writeJson(ACTIVE_KEY, next);
        publish();
      }

      /** Mount the panel's stage; the guest is created into it. */
      function attach(element) {
        if (stage === element) return;
        if (stage !== null) detach();
        stage = element;
      }

      /** Unmount the stage and close its guest: leaving the panel ends the page. */
      function detach() {
        if (stage === null) return;
        stage = null;
        dropGuest();
        setStatus('idle');
      }

      function failure(error) {
        const text = error instanceof Error ? error.message : String(error);
        setStatus('error', text);
      }

      function load(url) {
        if (view === null) return;
        setStatus('loading');
        const current = view;
        current.loadURL(url).catch((error) => {
          if (view !== current) return;
          failure(error);
        });
      }

      function dropGuest() {
        const current = view;
        view = null;
        ready = false;
        if (offOpen !== null) {
          offOpen();
          offOpen = null;
        }
        if (current !== null) current.remove();
        const id = lease;
        lease = null;
        if (id !== null && bridge !== undefined && bridge !== null) {
          void bridge.release(id).catch(() => {});
        }
      }

      /**
       * Create this mount's guest into the stage and open the active site.
       * @param force - true recreates a guest whose creation was refused, such
       * as one left unreserved after a failed attach; a healthy guest is kept.
       */
      function ensureGuest(force) {
        if (stage === null) return Promise.resolve();
        if (view !== null) {
          if (force !== true) return creating ?? Promise.resolve();
          dropGuest();
        }
        if (creating !== null) return creating;
        bridge = bridge ?? browserBridge();
        if (bridge === undefined) {
          setStatus('unsupported');
          return Promise.resolve();
        }
        creating = (async () => {
          setStatus('loading');
          let reservation;
          try {
            reservation = await bridge.acquire(GUEST_WORKSPACE);
          } catch (error) {
            failure(error);
            return;
          }
          // The panel may have been left while acquire() was in flight.
          if (stage === null) {
            void bridge.release(reservation.lease).catch(() => {});
            return;
          }
          lease = reservation.lease;
          const element = document.createElement('webview');
          if (typeof element.loadURL !== 'function') {
            dropGuest();
            setStatus('unsupported');
            return;
          }
          view = element;
          element.className = 'dswb-view';
          element.setAttribute('name', lease);
          element.setAttribute('partition', reservation.partition);
          element.setAttribute('allowpopups', '');
          element.setAttribute('src', `about:blank#${lease}`);

          element.addEventListener('dom-ready', () => {
            if (view !== element) return;
            ready = true;
            load(activeUrl);
          });
          let committed = false;
          element.addEventListener('did-stop-loading', () => {
            if (view !== element || !ready) return;
            // Only a completed document counts as ready. A document that never
            // commits (aborted or failed navigation) fires this without a commit,
            // and leaving it as 'ready' would hide the failure behind an empty page.
            if (committed) {
              setStatus('ready');
              return;
            }
            failure(new Error(element.getURL()));
          });
          element.addEventListener('did-fail-load', (event) => {
            if (view !== element || !event.isMainFrame) return;
            if (event.errorCode === -3) return; // the caller replaced this navigation
            failure(new Error(`${event.errorDescription || 'load failed'} (${event.errorCode})`));
          });
          // A committed main frame is what makes the next stop a real page.
          element.addEventListener('did-navigate', () => {
            committed = true;
          });
          element.addEventListener('did-navigate-in-page', () => {
            committed = true;
          });
          element.addEventListener('render-process-gone', () => {
            if (view !== element) return;
            dropGuest();
            failure(new Error('the embedded browser process exited'));
          });

          offOpen = bridge.onOpenRequested(lease, (url) => openOutside(url));
          stage.append(element);
        })()
          .catch((error) => failure(error))
          .finally(() => {
            creating = null;
          });
        return creating;
      }

      function selectSite(url) {
        const site = sites.find((item) => item.url === url);
        if (site === undefined) return;
        const changed = activeUrl !== url;
        setActive(url);
        // An errored guest starts over: guest creation itself can be what failed.
        if (view === null || status === 'error' || status === 'unsupported') {
          void ensureGuest(view !== null);
          return;
        }
        if (!changed && status === 'ready') return;
        if (!ready) return; // dom-ready opens the current address
        load(url);
      }

      function addSite(name, rawUrl) {
        const url = normalizeUrl(rawUrl);
        if (url === null) return { ok: false, reason: 'invalid' };
        const trimmed = typeof name === 'string' ? name.trim().slice(0, NAME_LIMIT) : '';
        if (sites.some((site) => site.url === url)) {
          selectSite(url);
          return { ok: true, existing: true };
        }
        if (sites.filter((site) => !site.preset).length >= MAX_CUSTOM_SITES) {
          return { ok: false, reason: 'limit' };
        }
        sites = [...sites, { name: trimmed === '' ? hostOf(url) : trimmed, url, preset: false }];
        writeCustomSites(sites);
        publish();
        selectSite(url);
        return { ok: true };
      }

      function removeSite(url) {
        const site = sites.find((item) => item.url === url);
        if (site === undefined || site.preset) return;
        sites = sites.filter((item) => item.url !== url);
        writeCustomSites(sites);
        publish();
        if (activeUrl === url) selectSite(sites[0].url);
      }

      function reload() {
        if (view !== null && ready) {
          try {
            setStatus('loading');
            view.reload();
            return;
          } catch {
            // Fall through and recreate the guest.
          }
        }
        // A retry always starts with a fresh guest: a rejected attach leaves the
        // old element unusable, and its lease was already released.
        dropGuest();
        void ensureGuest(true);
      }

      function dispose() {
        stage = null;
        view = null;
        dropGuest();
        listeners.clear();
      }

      publish();
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        attach,
        detach,
        ensureGuest,
        selectSite,
        addSite,
        removeSite,
        reload,
        dispose,
      };
    }

    /** Sidebar glyph: a browser window, drawn in the host's label color. */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', {
          x: 1.9,
          y: 3.6,
          width: 16.2,
          height: 12.8,
          rx: 2.6,
          stroke: 'currentColor',
          strokeWidth: 1.4,
        }),
        h('path', {
          d: 'M2 7.3h16',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          opacity: 0.85,
        }),
        h('circle', { cx: 4.9, cy: 5.45, r: 0.72, fill: 'currentColor' }),
        h('circle', { cx: 7.16, cy: 5.45, r: 0.72, fill: 'currentColor' }),
        h('path', {
          d: 'M6.4 12.9h7.2',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          opacity: 0.9,
        })
      );
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      const runtime = createRuntime();

      ctx.effect(() => ctx.locale.register(NS, 'zh', COPY.zh), 'chat-web:locale-zh');
      ctx.effect(() => ctx.locale.register(NS, 'en', COPY.en), 'chat-web:locale-en');
      ctx.effect(() => insertStyles(CSS), 'chat-web:styles');
      ctx.effect(() => () => runtime.dispose(), 'chat-web:guest');

      /** Follow the active locale so a language switch repaints the panel copy. */
      function useLocaleRevision() {
        const [, bump] = React.useState(0);
        React.useEffect(() => ctx.locale.subscribe(() => bump((value) => value + 1)), []);
      }

      function useRuntime() {
        const [snap, setSnap] = React.useState(runtime.getSnapshot());
        React.useEffect(() => runtime.subscribe(() => setSnap(runtime.getSnapshot())), []);
        return snap;
      }

      function Panel() {
        useLocaleRevision();
        const snap = useRuntime();
        const [adding, setAdding] = React.useState(false);
        const [draftName, setDraftName] = React.useState('');
        const [draftUrl, setDraftUrl] = React.useState('');
        const [formError, setFormError] = React.useState('');
        const stageRef = React.useRef(null);

        React.useEffect(() => {
          const stage = stageRef.current;
          if (stage !== null) runtime.attach(stage);
          void runtime.ensureGuest();
          return () => runtime.detach();
        }, []);

        const submitSite = () => {
          const result = runtime.addSite(draftName, draftUrl);
          if (result.ok) {
            setDraftName('');
            setDraftUrl('');
            setFormError('');
            setAdding(false);
            return;
          }
          setFormError(result.reason === 'limit' ? t('add.limit') : t('add.invalid'));
        };

        // One button per site, inline in the toolbar. A portal, dropdown, or
        // overlay would cover the stage, and the guest is a separate compositing
        // layer that reacts badly to anything overlapping it.
        const switcher = h(
          'div',
          { className: 'dswb-switcher', role: 'group', 'aria-label': t('action.switch') },
          ...snap.sites.map((item) =>
            h(
              'span',
              { key: item.url, style: { display: 'inline-flex', alignItems: 'center' } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dswb-choice',
                  'data-active': String(item.url === snap.activeUrl),
                  'aria-pressed': String(item.url === snap.activeUrl),
                  title: hostOf(item.url),
                  onClick: () => runtime.selectSite(item.url),
                },
                item.name
              ),
              item.preset
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dswb-choice-remove',
                      title: t('menu.remove'),
                      'aria-label': `${t('menu.remove')} ${item.name}`,
                      onClick: () => runtime.removeSite(item.url),
                    },
                    '×'
                  )
            )
          ),
          adding
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dswb-add',
                  onClick: () => {
                    setAdding(true);
                    setFormError('');
                  },
                },
                `＋ ${t('menu.add')}`
              )
        );

        const addForm = adding
          ? h(
              'div',
              { className: 'dswb-form' },
              h('input', {
                className: 'dswb-input dswb-input-name',
                value: draftName,
                placeholder: t('add.namePlaceholder'),
                'aria-label': t('add.name'),
                maxLength: NAME_LIMIT,
                onChange: (event) => setDraftName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submitSite();
                  if (event.key === 'Escape') setAdding(false);
                },
              }),
              h('input', {
                className: 'dswb-input dswb-input-url',
                value: draftUrl,
                placeholder: t('add.urlPlaceholder'),
                'aria-label': t('add.url'),
                maxLength: URL_LIMIT,
                spellCheck: false,
                onChange: (event) => {
                  setDraftUrl(event.target.value);
                  setFormError('');
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submitSite();
                  if (event.key === 'Escape') setAdding(false);
                },
              }),
              h(
                'button',
                { type: 'button', className: 'dswb-primary dswb-submit', onClick: submitSite },
                t('add.submit')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dswb-button',
                  onClick: () => {
                    setAdding(false);
                    setFormError('');
                  },
                },
                t('add.cancel')
              ),
              formError === '' ? null : h('p', { className: 'dswb-form-error' }, formError)
            )
          : null;

        const overlay =
          snap.status === 'unsupported'
            ? h(
                'div',
                { className: 'dswb-overlay' },
                h(
                  'div',
                  { className: 'dswb-card' },
                  h('div', { className: 'dswb-card-title' }, t('unsupported.title')),
                  h('p', { className: 'dswb-hint' }, t('unsupported.body')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dswb-primary',
                      onClick: () => openOutside(snap.activeUrl),
                    },
                    t('unsupported.open')
                  )
                )
              )
            : snap.status === 'error'
              ? h(
                  'div',
                  { className: 'dswb-overlay' },
                  h(
                    'div',
                    { className: 'dswb-card' },
                    h('div', { className: 'dswb-card-title' }, t('state.error')),
                    snap.detail === '' ? null : h('p', { className: 'dswb-detail' }, snap.detail),
                    h(
                      'div',
                      { className: 'dswb-actions' },
                      h(
                        'button',
                        { type: 'button', className: 'dswb-primary', onClick: () => runtime.reload() },
                        t('state.retry')
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dswb-button',
                          onClick: () => openOutside(snap.activeUrl),
                        },
                        t('action.external')
                      )
                    )
                  )
                )
              : snap.status === 'ready'
                ? null
                : h(
                    'div',
                    { className: 'dswb-overlay' },
                    h('div', { className: 'dswb-spinner' }),
                    h('div', null, `${t('state.loading')} ${snap.host}`)
                  );

        return h(
          'div',
          { className: 'dswb-root' },
          h(
            'div',
            { className: 'dswb-toolbar' },
            h('span', { className: 'dswb-title' }, t('panel.title')),
            h('span', { className: 'dswb-spacer' }),
            switcher,
            addForm,
            h(
              'button',
              { type: 'button', className: 'dswb-button', onClick: () => runtime.reload() },
              t('action.reload')
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dswb-button',
                onClick: () => openOutside(snap.activeUrl),
              },
              t('action.external')
            )
          ),
          h('div', { className: 'dswb-content' }, h('div', { className: 'dswb-stage', ref: stageRef }), overlay)
        );
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => t('nav.label'),
          },
          PanelIcon
        )
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          Panel
        )
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
