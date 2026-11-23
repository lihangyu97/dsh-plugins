/**
 * `menubar-status` — a menu bar indicator for the sessions this Host is running.
 *
 * The menu bar item cannot come from a plugin directly: this plugin runs inside
 * the Host Node child process of the Desktop shell, which has no AppKit, and the
 * shell's own tray exists only on Windows. So the Host half folds session state
 * and streams it to a tiny native helper (a bare Swift executable, no bundle):
 *
 *   Host plugin ──stdin JSON lines──▶ dsh-menubar ──▶ NSStatusItem "N/M"
 *                                                        │
 *                                     click ── activate DeepSeek Harness
 *
 * The two numbers mirror the Workspace list's own marks:
 *
 * - `N` counts sessions whose turn has not ended — the spinner. A turn parked on
 *   the user (`ask_user_question` / `propose_action`) is still a turn in flight,
 *   so it counts here too.
 * - `M` counts the sessions that want something from the user: a green dot (turn
 *   finished) or an orange dot (parked on a decision), as long as it has not been
 *   looked at since. Opening the Session clears it, exactly like unread mail, and
 *   while a Session stays in the foreground its next completion never shows up at
 *   all — you are watching it happen.
 *
 * The "seen" signal comes from the Client half (`client.js`), which reports the
 * Session ids its conversation views are showing while the window is focused.
 * Delegated child sessions (`header.origin === 'subagent'`, or any
 * `header.parentSession`) never count.
 *
 * State is folded from the durable session append feed, never by polling a log,
 * and stdin EOF terminates the helper: when the Host stops, the icon goes with
 * it, so the menu bar can never show a stale number.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis function-plugin name. */
const name = 'menubar-status';

const packageDir = dirname(fileURLToPath(import.meta.url));
const helperPath = join(packageDir, 'bin', 'dsh-menubar');
const defaultIconPath = join(packageDir, 'assets', 'menubar.png');

/** The Client half posts which Sessions are on screen; nothing else calls it. */
const VIEWING_ROUTE = '/menubar-status/viewing-v2';

/**
 * The route registration outlives a plugin instance.
 *
 * A Cordis reload applies the new instance before it disposes the old one, so
 * registering the same exact path twice fails with "duplicate exact route" and
 * takes the whole plugin down. The registration therefore lives on the process
 * and only the handler behind it is swapped: the new instance installs its
 * closure, and the old instance's disposal cannot unregister a route it no
 * longer owns.
 */
const ROUTE_SLOT = Symbol.for('dsh.menubar-status.viewing-route');

/**
 * Only the newest activated instance may drive the icon.
 *
 * A reload can activate the replacement before the previous instance is
 * disposed, and a stalled disposal would otherwise leave two instances writing
 * two different numbers into one helper. The generation counter makes the
 * newest instance authoritative; older ones simply stop at their next flush.
 */
const GENERATION = Symbol.for('dsh.menubar-status.generation');

/** Coalesce bursts of session events into one helper update. */
const FLUSH_DELAY_MS = 150;

/** Re-evaluate on a timer too: the active windows move even without new events. */
const TICK_MS = 20_000;

/** A viewing report older than this no longer proves the Session is on screen. */
const VIEWING_FRESH_MS = 45_000;

/** Tool calls that park a turn on a human decision. */
const DECISION_TOOLS = new Set(['ask_user_question', 'propose_action']);

/** Effective defaults; also the fallback when no Config schema is available. */
const DEFAULTS = Object.freeze({
  enabled: true,
  bundleId: 'com.deepseek.dsh',
  iconPath: '',
  emptyStyle: 'icon',
  activeWindowMinutes: 120,
  staleRunningMinutes: 60,
  debug: false,
});

let z;
try {
  ({ default: z } = await import('@deepseek-ai/schemastery'));
} catch {
  // The schema is a convenience for the settings form; the row's raw `config`
  // is merged over DEFAULTS either way.
  z = undefined;
}

let Config;
try {
  Config = z?.object({
    enabled: z.boolean().default(DEFAULTS.enabled),
    bundleId: z.string().default(DEFAULTS.bundleId),
    iconPath: z.string().default(DEFAULTS.iconPath),
    emptyStyle: z.union(['icon', 'count', 'hidden']).default(DEFAULTS.emptyStyle),
    activeWindowMinutes: z.natural().min(5).max(10080).default(DEFAULTS.activeWindowMinutes),
    staleRunningMinutes: z.natural().min(5).max(10080).default(DEFAULTS.staleRunningMinutes),
    debug: z.boolean().default(DEFAULTS.debug),
  });
} catch {
  Config = undefined;
}

