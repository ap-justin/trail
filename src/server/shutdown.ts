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
 * On the first SIGINT or SIGTERM, stops accepting connections, cuts any still
 * open after `deadlineMs`, runs `onClosed` and dies by that signal. A second
 * signal during the drain dies by it at once.
 */
export function onShutdownSignal({
  server,
  onClosed,
  deadlineMs,
  proc = process,
}: {
  server: Pick<Server, "close" | "closeAllConnections">;
  onClosed: () => void;
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
    // a streaming response never ends on its own, so close() would wait forever
    setTimeout(() => server.closeAllConnections(), deadlineMs).unref();
    server.close(() => {
      onClosed();
      dieBy(signal);
    });
  }

  listen(shutdown);
}
