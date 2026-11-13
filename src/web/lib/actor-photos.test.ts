import { describe, expect, test } from "vitest";
import { withActorPhoto } from "@/lib/actor-photos";
import {
  commentEntry,
  kai,
  kaiWithPhoto,
  maya,
  photoUrlFor,
} from "@/test/fixtures";

const newPhoto = photoUrlFor("a-kai", "9c");

describe("withActorPhoto", () => {
  test("sets the photo on every object carrying the actor's id and a photoUrl, however deep", () => {
    const data = {
      items: [
        commentEntry("e1", "2026-11-13T10:00:00Z"),
        commentEntry("e2", "2026-11-13T09:00:00Z", { actor: maya }),
      ],
      filters: { actors: [kai, maya], projects: [] },
    };
    const next = withActorPhoto(data, "a-kai", newPhoto);
    expect(next.items[0]?.actor).toEqual({ ...kai, photoUrl: newPhoto });
    expect(next.filters.actors[0]).toEqual({ ...kai, photoUrl: newPhoto });
    expect(next.filters.actors[1]).toBe(maya);
    expect(next.items[1]).toBe(data.items[1]);
    expect(next.filters.projects).toBe(data.filters.projects);
    // the input is left as it was
    expect(data.items[0]?.actor).toBe(kai);
  });

  test("null clears the photo", () => {
    expect(withActorPhoto({ actor: kaiWithPhoto }, "a-kai", null)).toEqual({
      actor: { ...kai, photoUrl: null },
    });
  });

  test("returns the same reference when nothing names the actor", () => {
    const data = { items: [commentEntry("e1", "2026-11-13T10:00:00Z")] };
    expect(withActorPhoto(data, "a-nobody", newPhoto)).toBe(data);
  });

  test("returns the same reference when the actor already has that photo", () => {
    const data = { actor: kaiWithPhoto };
    expect(withActorPhoto(data, "a-kai", kaiWithPhoto.photoUrl)).toBe(data);
  });

  test("leaves an object with the id but no photoUrl of its own alone", () => {
    const comment = { id: "a-kai", body: "same id, not an actor" };
    expect(withActorPhoto(comment, "a-kai", newPhoto)).toBe(comment);
  });

  test("passes primitives and undefined through", () => {
    expect(withActorPhoto(undefined, "a-kai", newPhoto)).toBeUndefined();
    expect(withActorPhoto("a-kai", "a-kai", newPhoto)).toBe("a-kai");
  });
});