/** Whether this session is a delegated child rather than a user conversation. */
function isSubagent(session) {
  const header = session?.header;
  if (header === undefined || header === null) return false;
  return header.origin === 'subagent' || header.parentSession !== undefined;
}

/**
 * One session's folded state.
 *
 * `open` is the spinner. `pendingSince` and `lastTurnEndAt` are the two instants
 * that can ask for the user's attention; whichever is newest is the session's
 * "wants attention since". A Desktop Host can stay alive for days, so every
 * consumer of these timestamps also applies the active window — a turn that was
 * left open by a process that died days ago decays out instead of lying.
 */
function newState() {
  return {
    open: false,
    waiting: false,
    decisions: new Map(),
    pendingSince: 0,
    lastEventAt: 0,
    lastTurnEndAt: 0,
  };
}

/** Fold one append-feed event into a session state. */
function foldEvent(state, event) {
  const time = Number(event?.time ?? 0);
  if (Number.isFinite(time) && time > state.lastEventAt) state.lastEventAt = time;

  switch (event?.type) {
    case 'turn/start':
      state.open = true;
      state.waiting = false;
      state.decisions.clear();
      state.pendingSince = 0;
      return;
    case 'turn/end':
      state.open = false;
      state.waiting = false;
      state.decisions.clear();
      state.pendingSince = 0;
      state.lastTurnEndAt = Math.max(state.lastTurnEndAt, time);
      return;
    case 'tool/call': {
      const callId = event.data?.callId;
      if (typeof callId === 'string' && DECISION_TOOLS.has(event.data?.name)) {
        state.decisions.set(callId, time);
        state.pendingSince = Math.max(state.pendingSince, time);
        state.waiting = state.open;
      }
      return;
    }
    case 'tool/result': {
      const callId = event.data?.message?.toolCallId;
      if (typeof callId === 'string' && state.decisions.delete(callId)) {
        state.waiting = state.decisions.size > 0 && state.open;
        if (state.decisions.size === 0) state.pendingSince = 0;
      }
      return;
    }
    default:
      return;
  }
}

/**
 * The instant at which this session started wanting the user's attention.
 *
 * A running turn is not "unread": its attention comes only from a decision it is
 * parked on. A finished session's attention is the moment its last turn ended.
 */
function attentionSince(state) {
  return state.open === true ? state.pendingSince : state.lastTurnEndAt;
}

/** "3 分钟前" — the age label the menu shows next to each Session. */
function agoOf(time) {
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
}

/**
 * Classify every session into the two numbers the icon shows.
 *
 * @param states folded session states
 * @param liveSessions sessionId → Session, for the subagent test and titles
 * @param seenAt sessionId → when the Client reported it on screen
 * @param viewing sessionId → last viewing heartbeat from the Client
 * @param hidden sessionIds that must not count at all (archived, or not visible)
 * @returns {{running: number, attention: number, parked: number, finished: number,
 *            empty: number, items: {kind: string, at: number, id: string}[]}}
 */
function tally(states, liveSessions, seenAt, viewing, hidden, activeWindowMinutes, staleRunningMinutes) {
  const now = Date.now();
  const activeSince = now - activeWindowMinutes * 60_000;
  const runningSince = now - staleRunningMinutes * 60_000;
  const counts = { running: 0, attention: 0, parked: 0, finished: 0, empty: 0, items: [] };

  for (const [id, state] of states) {
    if (isSubagent(liveSessions.get(id))) continue;
    // An archived Session is out of the Workspace list, so it is out of the count.
    if (hidden.has(id)) continue;

    // The spinner: a turn that has not ended and is still emitting events.
    const spinning = state.open === true && state.lastEventAt >= runningSince;
    if (spinning) counts.running += 1;

    const since = attentionSince(state);
    if (since <= 0 || since < activeSince) {
      if (!spinning) counts.empty += 1;
      continue;
    }

    // On screen right now? Then this completion is being watched, not unread.
    const viewingAt = viewing.get(id);
    const onScreen = viewingAt !== undefined && now - viewingAt < VIEWING_FRESH_MS;
    const seen = Math.max(seenAt.get(id) ?? 0, onScreen ? since : 0);
    if (since <= seen) continue;

    counts.attention += 1;
    if (state.open === true) counts.parked += 1;
    else counts.finished += 1;
    counts.items.push({ kind: state.open === true ? 'parked' : 'finished', at: since, id });
  }

  counts.items.sort((left, right) => right.at - left.at);
  return counts;
}

