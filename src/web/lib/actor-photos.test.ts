import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "vitest";
import {
  type ActorUpdate,
  applyActorUpdate,
  withActorUpdate,
} from "@/lib/actor-photos";
import {
  alpha,
  alphaWithPhoto,
  commentEntry,
  maya,
  photoUrlFor,
} from "@/test/fixtures";

const newPhoto = photoUrlFor("a-alpha", "9c");

/** Alpha's state after an event: the given photo, no title unless one is passed. */
const alphaNow = (
  photoUrl: string | null,
  title: string | null = null,
): ActorUpdate => ({ actorId: "a-alpha", photoUrl, title });

describe("withActorUpdate", () => {
  test("sets the photo on every object carrying the actor's id and a photoUrl, however deep", () => {
    const data = {
      items: [
        commentEntry("e1", "2026-11-13T10:00:00Z"),
        commentEntry("e2", "2026-11-13T09:00:00Z", { actor: maya }),
      ],
      filters: { actors: [alpha, maya], projects: [] },
    };
    const next = withActorUpdate(data, alphaNow(newPhoto));
    expect(next.items[0]?.actor).toEqual({ ...alpha, photoUrl: newPhoto });
    expect(next.filters.actors[0]).toEqual({ ...alpha, photoUrl: newPhoto });
    expect(next.filters.actors[1]).toBe(maya);
    expect(next.items[1]).toBe(data.items[1]);
    expect(next.filters.projects).toBe(data.filters.projects);
    // the input is left as it was
    expect(data.items[0]?.actor).toBe(alpha);
  });

  test("null clears the photo", () => {
    expect(withActorUpdate({ actor: alphaWithPhoto }, alphaNow(null))).toEqual({
      actor: { ...alpha, photoUrl: null },
    });
  });

  test("returns the same reference when nothing names the actor", () => {
    const data = { items: [commentEntry("e1", "2026-11-13T10:00:00Z")] };
    expect(
      withActorUpdate(data, { ...alphaNow(newPhoto), actorId: "a-nobody" }),
    ).toBe(data);
  });

  test("returns the same reference when the actor already has that photo", () => {
    const data = { actor: alphaWithPhoto };
    expect(withActorUpdate(data, alphaNow(alphaWithPhoto.photoUrl))).toBe(data);
  });

  test("leaves an object with the id but no photoUrl of its own alone", () => {
    const comment = { id: "a-alpha", body: "same id, not an actor" };
    expect(withActorUpdate(comment, alphaNow(newPhoto))).toBe(comment);
  });

  test("passes primitives and undefined through", () => {
    expect(withActorUpdate(undefined, alphaNow(newPhoto))).toBeUndefined();
    expect(withActorUpdate("a-alpha", alphaNow(newPhoto))).toBe("a-alpha");
  });

  test("sets, changes and clears a bot's title beside its photo", () => {
    const data = { actor: alpha };
    const titled = withActorUpdate(data, alphaNow(null, "Platform Engineer"));
    expect(titled).toEqual({ actor: { ...alpha, title: "Platform Engineer" } });
    expect(withActorUpdate(titled, alphaNow(null, "Release manager"))).toEqual({
      actor: { ...alpha, title: "Release manager" },
    });
    expect(withActorUpdate(titled, alphaNow(null))).toEqual(data);
  });

  test("an update carrying a new photo and a new title sets both on the one actor", () => {
    const data = { actor: alpha };
    expect(
      withActorUpdate(data, alphaNow(newPhoto, "Platform Engineer")),
    ).toEqual({
      actor: { ...alpha, photoUrl: newPhoto, title: "Platform Engineer" },
    });
    // each half alone leaves the other as it was
    const both = { actor: { ...alpha, photoUrl: newPhoto, title: "Old" } };
    expect(withActorUpdate(both, alphaNow(newPhoto, "New"))).toEqual({
      actor: { ...alpha, photoUrl: newPhoto, title: "New" },
    });
    expect(withActorUpdate(both, alphaNow(null, "Old"))).toEqual({
      actor: { ...alpha, photoUrl: null, title: "Old" },
    });
  });

  test("returns the same reference when photo and title are both unchanged", () => {
    const data = {
      actor: { ...alpha, photoUrl: newPhoto, title: "Platform Engineer" },
    };
    expect(withActorUpdate(data, alphaNow(newPhoto, "Platform Engineer"))).toBe(
      data,
    );
  });

  test("leaves an issue's title alone though it shares the actor's id", () => {
    const issueLike = { id: "a-alpha", title: "Back up the volume" };
    expect(
      withActorUpdate(issueLike, alphaNow(null, "Platform Engineer")),
    ).toBe(issueLike);
  });
});

describe("applyActorUpdate", () => {
  test("a read already in flight when the update lands can't put the old title and photo back", async () => {
    const queryClient = new QueryClient();
    const key = ["feed"];
    queryClient.setQueryData(key, { actor: alpha });
    // the server built the first response before the change, the second after it
    const responses = [
      { actor: alpha },
      { actor: { ...alpha, photoUrl: newPhoto, title: "Platform Engineer" } },
    ];
    let releaseStale = () => {};
    let asked = 0;
    const read = queryClient.fetchQuery({
      queryKey: key,
      queryFn: () => {
        const payload = responses[asked++];
        if (asked > 1) return payload;
        return new Promise((resolve) => {
          releaseStale = () => resolve(payload);
        });
      },
    });

    applyActorUpdate(queryClient, alphaNow(newPhoto, "Platform Engineer"));
    releaseStale();
    const answered = await read;

    const current = {
      actor: { ...alpha, photoUrl: newPhoto, title: "Platform Engineer" },
    };
    expect(queryClient.getQueryData(key)).toEqual(current);
    expect(answered).toEqual(current);
  });

  test("a read that isn't in flight is patched in place, not read again", async () => {
    const queryClient = new QueryClient();
    let asked = 0;
    await queryClient.fetchQuery({
      queryKey: ["issue"],
      queryFn: () => {
        asked++;
        return { actor: alpha };
      },
    });

    applyActorUpdate(queryClient, alphaNow(newPhoto, "Platform Engineer"));

    expect(queryClient.getQueryData(["issue"])).toEqual({
      actor: { ...alpha, photoUrl: newPhoto, title: "Platform Engineer" },
    });
    expect(asked).toBe(1);
  });
});
