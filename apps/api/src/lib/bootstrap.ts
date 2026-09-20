import { randomUUID } from "node:crypto";
import { count, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { householdMembers, households, users } from "../db/schema.js";
import { log } from "./logger.js";

/**
 * §5.5 — the first-run claim.
 *
 * Nothing is seeded by a migration. The first household is *claimed* when the
 * first human signs up, because a migration-seeded singleton is a hardcoded
 * identity wearing a costume (§5.1 rule 4).
 *
 * ⚠️ §5.5 says to do all of this in `databaseHooks.user.create.before`. That
 * cannot work: `before` runs while the user row does not yet exist, so there
 * is no id for the `household_members` row it also asks for. And the
 * `isService` user is itself a `users` row, so minting it through better-auth
 * inside a `user.create` hook would recurse and would leave `count(users) === 0`
 * false for the human. The split is: `before` sets role=admin (that is all it
 * can do), `after` calls this.
 */

/**
 * The default bedtime windows for a newly created child.
 *
 * ⚠️ NOT seeded at claim time, despite §5.5's wording. A `schedule_windows`
 * row needs a `policySetId` -> `policy_sets` -> a non-null `childId`, so
 * seeding a window transitively demands inventing a child — and a child named
 * "Child 1" is precisely the hardcoded identity §5.1 rule 4 forbids. The
 * values are pinned here and applied when a parent creates a real child.
 *
 * §4.3 illustrates the school-night window and gives no weekend example at
 * all, so the weekend row is chosen: together they cover all seven nights with
 * no overlap.
 *
 * ⚠️ `action` is `lock`, not §4.3's `shutdown`. A DEFAULT that can power off a
 * machine mid-homework is the wrong default — the schema default is already
 * `lock`, and a parent can escalate to `shutdown` deliberately.
 */
export const DEFAULT_SCHEDULE_WINDOWS = [
  {
    label: "School nights",
    days: ["sun", "mon", "tue", "wed", "thu"],
    restrictedFrom: "21:30",
    restrictedUntil: "07:00",
    action: "lock",
    shutdownGraceS: 300,
    escalateAfterFailures: 3,
    sortOrder: 0,
    warnings: [
      { leadMinutes: 30, channel: "banner" },
      { leadMinutes: 15, channel: "banner" },
      { leadMinutes: 5, channel: "modal" },
      { leadMinutes: 1, channel: "modal" },
    ],
  },
  {
    label: "Weekends",
    days: ["fri", "sat"],
    restrictedFrom: "22:30",
    restrictedUntil: "08:00",
    action: "lock",
    shutdownGraceS: 300,
    escalateAfterFailures: 3,
    sortOrder: 1,
    warnings: [
      { leadMinutes: 30, channel: "banner" },
      { leadMinutes: 15, channel: "banner" },
      { leadMinutes: 5, channel: "modal" },
      { leadMinutes: 1, channel: "modal" },
    ],
  },
] as const;

export interface ClaimResult {
  householdId: string;
  serviceUserId: string;
  ownerId: string;
}

/**
 * Create the household, its service user and the owner membership, in one
 * transaction. Idempotent: returns the existing household untouched if one
 * already exists, and does nothing at all when no human has signed up yet.
 *
 * Called from two places:
 *   1. `databaseHooks.user.create.after` — the normal path, immediately after
 *      the first sign-up commits.
 *   2. boot, from `index.ts` — a repair. The `after` hook runs AFTER the user
 *      row is committed, so a throw inside it strands an admin with no
 *      household. Restarting fixes it rather than requiring hand surgery.
 */
export async function claimFirstHousehold(): Promise<ClaimResult | null> {
  const [existing] = await db
    .select({ id: households.id, serviceUserId: households.serviceUserId })
    .from(households)
    .limit(1);
  if (existing) return null;

  // The owner is the oldest non-service user. At first run that is the only
  // human there is; on the repair path it is the stranded admin.
  const [owner] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.isService, false))
    .orderBy(users.createdAt)
    .limit(1);
  if (!owner) return null;

  // Generating both ids up front removes the ordering problem entirely:
  // `users` has no FK back to `households`, so the service user can be
  // inserted FIRST and `households.serviceUserId` is never transiently null.
  const householdId = randomUUID();
  const serviceUserId = randomUUID();

  await db.transaction(async (tx) => {
    // A.21 — a raw insert, NOT `auth.api.signUpEmail`. This is not an auth
    // subject: no password, no `accounts` row, no session, it never signs in.
    // It exists only so `apikeys.userId` has an owner that outlives any human
    // parent, because that column is NOT NULL ON DELETE CASCADE and deleting a
    // parent would otherwise silently revoke every Mac in the house.
    //
    // Going through better-auth would also not enlist in this transaction,
    // which is what makes §5.5's "same transaction" implementable at all.
    await tx.insert(users).values({
      id: serviceUserId,
      name: "Device service account",
      email: `service+${householdId}@hpc.local`,
      isService: true,
    });
    await tx.insert(households).values({
      id: householdId,
      name: `${owner.name}'s household`,
      serviceUserId,
    });
    await tx.insert(householdMembers).values({
      householdId,
      userId: owner.id,
      role: "owner",
    });
  });

  log.info(
    { event: "household.claimed", household_id: householdId, owner_id: owner.id },
    "first-run claim: household created",
  );
  return { householdId, serviceUserId, ownerId: owner.id };
}

/**
 * Boot-time repair, safe to call unconditionally. Logs loudly if it finds a
 * household with no service user, which should be impossible via the
 * transaction above but would silently break every enrolment if it happened.
 */
export async function claimFirstHouseholdAtBoot(): Promise<void> {
  const [{ value: userCount } = { value: 0 }] = await db.select({ value: count() }).from(users);
  if (userCount === 0) return; // nothing to claim yet — normal on a fresh DB

  const claimed = await claimFirstHousehold();
  if (claimed) {
    log.warn(
      { event: "household.claim_repaired", household_id: claimed.householdId },
      "repaired a stranded admin user that had no household — the create hook must have failed",
    );
  }

  const orphans = await db
    .select({ id: households.id })
    .from(households)
    .where(isNull(households.serviceUserId));
  for (const o of orphans) {
    log.error(
      { event: "household.no_service_user", household_id: o.id },
      "household has no service user — device enrolment will fail (A.21)",
    );
  }
}
