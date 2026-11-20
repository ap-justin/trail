import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { syncActor, syncEmailActor } from "../auth/identity.js";
import { PREVIEW_PERSON } from "../auth/preview.js";
import type { Db } from "../db/client.js";
import { invite, productMember } from "../db/schema.js";
import { createEventBus } from "../events/bus.js";
import { createPullRequests } from "../github/pull-requests.js";
import {
  type ActingActor,
  createService,
  type WorkStatus,
} from "../service/index.js";
import { createBot, setBotHandler } from "../service/keys.js";
import { webhookSettings } from "../service/webhooks.js";
import { deriveSecretKey } from "../webhooks/secret.js";

/** Whether nobody has written to the database yet: no person or bot, and no product. */
const hasNoActorsOrProducts = (db: Db): boolean =>
  db.get<{ empty: number }>(
    sql`select not exists (select 1 from actor) and not exists (select 1 from product) as empty`,
  ).empty === 1;

/**
 * Fills an empty database with made-up work for a preview: two products and a
 * team, each owned by a bot, with items in every status, notes, a project
 * across both products, status updates, comments, a bot's handler, and an
 * issue the preview person filed. The preview person is the owner, under
 * `ownerLogin`, as their first preview sign-in finds them.
 *
 * Writes nothing to a database anyone has written to, so a restart keeps a
 * preview's edits; returns whether it seeded. Every write goes through one
 * transaction: a failed seed leaves the database empty, to seed on the next
 * boot. No bot key leaves this function.
 */
export function seedPreview(
  db: Db,
  { ownerLogin }: { ownerLogin: string },
): boolean {
  // immediate: the emptiness check and the seed hold the write lock together
  return db.transaction(
    () => {
      if (!hasNoActorsOrProducts(db)) return false;
      seed(db, ownerLogin);
      return true;
    },
    { behavior: "immediate" },
  );
}

/** The writes of a seed; each nested transaction below is a savepoint in seedPreview's. */
function seed(db: Db, ownerLogin: string): void {
  const service = createService({
    db,
    // nothing listens yet: the server's own bus is made after the seed
    bus: createEventBus(),
    // the key seals webhook secrets, and the seed makes no webhook
    webhooks: webhookSettings(deriveSecretKey(randomBytes(32).toString("hex"))),
    pullRequests: createPullRequests({ db }),
  });

  const access = syncActor(
    db,
    {
      githubId: PREVIEW_PERSON.githubId,
      login: ownerLogin,
      name: PREVIEW_PERSON.name,
    },
    ownerLogin,
  );
  if (!access?.isOwner) {
    throw new Error("the preview person did not claim the owner seat");
  }
  const owner: ActingActor = { id: access.actor.id, kind: "human" };

  // each key is dropped unread, so nobody can act as these bots after the seed
  const bot = (name: string, label: string): ActingActor => ({
    id: createBot(db, name, { label }).actor.id,
    kind: "bot",
  });
  const wren = bot("Wren", "wren");
  const juniper = bot("Juniper", "juniper");
  const moss = bot("Moss", "moss");

  service.createProduct(wren, {
    name: "Harbor",
    key: "HBR",
    description: "The booking site for a made-up ferry line.",
  });
  service.createProduct(juniper, {
    name: "Lantern",
    key: "LTN",
    description: "A made-up mobile app for checking in at the dock.",
  });
  service.createTeam(moss, {
    name: "Night Shift",
    key: "NGT",
    description: "Moss's own work: upkeep that belongs to no product.",
  });

  const todo = (by: ActingActor, product: string, title: string) =>
    service.addTodo(by, { product, title }).key;
  const fileIssue = (by: ActingActor, product: string, title: string) =>
    service.fileIssue(by, { product, title }).key;
  const move = (by: ActingActor, key: string, status: WorkStatus) =>
    service.updateItem(by, key, { status });

  const seatMap = todo(wren, "HBR", "Show the seat map on the booking page");
  const refunds = todo(wren, "HBR", "Refund a canceled crossing in one step");
  move(wren, refunds, "in_progress");
  const timetable = todo(wren, "HBR", "Load the winter timetable");
  move(wren, timetable, "done");
  const slowSearch = fileIssue(
    juniper,
    "HBR",
    "Search takes four seconds on a weekday",
  );
  move(wren, slowSearch, "open");
  fileIssue(juniper, "HBR", "Price shows twice on the receipt");

  const offline = todo(juniper, "LTN", "Check in without a signal");
  move(juniper, offline, "in_progress");
  const qr = todo(juniper, "LTN", "Scan the boarding QR code");
  move(juniper, qr, "done");
  const darkMode = fileIssue(
    wren,
    "LTN",
    "Ask for dark mode on the boarding pass",
  );
  move(juniper, darkMode, "canceled");
  fileIssue(wren, "LTN", "The check-in button hides behind the keyboard");

  const backups = todo(moss, "NGT", "Rotate the nightly backups");
  move(moss, backups, "done");
  todo(moss, "NGT", "Renew the certificates before spring");

  service.addNote(wren, {
    product: "HBR",
    title: "Why search is slow",
    description:
      "The timetable query scans every sailing of the year; an index on the departure date would cut it.",
    about: [slowSearch, seatMap],
  });
  service.addNote(juniper, {
    product: "LTN",
    title: "Store review notes",
    description:
      "The last review asked for a clearer camera permission prompt.",
    about: [qr],
  });

  const project = service.createProject(wren, {
    name: "Spring launch",
    slug: "spring-launch",
    goal: "Book and board the new spring route from one app.",
    products: ["HBR", "LTN"],
  });
  service.addToProject(wren, project.slug, [
    seatMap,
    refunds,
    slowSearch,
    offline,
    qr,
  ]);
  service.createStatusUpdate(wren, {
    project: project.slug,
    health: "on_track",
    body: "Seat map and refunds are under way; the QR scan shipped.",
  });
  service.createStatusUpdate(juniper, {
    project: project.slug,
    health: "at_risk",
    body: "Offline check-in needs a sync design before it can ship.",
  });

  service.addComment(juniper, {
    issueId: slowSearch,
    body: "Seen on the Tuesday timetable too: about four seconds from the search box.",
  });
  service.addComment(wren, {
    issueId: slowSearch,
    body: "Reproduced. The note on this issue has the cause.",
  });
  service.addComment(juniper, {
    issueId: offline,
    body: "Drafting the sync design this week.",
  });

  // a handler is a member let in by email: setBotHandler finds them by address
  const handlerEmail = "rowan@example.test";
  const { id: inviteId } = db
    .insert(invite)
    .values({ email: handlerEmail, invitedBy: owner.id })
    .returning({ id: invite.id })
    .get();
  db.insert(productMember)
    .values({ inviteId, productId: service.getProduct(owner, "HBR").id })
    .run();
  syncEmailActor(db, handlerEmail);
  setBotHandler(db, "wren", handlerEmail);
  service.fileIssue(wren, {
    product: "LTN",
    title: "Rowan can't change a booking's name",
    filed_for: "handler",
  });

  // a person's issue is filed for that person
  service.fileIssue(owner, {
    product: "HBR",
    title: "The confirmation email has no return date",
    description:
      "Filed for the preview's owner, to show an issue a person filed.",
  });
}
