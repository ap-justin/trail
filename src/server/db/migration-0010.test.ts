import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, migrate, openDatabase } from "./client.js";
import { actorPhoto } from "./schema.js";

const dir = mkdtempSync(join(tmpdir(), "trail-0010-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the shipped migrations up to `last`
function through(last: number): string {
  const folder = join(dir, `migrations-${last}`);
  cpSync(fileURLToPath(new URL("./migrations", import.meta.url)), folder, {
    recursive: true,
  });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (e: { idx: number }) => e.idx <= last,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

const rows = (db: Db, sql: string, ...params: unknown[]) =>
  db.$client.prepare(sql).all(...params);

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const insertPhoto = (
  db: Db,
  photo: {
    actorId?: string;
    content?: Buffer;
    contentType?: string;
    hash?: string;
  },
) =>
  db.$client
    .prepare(
      "insert into actor_photo (actor_id, content, content_type, hash, updated_at) values (?, ?, ?, ?, 0)",
    )
    .run(
      photo.actorId ?? "h1",
      photo.content ?? png,
      photo.contentType ?? "image/png",
      photo.hash ?? sha256(photo.content ?? png),
    );

let db: Db;

beforeAll(() => {
  db = openDatabase(join(dir, "photos.db"));
  migrate(db, through(9));
  db.$client.exec(`
    insert into actor (id, kind, display_name, created_at) values
      ('h1', 'human', 'Ada', 0), ('h2', 'human', 'Grace', 0);
  `);
  migrate(db, through(10));
  return () => db.$client.close();
});

test("an actor from before 0010 has no photo, and keeps its row", () => {
  expect(rows(db, "select * from actor_photo")).toEqual([]);
  expect(rows(db, "select id from actor order by id")).toEqual([
    { id: "h1" },
    { id: "h2" },
  ]);
});

test("a photo round-trips through the drizzle table as bytes, stamped updated_at", () => {
  const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  db.insert(actorPhoto)
    .values({
      actorId: "h2",
      content,
      contentType: "image/jpeg",
      hash: sha256(content),
    })
    .run();

  const photo = db
    .select()
    .from(actorPhoto)
    .where(eq(actorPhoto.actorId, "h2"))
    .get();
  expect(photo?.content).toEqual(content);
  expect(photo?.contentType).toBe("image/jpeg");
  expect(photo?.updatedAt).toBeInstanceOf(Date);
  db.delete(actorPhoto).where(eq(actorPhoto.actorId, "h2")).run();
});

test("a content type outside png, jpeg and webp is rejected", () => {
  expect(() => insertPhoto(db, { contentType: "image/gif" })).toThrow(
    /CHECK constraint failed/,
  );
  expect(() => insertPhoto(db, { contentType: "image/svg+xml" })).toThrow(
    /CHECK constraint failed/,
  );
});

test("content is 1 to 262144 bytes", () => {
  const empty = Buffer.alloc(0);
  expect(() => insertPhoto(db, { content: empty })).toThrow(
    /CHECK constraint failed/,
  );
  const over = Buffer.alloc(262145, 1);
  expect(() => insertPhoto(db, { content: over })).toThrow(
    /CHECK constraint failed/,
  );

  const max = Buffer.alloc(262144, 1);
  insertPhoto(db, { content: max });
  expect(rows(db, "select length(content) as n from actor_photo")).toEqual([
    { n: 262144 },
  ]);
  db.$client.exec("delete from actor_photo");
});

test("content is bytes, not text", () => {
  expect(() =>
    db.$client
      .prepare(
        "insert into actor_photo (actor_id, content, content_type, hash, updated_at) values ('h1', 'not bytes', 'image/png', ?, 0)",
      )
      .run("a".repeat(64)),
  ).toThrow(/cannot store TEXT value in BLOB column/);
});

test("the hash is 64 lowercase hex characters", () => {
  expect(() => insertPhoto(db, { hash: "a".repeat(63) })).toThrow(
    /CHECK constraint failed/,
  );
  expect(() => insertPhoto(db, { hash: "a".repeat(65) })).toThrow(
    /CHECK constraint failed/,
  );
  expect(() => insertPhoto(db, { hash: sha256(png).toUpperCase() })).toThrow(
    /CHECK constraint failed/,
  );
  expect(() => insertPhoto(db, { hash: "g".repeat(64) })).toThrow(
    /CHECK constraint failed/,
  );
});

test("an actor has one photo at most, of an actor that exists", () => {
  insertPhoto(db, {});
  expect(() => insertPhoto(db, {})).toThrow(/UNIQUE constraint failed/);
  expect(() => insertPhoto(db, { actorId: "nobody" })).toThrow(
    /FOREIGN KEY constraint failed/,
  );
  db.$client.exec("delete from actor_photo");
});

test("a photo can be deleted, and goes with its actor", () => {
  insertPhoto(db, { actorId: "h1" });
  insertPhoto(db, { actorId: "h2" });

  db.$client.exec("delete from actor_photo where actor_id = 'h1'");
  expect(rows(db, "select actor_id from actor_photo")).toEqual([
    { actor_id: "h2" },
  ]);

  db.$client.exec("delete from actor where id = 'h2'");
  expect(rows(db, "select * from actor_photo")).toEqual([]);
  expect(rows(db, "pragma foreign_key_check")).toEqual([]);
});
