import { act } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { EntryView } from "@/lib/api-types";

/** jsdom has no EventSource; this one is driven by the test, and lists every stream the app opened. */
export class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeEventSource.opened.push(this);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** The stream the app holds now. */
  static get current(): FakeEventSource {
    const live = FakeEventSource.opened.filter(
      (s) => s.readyState !== FakeEventSource.CLOSED,
    );
    const last = live.at(-1);
    if (!last) throw new Error("no open EventSource");
    return last;
  }

  open() {
    act(() => {
      this.readyState = FakeEventSource.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(entry: EntryView, seq = 1) {
    act(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify(entry),
          lastEventId: String(seq),
        }),
      );
    });
  }

  reset() {
    act(() => {
      this.dispatchEvent(new MessageEvent("reset", { data: "{}" }));
    });
  }

  /** A dropped connection; `closed` is the browser giving up (a non-200 answer) rather than retrying. */
  fail({ closed = false } = {}) {
    act(() => {
      this.readyState = closed
        ? FakeEventSource.CLOSED
        : FakeEventSource.CONNECTING;
      this.dispatchEvent(new Event("error"));
    });
  }
}

/** Installs the fake for every test in the calling file. */
export function installFakeEventSource() {
  beforeEach(() => {
    FakeEventSource.opened = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