/**
 * The one JSON line the helper receives.
 *
 * With nothing to report the item shows the whale alone: the icon is the
 * permanent affordance (click it to come back), while the numbers only earn
 * their width when they say something. `emptyStyle` keeps the other two
 * postures available: a literal `0/0`, or hiding the item entirely.
 */
function payloadOf(counts, emptyStyle, labelOf) {
  const total = counts.running + counts.attention;
  const empty = total === 0;
  const hidden = empty && emptyStyle === 'hidden';
  const detail = empty
    ? '暂无会话'
    : `运行中 ${counts.running} 个 · 完成或待答复 ${counts.attention} 个`;

  // Which Sessions those numbers refer to: the menu answers "是哪个" directly.
  const rows = counts.items.slice(0, 5).map((item) => {
    const mark = item.kind === 'parked' ? '🟠 待答复' : '🟢 已完成';
    return `${mark} · ${agoOf(item.at)} · ${labelOf(item.id)}`;
  });
  if (counts.items.length > 5) rows.push(`… 还有 ${counts.items.length - 5} 个`);

  return {
    hidden,
    title: empty ? (emptyStyle === 'count' ? '0/0' : '') : `${counts.running}/${counts.attention}`,
    header: detail,
    tooltip: `DeepSeek Harness · ${detail}`,
    items: rows,
  };
}

/** Start the native helper; the returned handle's stdin owns its lifetime. */
function startHelper(resolved, report) {
  const iconPath = resolved.iconPath !== '' ? resolved.iconPath : defaultIconPath;
  if (!existsSync(helperPath)) {
    report(new Error(`helper missing at ${helperPath}; run ./build.sh in the plugin directory`));
    return undefined;
  }

  let child;
  try {
    child = spawn(helperPath, ['--icon', iconPath, '--app', resolved.bundleId], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (error) {
    report(error);
    return undefined;
  }

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text !== '') report(new Error(`helper: ${text}`));
  });
  child.on('error', (error) => report(error));
  child.on('exit', (code, signal) => {
    if (signal === null && code === 0) return;
    report(new Error(`helper exited (code=${String(code)}, signal=${String(signal)})`));
  });
  // A closed stdin is the helper's shutdown signal; a broken pipe must not throw.
  child.stdin?.on('error', () => {});
  return child;
}

/** Push one payload; a helper that died is not resurrected behind the user's back. */
function writeHelper(child, payload) {
  if (child === undefined || child.stdin === undefined || child.stdin.destroyed) return;
  try {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // The exit handler already reported the failure.
  }
}

/** Dump the per-session fold next to the profile so a miscount can be diagnosed. */
function writeDebug(instanceId, counts, payload, states, liveSessions, seenAt, viewing, hidden, lastReport) {
  const rows = [];
  for (const [id, state] of states) {
    const session = liveSessions.get(id);
    const header = session?.header ?? {};
    rows.push({
      id,
      subagent: isSubagent(session),
      origin: header.origin ?? null,
      parent: header.parentSession ?? null,
      cwd: header.cwd ?? null,
      open: state.open,
      waiting: state.waiting,
      pendingSinceAgoS: state.pendingSince === 0 ? null : Math.round((Date.now() - state.pendingSince) / 1000),
      lastTurnEndAgoS: state.lastTurnEndAt === 0 ? null : Math.round((Date.now() - state.lastTurnEndAt) / 1000),
      seenAgoS: seenAt.has(id) ? Math.round((Date.now() - seenAt.get(id)) / 1000) : null,
      viewingAgoS: viewing.has(id) ? Math.round((Date.now() - viewing.get(id)) / 1000) : null,
      hidden: hidden.has(id),
    });
  }
  const profileDir = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
  try {
    writeFileSync(
      join(profileDir, '.menubar-status-debug.json'),
      `${JSON.stringify({ at: Date.now(), instanceId, counts, rows: payload.items, lastReport, sessions: rows }, null, 2)}\n`,
    );
  } catch {
    // Diagnostics must never break the counter.
  }
}

