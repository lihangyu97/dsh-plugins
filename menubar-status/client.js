/**
 * Client half of `menubar-status`.
 *
 * The menu bar number has to know which Sessions the user is actually looking at:
 * opening a finished Session clears its attention mark, and a completion that
 * happens in the Session on screen is being watched, not unread.
 *
 * The page is the only place that knows this, so each conversation view mounts a
 * renderless 1×1 probe that reports its own Session id. Two filters keep "on
 * screen" honest:
 *
 * - an IntersectionObserver, because a background tab can stay mounted while the
 *   user looks at another one;
 * - `document.hasFocus()`, because a background window is not being looked at.
 *
 * The Host ages every report out on its own, so a page that closes, crashes, or
 * loses its turn never pins a Session as read.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-menubar-status',
  factory(require) {
    const React = require('react');

    /** Relative routes resolve against the page's own mount, like other bundles. */
    const VIEWING_ROUTE = 'menubar-status/viewing-v2';

    /** Re-send the set often enough that the Host's freshness window never lapses. */
    const HEARTBEAT_MS = 15000;

    function apply(ctx) {
      /** sessionId → number of live probes, so a remount cannot drop a real view. */
      const probes = new Map();
      /** sessionId → number of probes the browser actually reports as on screen. */
      const onScreen = new Map();
      let disposed = false;

      /** A report only counts while this window is the one being used. */
      function focused() {
        try {
          return document.visibilityState === 'visible' && document.hasFocus();
        } catch {
          return false;
        }
      }

      function bump(map, sessionId, delta) {
        const next = (map.get(sessionId) ?? 0) + delta;
        if (next > 0) map.set(sessionId, next);
        else map.delete(sessionId);
      }

      async function report() {
        if (disposed) return;
        const active = focused();
        const body = {
          viewing: active ? [...onScreen.keys()] : [],
          // Diagnostics only: the Host reads `viewing`.
          mounted: [...probes.keys()],
          focused: active,
        };
        try {
          await fetch(VIEWING_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch {
          // A dropped report simply ages out on the Host.
        }
      }

      /**
       * Renderless presence probe. It is 1×1 and transparent so it can be
       * observed, but it must not disturb the composer's layout.
       */
      function Probe(props) {
        const sessionId = props?.sessionId;
        const ref = React.useRef(null);

        React.useEffect(() => {
          if (typeof sessionId !== 'string' || sessionId === '') return undefined;
          const node = ref.current;
          bump(probes, sessionId, 1);

          let visible = false;
          const settle = (next) => {
            if (next === visible) return;
            visible = next;
            bump(onScreen, sessionId, next ? 1 : -1);
            void report();
          };

          let observer;
          if (node !== null && typeof IntersectionObserver === 'function') {
            try {
              observer = new IntersectionObserver((entries) => {
                settle(entries.some((entry) => entry.isIntersecting));
              }, { threshold: 0 });
              observer.observe(node);
            } catch {
              settle(true);
            }
          } else {
            settle(true);
          }

          void report();

          return () => {
            observer?.disconnect();
            settle(false);
            bump(probes, sessionId, -1);
            void report();
          };
        }, [sessionId]);

        return React.createElement('span', {
          ref,
          'aria-hidden': true,
          style: {
            display: 'block',
            position: 'absolute',
            width: '1px',
            height: '1px',
            opacity: 0,
            pointerEvents: 'none',
          },
        });
      }

      const offProbe = ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'menubar-status-viewing',
        order: 1000,
      }, Probe));

      const onChange = () => void report();
      window.addEventListener('focus', onChange);
      window.addEventListener('blur', onChange);
      document.addEventListener('visibilitychange', onChange);
      window.addEventListener('resize', onChange);
      const heartbeat = setInterval(onChange, HEARTBEAT_MS);

      void report();

      return () => {
        disposed = true;
        offProbe?.();
        window.removeEventListener('focus', onChange);
        window.removeEventListener('blur', onChange);
        document.removeEventListener('visibilitychange', onChange);
        window.removeEventListener('resize', onChange);
        clearInterval(heartbeat);
      };
    }

    return { inject: ['slots'], apply };
  },
});
