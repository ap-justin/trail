import { act } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { ActorUpdate } from "@/lib/actor-photos";
import type { EntryView } from "@/lib/api-types";

/** jsdom has no EventSource; this one is driven by the test, and lists every stream the app opened. */
export class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  /** The id of the last event that carried one, which every later event repeats. */
  private lastEventId = "";

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

  /** A closed source delivers nothing, whatever listeners are still attached. */
  private deliver(event: Event) {
    if (this.readyState === FakeEventSource.CLOSED) return;
    act(() => {
      this.dispatchEvent(event);
    });
  }

  open() {
    if (this.readyState === FakeEventSource.CLOSED) return;
    act(() => {
      this.readyState = FakeEventSource.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(entry: EntryView, seq = 1) {
    this.lastEventId = String(seq);
    this.deliver(
      new MessageEvent("message", {
        data: JSON.stringify(entry),
        lastEventId: this.lastEventId,
      }),
    );
  }

  /** The server's global `actor` event: a photo or title changed. It carries no id of its own. */
  actor(update: ActorUpdate) {
    this.deliver(
      new MessageEvent("actor", {
        data: JSON.stringify(update),
        lastEventId: this.lastEventId,
      }),
    );
  }

  reset() {
    this.deliver(new MessageEvent("reset", { data: "{}" }));
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

/** Installs the fake for every test; the setup file calls it, since every signed-in page opens a stream. */
export function installFakeEventSource() {
  beforeEach(() => {
    FakeEventSource.opened = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
