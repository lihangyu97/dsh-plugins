/**
 * `turn-notify` — one desktop notification after every finished turn.
 *
 * Two delivery paths share one fold over the session append feed:
 *
 * - A live Web page renders the notification itself (browser Notification API),
 *   so the notification belongs to DeepSeek Harness, needs no helper app, and
 *   its click selects the Session that finished (`uiWorkspace.openSession`).
 *   The page proves it is alive on `/turn-notify/hello`; the Host hands it a
 *   payload only while that heartbeat is fresh and the page reports notification
 *   permission, so nothing is lost when the page is closed, still booting, or
 *   has notifications denied.
 * - Without such a page the Host posts the notification itself (`osascript`,
 *   which macOS delivers through Script Editor, or `terminal-notifier` when it
 *   is installed — the cleaner, Script-Editor-free helper).
 *
 * The trigger is the durable `turn/end` session event, so a turn that took
 * twenty steps still notifies exactly once, and the text comes from the same
 * append feed the Session already publishes: the LLM session title, the first
 * user message (fallback topic), and the latest assistant answer. Nothing is
 * polled and no session log is rescanned.
 *
 * Every user-visible string reaches a notifier as a separate argv item, so no
 * escaping or interpolation can change the script that runs.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

/** Cordis function-plugin name. */
const name = 'turn-notify';

/** Notification helpers are best-effort: a slow or hung notifier is abandoned. */
const NOTIFY_TIMEOUT_MS = 5000;

/** Page heartbeat endpoints; the Client half is the only caller. */
const HELLO_ROUTE = '/turn-notify/hello';
const DRAIN_ROUTE = '/turn-notify/drain';

/** The Client half beats every 15s; three missed beats hand delivery back to the Host. */
const CLIENT_FRESH_MS = 45000;

/** Undrained payloads expire, so reconnecting a page never replays a stale burst. */
const PENDING_TTL_MS = 60000;
const PENDING_LIMIT = 20;

/** Let the banner appear before quitting the helper macOS started for it. */
const SCRIPT_EDITOR_QUIT_DELAY_MS = 4000;

/**
 * AppleScript for macOS. All three visible strings plus the sound arrive in
 * `argv`, and AppleScript only decides whether to add the sound clause.
 */
const DARWIN_SCRIPT = [
  'on run argv',
  '  set theBody to item 1 of argv',
  '  set theTitle to item 2 of argv',
  '  set theSubtitle to item 3 of argv',
  '  set theSound to item 4 of argv',
  '  if theSound is "" then',
  '    display notification theBody with title theTitle subtitle theSubtitle',
  '  else',
  '    display notification theBody with title theTitle subtitle theSubtitle sound name theSound',
  '  end if',
  'end run',
].join('\n');

/** Brew installs land in one of these; a pinned `terminalNotifierPath` wins over all. */
const TERMINAL_NOTIFIER_CANDIDATES = [
  '/opt/homebrew/bin/terminal-notifier',
  '/usr/local/bin/terminal-notifier',
  '/usr/bin/terminal-notifier',
];

/** Effective defaults; also the fallback when no Config schema is available. */
const DEFAULTS = Object.freeze({
  enabled: true,
  title: 'DeepSeek Harness',
  silent: false,
  sound: '',
  maxTopicChars: 80,
  maxBodyChars: 140,
  skipSubagents: true,
  onlyCompleted: false,
  notifier: 'auto',
  terminalNotifierPath: '',
  quitScriptEditor: true,
});

let z;
try {
  ({ default: z } = await import('@deepseek-ai/schemastery'));
} catch {
  // A schema is a convenience for the settings form, not a runtime requirement:
  // the row's raw `config` is merged over DEFAULTS either way.
  z = undefined;
}

let Config;
try {
  Config = z?.object({
    enabled: z.boolean().default(DEFAULTS.enabled),
    title: z.string().default(DEFAULTS.title),
    silent: z.boolean().default(DEFAULTS.silent),
    sound: z.string().default(DEFAULTS.sound),
    maxTopicChars: z.natural().min(8).max(200).default(DEFAULTS.maxTopicChars),
    maxBodyChars: z.natural().min(8).max(400).default(DEFAULTS.maxBodyChars),
    skipSubagents: z.boolean().default(DEFAULTS.skipSubagents),
    onlyCompleted: z.boolean().default(DEFAULTS.onlyCompleted),
    notifier: z.union(['auto', 'osascript', 'terminal-notifier']).default(DEFAULTS.notifier),
    terminalNotifierPath: z.string().default(DEFAULTS.terminalNotifierPath),
    quitScriptEditor: z.boolean().default(DEFAULTS.quitScriptEditor),
  });
} catch {
  // An incompatible schema package must never cost the user their notifications.
  Config = undefined;
}

