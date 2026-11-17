/**
 * Client half of `turn-notify`.
 *
 * The page owns the notification whenever it is open: the browser Notification
 * API renders it under DeepSeek Harness itself (no helper app, nothing new in
 * the Dock), and the click selects the Session that finished. It proves liveness
 * to the Host half with a heartbeat, so the Host only stops posting on its own
 * while this half is actually able to show notifications.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-turn-notify',
  factory(require) {
    /** Relative routes resolve against the page's own mount, like other client bundles. */
    const HELLO_ROUTE = 'turn-notify/hello';
    const DRAIN_ROUTE = 'turn-notify/drain';
    const HEARTBEAT_MS = 15000;

    /** POST JSON and parse the JSON reply; throws on any non-OK answer. */
    async function post(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return await response.json();
    }

    /** Current notification permission, never throwing on an exotic embedder. */
    function permission() {
      try {
        return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
      } catch {
        return 'unsupported';
      }
    }

    /** The Client timer service when present, else the page's own interval. */
    function startInterval(ctx, run, ms) {
      const timer = ctx.get?.('timer');
      if (typeof timer?.interval === 'function') return timer.interval(run, ms);
      const id = setInterval(run, ms);
      return () => clearInterval(id);
    }

    function apply(ctx) {
      let canNotify = permission() === 'granted';
      let disposed = false;

      async function beat() {
        if (disposed) return;
        try {
          await post(HELLO_ROUTE, { canNotify });
        } catch {
          // A failed beat simply ages out; the Host falls back to its own notifier.
        }
      }

      /** Show one payload and wire its click to the finished Session. */
      function show(item) {
        let notification;
        try {
          notification = new Notification(item.topic || item.title || 'DeepSeek Harness', {
            body: item.body,
            tag: item.sessionId,
          });
        } catch {
          canNotify = false;
          void beat();
          return;
        }
        notification.onclick = () => {
          try {
            window.focus();
          } catch {
            // Focus is best-effort; selecting the Session is the real action.
          }
          try {
            ctx.get?.('uiWorkspace')?.openSession?.(item.sessionId);
          } catch {
            // A Session that no longer exists must not throw inside the click handler.
          }
          notification.close();
        };
      }

      async function drain() {
        let payload;
        try {
          payload = await post(DRAIN_ROUTE, {});
        } catch {
          return;
        }
        for (const item of payload?.items ?? []) show(item);
      }

      const offStatus = ctx.remote.$on('api-session/status', (_sessionId, running) => {
        if (running !== true) void drain();
      });
      const stopBeat = startInterval(ctx, () => void beat(), HEARTBEAT_MS);

      // First beat advertises this page; the first drain collects anything the
      // Host queued while the page was still booting.
      void (async () => {
        if (permission() === 'default') {
          try {
            canNotify = (await Notification.requestPermission()) === 'granted';
          } catch {
            canNotify = false;
          }
        } else {
          canNotify = permission() === 'granted';
        }
        await beat();
        await drain();
      })();

      return () => {
        disposed = true;
        offStatus?.();
        stopBeat?.();
      };
    }

    return { inject: ['remote'], apply };
  },
});
