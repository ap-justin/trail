import type { Server } from "node:http";

type Signal = "SIGINT" | "SIGTERM";

type SignalTarget = {
  pid: number;
  once(signal: Signal, listener: () => void): unknown;
  removeListener(signal: Signal, listener: () => void): unknown;
  kill(pid: number, signal: Signal): unknown;
};

const signals: Signal[] = ["SIGINT", "SIGTERM"];

/**
 * On the first SIGINT or SIGTERM, runs `onDraining`, stops accepting
 * connections, cuts any still open after `deadlineMs`, runs `onClosed` and,
 * once it settles, dies by that signal. A second signal during the drain dies by it at once.
 */
export function onShutdownSignal({
  server,
  onDraining = () => {},
  onClosed,
  deadlineMs,
  proc = process,
}: {
  server: Pick<
    Server,
    "close" | "closeAllConnections" | "closeIdleConnections"
  >;
  /** ends the responses that never end on their own, such as event streams */
  onDraining?: () => void;
  onClosed: () => void | Promise<void>;
  deadlineMs: number;
  proc?: SignalTarget;
}) {
  let listeners = new Map<Signal, () => void>();

  function listen(handler: (signal: Signal) => void) {
    for (const [s, listener] of listeners) proc.removeListener(s, listener);
    listeners = new Map(signals.map((s) => [s, () => handler(s)]));
    for (const [s, listener] of listeners) proc.once(s, listener);
  }

  // ours come off first, so the re-raised signal gets Node's default exit, not this handler
  function dieBy(signal: Signal) {
    for (const [s, listener] of listeners) proc.removeListener(s, listener);
    proc.kill(proc.pid, signal);
  }

  function shutdown(signal: Signal) {
    listen(dieBy);
    onDraining();
    // a streaming response onDraining missed would hold close() forever
    setTimeout(() => server.closeAllConnections(), deadlineMs).unref();
    // close() shuts only the connections idle at the call; a keep-alive one whose stream
    // onDraining is still ending goes idle later and would wait out keepAliveTimeout
    const sweep = setInterval(() => server.closeIdleConnections(), 50).unref();
    server.close(async () => {
      clearInterval(sweep);
      try {
        await onClosed();
      } finally {
        dieBy(signal);
      }
    });
  }

  listen(shutdown);
}
