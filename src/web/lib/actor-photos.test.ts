import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "vitest";
import {
  type ActorUpdate,
  applyActorUpdate,
  withActorUpdate,
} from "@/lib/actor-photos";
import {
  commentEntry,
  kai,
  kaiWithPhoto,
  maya,
  photoUrlFor,
} from "@/test/fixtures";

const newPhoto = photoUrlFor("a-kai", "9c");

/** Kai's state after an event: the given photo, no title unless one is passed. */
const kaiNow = (
  photoUrl: string | null,
  title: string | null = null,
): ActorUpdate => ({ actorId: "a-kai", photoUrl, title });

describe("withActorUpdate", () => {
  test("sets the photo on every object carrying the actor's id and a photoUrl, however deep", () => {
    const data = {
      items: [
        commentEntry("e1", "2026-11-13T10:00:00Z"),
        commentEntry("e2", "2026-11-13T09:00:00Z", { actor: maya }),
      ],
      filters: { actors: [kai, maya], projects: [] },
    };
    const next = withActorUpdate(data, kaiNow(newPhoto));
    expect(next.items[0]?.actor).toEqual({ ...kai, photoUrl: newPhoto });
    expect(next.filters.actors[0]).toEqual({ ...kai, photoUrl: newPhoto });
    expect(next.filters.actors[1]).toBe(maya);
    expect(next.items[1]).toBe(data.items[1]);
    expect(next.filters.projects).toBe(data.filters.projects);
    // the input is left as it was
    expect(data.items[0]?.actor).toBe(kai);
  });

  test("null clears the photo", () => {
    expect(withActorUpdate({ actor: kaiWithPhoto }, kaiNow(null))).toEqual({
      actor: { ...kai, photoUrl: null },
    });
  });

  test("returns the same reference when nothing names the actor", () => {
    const data = { items: [commentEntry("e1", "2026-11-13T10:00:00Z")] };
    expect(
      withActorUpdate(data, { ...kaiNow(newPhoto), actorId: "a-nobody" }),
    ).toBe(data);
  });

  test("returns the same reference when the actor already has that photo", () => {
    const data = { actor: kaiWithPhoto };
    expect(withActorUpdate(data, kaiNow(kaiWithPhoto.photoUrl))).toBe(data);
  });

  test("leaves an object with the id but no photoUrl of its own alone", () => {
    const comment = { id: "a-kai", body: "same id, not an actor" };
    expect(withActorUpdate(comment, kaiNow(newPhoto))).toBe(comment);
  });

  test("passes primitives and undefined through", () => {
    expect(withActorUpdate(undefined, kaiNow(newPhoto))).toBeUndefined();
    expect(withActorUpdate("a-kai", kaiNow(newPhoto))).toBe("a-kai");
  });

  test("sets, changes and clears a bot's title beside its photo", () => {
    const data = { actor: kai };
    const titled = withActorUpdate(data, kaiNow(null, "Platform Engineer"));
    expect(titled).toEqual({ actor: { ...kai, title: "Platform Engineer" } });
    expect(withActorUpdate(titled, kaiNow(null, "Release manager"))).toEqual({
      actor: { ...kai, title: "Release manager" },
    });
    expect(withActorUpdate(titled, kaiNow(null))).toEqual(data);
  });

  test("an update carrying a new photo and a new title sets both on the one actor", () => {
    const data = { actor: kai };
    expect(
      withActorUpdate(data, kaiNow(newPhoto, "Platform Engineer")),
    ).toEqual({
      actor: { ...kai, photoUrl: newPhoto, title: "Platform Engineer" },
    });
    // each half alone leaves the other as it was
    const both = { actor: { ...kai, photoUrl: newPhoto, title: "Old" } };
    expect(withActorUpdate(both, kaiNow(newPhoto, "New"))).toEqual({
      actor: { ...kai, photoUrl: newPhoto, title: "New" },
    });
    expect(withActorUpdate(both, kaiNow(null, "Old"))).toEqual({
      actor: { ...kai, photoUrl: null, title: "Old" },
    });
  });

  test("returns the same reference when photo and title are both unchanged", () => {
    const data = {
      actor: { ...kai, photoUrl: newPhoto, title: "Platform Engineer" },
    };
    expect(withActorUpdate(data, kaiNow(newPhoto, "Platform Engineer"))).toBe(
      data,
    );
  });

  test("leaves an issue's title alone though it shares the actor's id", () => {
    const issueLike = { id: "a-kai", title: "Back up the volume" };
    expect(withActorUpdate(issueLike, kaiNow(null, "Platform Engineer"))).toBe(
      issueLike,
    );
  });
});

describe("applyActorUpdate", () => {
  test("a read already in flight when the update lands can't put the old title and photo back", async () => {
    const queryClient = new QueryClient();
    const key = ["feed"];
    queryClient.setQueryData(key, { actor: kai });
    // the server built the first response before the change, the second after it
    const responses = [
      { actor: kai },
      { actor: { ...kai, photoUrl: newPhoto, title: "Platform Engineer" } },
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

    applyActorUpdate(queryClient, kaiNow(newPhoto, "Platform Engineer"));
    releaseStale();
    const answered = await read;

    const current = {
      actor: { ...kai, photoUrl: newPhoto, title: "Platform Engineer" },
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
        return { actor: kai };
      },
    });

    applyActorUpdate(queryClient, kaiNow(newPhoto, "Platform Engineer"));

    expect(queryClient.getQueryData(["issue"])).toEqual({
      actor: { ...kai, photoUrl: newPhoto, title: "Platform Engineer" },
    });
    expect(asked).toBe(1);
  });
});