/** Human label per `TurnEndReason` kind; unknown kinds fall back to the kind. */
const REASON_LABELS = Object.freeze({
  completed: '完成',
  aborted: '已中止',
  blocked: '被阻止',
  error: '出错',
  'max-tokens': '达到长度上限',
  interrupted: '被中断',
  forked: '已分叉',
});

/** Concatenate the text blocks of one message's content. */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

/** Collapse whitespace and bound one line of notification text. */
function condense(value, maxChars) {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Whether this session is a delegated child rather than a user conversation. */
function isSubagent(session) {
  const header = session?.header;
  if (header === undefined || header === null) return false;
  return header.origin === 'subagent' || header.parentSession !== undefined;
}

/** The turn's ending kind, defaulting to `completed` for an unknown shape. */
function reasonKind(reason) {
  const kind = reason?.kind;
  return typeof kind === 'string' ? kind : 'completed';
}

/** The configured or discovered `terminal-notifier` executable, if any. */
function terminalNotifierPath(resolved) {
  if (resolved.terminalNotifierPath !== '') return resolved.terminalNotifierPath;
  return TERMINAL_NOTIFIER_CANDIDATES.find((candidate) => existsSync(candidate));
}

/** Notify once per finished turn of every non-delegated session. */
function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) };
  if (resolved.enabled === false) return;

  let reported = false;
  const report = (error) => {
    if (reported) return;
    reported = true;
    try {
      ctx.logger?.warn?.('[turn-notify] %C', error);
    } catch {
      // A failing logger must not fail the session append that triggered it.
    }
  };

  const webServer = ctx.get('webServer');
  const connection = ctx.get('connection');

  /** Client-half liveness: a stale or permission-less page must not swallow payloads. */
  let clientBeatAt = 0;
  let clientCanNotify = false;
  /** Payloads waiting for the page; each is claimed by exactly one drain call. */
  let pending = [];

  const runDetached = (command, args) => {
    try {
      execFile(command, args, { timeout: NOTIFY_TIMEOUT_MS, windowsHide: true }, (error) => {
        if (error) report(error);
      });
    } catch (error) {
      report(error);
    }
  };

  /** macOS started Script Editor to own an `osascript` notification; it must not linger. */
  const releaseScriptEditor = () => {
    if (resolved.quitScriptEditor !== true) return;
    const timer = setTimeout(() => {
      runDetached('/usr/bin/killall', ['-q', 'Script Editor']);
    }, SCRIPT_EDITOR_QUIT_DELAY_MS);
    timer.unref?.();
  };

  /** Post the notification from the Host process (no page is available or able). */
  const notifyFromHost = (payload) => {
    const system = platform();
    if (system === 'darwin') {
      const wanted = resolved.notifier === 'auto'
        ? (terminalNotifierPath(resolved) === undefined ? 'osascript' : 'terminal-notifier')
        : resolved.notifier;

      if (wanted === 'terminal-notifier') {
        const command = terminalNotifierPath(resolved);
        if (command !== undefined) {
          const args = ['-title', payload.title, '-group', payload.sessionId];
          if (payload.topic !== '') args.push('-subtitle', payload.topic);
          args.push('-message', payload.body);
          if (resolved.silent !== true) args.push('-sound', resolved.sound === '' ? 'default' : resolved.sound);
          runDetached(command, args);
          return;
        }
      }

      const sound = resolved.silent ? '' : String(resolved.sound ?? '');
      runDetached('/usr/bin/osascript', ['-e', DARWIN_SCRIPT, payload.body, payload.title, payload.topic, sound]);
      releaseScriptEditor();
      return;
    }

    if (system === 'linux') {
      const summary = payload.topic === '' ? payload.title : `${payload.title} · ${payload.topic}`;
      runDetached('notify-send', [summary, payload.body]);
      return;
    }

    report(new Error(`desktop notifications are not implemented on ${system}`));
  };

  const clientIsLive = () => clientCanNotify === true && Date.now() - clientBeatAt < CLIENT_FRESH_MS;

  /** Route one finished turn to the page or to the Host-side notifier. */
  const deliver = (payload) => {
    if (clientIsLive()) {
      const now = Date.now();
      pending = pending.filter((entry) => now - entry.at < PENDING_TTL_MS);
      pending.push({ ...payload, at: now });
      if (pending.length > PENDING_LIMIT) pending = pending.slice(pending.length - PENDING_LIMIT);
      return;
    }
    notifyFromHost(payload);
  };

  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  /** Answer an untrusted/unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : undefined;
    if (rejection === undefined || rejection === null) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  const readJsonBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.byteLength;
      if (size > 64 * 1024) {
        req.resume();
        return undefined;
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks, size).toString('utf8');
    if (text.trim() === '') return {};
    try {
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const routes = [];
  if (typeof webServer?.register === 'function') {
    routes.push(webServer.register({
      kind: 'exact',
      path: HELLO_ROUTE,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        if (body === undefined) {
          json(res, 400, { error: 'bad-request' });
          return;
        }
        clientBeatAt = Date.now();
        clientCanNotify = body.canNotify === true;
        json(res, 200, { ok: true, pending: pending.length });
      },
    }));
    routes.push(webServer.register({
      kind: 'exact',
      path: DRAIN_ROUTE,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'GET' && req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET, POST');
          res.end();
          return;
        }
        const now = Date.now();
        const items = pending.filter((entry) => now - entry.at < PENDING_TTL_MS);
        pending = [];
        json(res, 200, { items: items.map(({ at, ...rest }) => rest) });
      },
    }));
  }

  /** Per-session fold: topic fallback and the newest answer text. */
  const firstUserText = new Map();
  const latestAnswer = new Map();

  /** Read the log-backed title; absent before the first eligible prompt. */
  const titleOf = (session) => {
    try {
      const title = ctx.get('sessionTitle')?.get(session)?.title;
      return typeof title === 'string' ? title : '';
    } catch {
      return '';
    }
  };

  const onSessionEvent = (session, event) => {
    if (session === undefined || session === null || event === undefined || event === null) return;
    try {
      const id = session.id;

      if (event.type === 'user/message') {
        if (!firstUserText.has(id)) {
          const text = textOf(event.data?.content);
          if (text.trim() !== '') firstUserText.set(id, text);
        }
        return;
      }

      if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content);
        if (text.trim() !== '') latestAnswer.set(id, text);
        return;
      }

      if (event.type !== 'turn/end') return;
      if (resolved.skipSubagents === true && isSubagent(session)) return;

      const reason = reasonKind(event.data?.reason);
      if (resolved.onlyCompleted === true && reason !== 'completed') return;

      const topic = condense(titleOf(session) || firstUserText.get(id) || id, resolved.maxTopicChars);
      const answer = latestAnswer.get(id) ?? '';
      latestAnswer.delete(id);

      const label = REASON_LABELS[reason] ?? reason;
      const turn = event.data?.turn;
      const fallback = `第 ${typeof turn === 'number' ? turn : '?'} 轮 · ${label}`;
      const body = answer === ''
        ? fallback
        : (reason === 'completed' ? answer : `⚠️ ${label}：${answer}`);

      deliver({
        sessionId: id,
        title: condense(resolved.title !== '' ? resolved.title : DEFAULTS.title, 120),
        topic,
        body: condense(body, resolved.maxBodyChars),
        reason,
        turn: typeof turn === 'number' ? turn : null,
      });
    } catch (error) {
      report(error);
    }
  };

  const onSessionDisposed = (session) => {
    const id = session?.id;
    if (id === undefined) return;
    firstUserText.delete(id);
    latestAnswer.delete(id);
  };

  const offSessionEvent = ctx.on('session/event', onSessionEvent);
  const offSessionDisposed = ctx.on('session/disposed', onSessionDisposed);
  return () => {
    offSessionEvent?.();
    offSessionDisposed?.();
    for (const dispose of routes) dispose?.();
  };
}

export { Config, apply, name };