/** Fold every live session, then keep folding the append feed into the helper. */
function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) };
  if (resolved.enabled === false) return;

  let reported = false;
  const report = (error) => {
    if (reported) return;
    reported = true;
    try {
      ctx.logger?.warn?.('[menubar-status] %C', error);
    } catch {
      // A failing logger must not break session appends.
    }
  };

  /** Distinguishes concurrent instances; only the newest one may write. */
  const generation = (globalThis[GENERATION] ?? 0) + 1;
  globalThis[GENERATION] = generation;
  const instanceId = `${generation}-${Math.random().toString(36).slice(2, 6)}`;
  const isCurrent = () => globalThis[GENERATION] === generation;

  /** sessionId → folded state, plus the live Session objects the subagent test needs. */
  const states = new Map();
  const liveSessions = new Map();
  /** sessionId → last time the Client reported it on screen. */
  const seenAt = new Map();
  /** sessionId → last viewing heartbeat; the set is replaced by every report. */
  const viewing = new Map();
  /** sessionIds that must not count: archived, or absent from the visible list. */
  const hidden = new Set();
  /** What the page last told us, kept only for the debug dump. */
  let lastReport = { at: 0, mounted: [], focused: false };

  const track = (session) => {
    if (session?.id === undefined) return undefined;
    liveSessions.set(session.id, session);
    let state = states.get(session.id);
    if (state === undefined) {
      state = newState();
      states.set(session.id, state);
    }
    return state;
  };

  const sessions = ctx.get('sessions');
  let seed = [];
  try {
    seed = typeof sessions?.list === 'function' ? sessions.list() : [];
  } catch {
    seed = [];
  }
  for (const session of seed) {
    const state = track(session);
    if (state === undefined) continue;
    try {
      for (const event of session.snapshotEvents()) foldEvent(state, event);
    } catch {
      // A session whose log cannot be replayed still counts from here on.
    }
  }

  /** Session title for the menu rows; the store keeps it, the log does not. */
  const titleService = ctx.get('sessionTitle');
  const labelOf = (id) => {
    let title = '';
    try {
      title = String(titleService?.get?.(liveSessions.get(id))?.title ?? '');
    } catch {
      title = '';
    }
    const fallback = String(id).replace(/^session-/, '').slice(0, 8);
    const text = title.trim() === '' ? fallback : title.trim().replace(/\s+/gu, ' ');
    return text.length > 26 ? `${text.slice(0, 25)}…` : text;
  };

  /**
   * The archive set is not readable from the registry, so the baseline comes from
   * the same list the Workspace UI uses, and later archives arrive as events.
   * A Session missing from that list is already out of the sidebar, so it is out
   * of the counter too.
   */
  const sessionController = ctx.get('sessionController');
  if (typeof sessionController?.list === 'function') {
    try {
      const controller = new AbortController();
      sessionController.list({}, controller.signal)
        .then((value) => {
          const visible = new Set((value?.items ?? []).map((item) => item.sessionId));
          for (const id of liveSessions.keys()) {
            if (!visible.has(id) && !seenAt.has(id)) hidden.add(id);
          }
          schedule();
        })
        .catch(() => {
          // Without a baseline the event feed still hides later archives.
        });
    } catch {
      // A missing controller must not cost the icon.
    }
  }

  const onArchived = (request) => {
    const id = request?.sessionId ?? request?.id;
    if (typeof id !== 'string') return;
    hidden.add(id);
    schedule();
  };
  const onUnarchiving = (request) => {
    const id = request?.sessionId ?? request?.id;
    if (typeof id !== 'string') return;
    hidden.delete(id);
    schedule();
  };
  const onSessionAdded = (summary) => {
    const id = summary?.sessionId;
    if (typeof id !== 'string') return;
    hidden.delete(id);
    schedule();
  };

  const offArchived = ctx.on('workspace/session-archived', onArchived);
  const offUnarchiving = ctx.on('workspace/session-unarchiving', onUnarchiving);
  const offAdded = ctx.on('api-session/added', onSessionAdded);

  const helper = startHelper(resolved, report);

  let timer;
  let lastPayload = '';
  const flush = () => {
    timer = undefined;
    if (!isCurrent()) return;
    const counts = tally(
      states,
      liveSessions,
      seenAt,
      viewing,
      hidden,
      resolved.activeWindowMinutes,
      resolved.staleRunningMinutes,
    );
    const payload = payloadOf(counts, resolved.emptyStyle, labelOf);
    if (resolved.debug === true) {
      writeDebug(instanceId, counts, payload, states, liveSessions, seenAt, viewing, hidden, lastReport);
    }
    const encoded = JSON.stringify(payload);
    if (encoded === lastPayload) return;
    lastPayload = encoded;
    writeHelper(helper, payload);
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(flush, FLUSH_DELAY_MS);
    timer.unref?.();
  };

  if (helper !== undefined) flush();

  // Time moves the active windows even when nothing is appended.
  const tick = setInterval(schedule, TICK_MS);
  tick.unref?.();

  const onSessionEvent = (session, event) => {
    if (!isCurrent()) return;
    try {
      if (session?.id === undefined || event === undefined) return;
      const state = track(session);
      if (state === undefined) return;
      foldEvent(state, event);
      schedule();
    } catch (error) {
      report(error);
    }
  };

  const onSessionDisposed = (session) => {
    if (!isCurrent()) return;
    const id = session?.id;
    if (id === undefined) return;
    states.delete(id);
    liveSessions.delete(id);
    seenAt.delete(id);
    viewing.delete(id);
    schedule();
  };

  /** The Client half reports what its conversation views are showing. */
  const webServer = ctx.get('webServer');
  const connection = ctx.get('connection');
  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  let route;
  if (typeof webServer?.register === 'function') {
    const owner = Symbol('menubar-status instance');
    const slot = (globalThis[ROUTE_SLOT] ??= { owner: undefined, handler: undefined, dispose: undefined });
    slot.owner = owner;

    slot.handler = async (req, res) => {
      const rejection = typeof connection?.requestRejection === 'function'
        ? connection.requestRejection(req)
        : undefined;
      if (rejection !== undefined && rejection !== null) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return;
      }

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.byteLength;
        if (size > 64 * 1024) {
          req.resume();
          json(res, 400, { error: 'bad-request' });
          return;
        }
        chunks.push(chunk);
      }

      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks, size).toString('utf8') || '{}');
      } catch {
        json(res, 400, { error: 'bad-request' });
        return;
      }

      const ids = Array.isArray(body?.viewing) ? body.viewing : [];
      const now = Date.now();
      lastReport = {
        at: now,
        viewing: ids.slice(0, 50),
        mounted: Array.isArray(body?.mounted) ? body.mounted.slice(0, 50) : [],
        focused: body?.focused === true,
      };

      viewing.clear();
      for (const id of ids) {
        if (typeof id !== 'string' || id === '') continue;
        viewing.set(id, now);
        // Opening a Session is reading it: its attention mark never returns.
        seenAt.set(id, now);
      }
      schedule();
      json(res, 200, { ok: true, viewing: viewing.size });
    };

    if (slot.dispose === undefined) {
      try {
        slot.dispose = webServer.register({
          kind: 'exact',
          path: VIEWING_ROUTE,
          // Indirection: always dispatch to whichever instance is current.
          handler: (req, res) => {
            const live = globalThis[ROUTE_SLOT];
            if (live?.handler === undefined) {
              res.statusCode = 503;
              res.end();
              return undefined;
            }
            return live.handler(req, res);
          },
        });
      } catch (error) {
        // A route that an earlier instance left behind is not worth the icon:
        // without the Client reports the counters still work, just without the
        // "already opened" clearing.
        report(error);
      }
    }

    route = () => {
      const live = globalThis[ROUTE_SLOT];
      if (live?.owner !== owner) return;
      live.owner = undefined;
      live.handler = undefined;
    };
  }

  const offEvent = ctx.on('session/event', onSessionEvent);
  const offDisposed = ctx.on('session/disposed', onSessionDisposed);

  return () => {
    offEvent?.();
    offDisposed?.();
    offArchived?.();
    offUnarchiving?.();
    offAdded?.();
    route?.();
    clearInterval(tick);
    if (timer !== undefined) clearTimeout(timer);
    if (helper === undefined) return;
    try {
      helper.stdin?.end();
    } catch {
      // Already gone.
    }
    // EOF asks the helper to quit; the signal is the backstop for a stuck read.
    const killer = setTimeout(() => {
      try {
        helper.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }, 1500);
    killer.unref?.();
  };
}

export { Config, apply, name };

