/**
 * Seed one household, child, policy set and device, and print a fresh
 * enrolment code — everything the real Swift agent needs to enrol against a
 * local control plane.
 *
 * ⚠️ Exists because issuing an enrolment code is a PARENT UI action and the
 * parent UI is milestone 04. Without this, milestone 03's first exit
 * criterion ("agent enrols against the local control plane") could only be
 * verified by hand-writing a database row — a thing nobody does twice, and
 * therefore a thing nobody does.
 *
 * Development only: it writes straight to the database and mints a code with
 * no authentication whatsoever.
 *
 *   pnpm --filter @hpc/api exec tsx --env-file=.env src/scripts/seed-e2e.ts
 */
import { randomUUID } from "node:crypto";
import { closeDb, db } from "../db/index.js";
import {
  children,
  devices,
  enrollments,
  households,
  policySets,
  scheduleWindows,
  users,
} from "../db/schema.js";
import {
  ENROLMENT_TTL_MINUTES,
  enrolmentCodeHint,
  generateEnrolmentCode,
  hashEnrolmentCode,
  normaliseEnrolmentCode,
} from "../lib/enrolment-codes.js";

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed-e2e is a development tool and refuses to run in production");
  }

  const householdId = randomUUID();
  const serviceUserId = randomUUID();
  const childId = randomUUID();
  const policySetId = randomUUID();
  const deviceId = randomUUID();

  await db.insert(users).values({
    id: serviceUserId,
    name: "Device service account",
    email: `service+${householdId}@hpc.local`,
    isService: true,
  });
  await db.insert(households).values({ id: householdId, name: "E2E", serviceUserId });
  await db.insert(children).values({ id: childId, householdId, displayName: "Lucy" });
  await db.insert(policySets).values({ id: policySetId, householdId, childId });
  await db.insert(scheduleWindows).values({
    householdId,
    policySetId,
    label: "School nights",
    days: ["sun", "mon", "tue", "wed", "thu"],
    restrictedFrom: "21:30",
    restrictedUntil: "07:00",
  });
  await db.insert(devices).values({
    id: deviceId,
    householdId,
    childId,
    policySetId,
    label: "E2E Mac mini",
    status: "pending",
  });

  const code = generateEnrolmentCode();
  const normalised = normaliseEnrolmentCode(code);
  if (!normalised) throw new Error("generated a code the normaliser rejects");

  await db.insert(enrollments).values({
    householdId,
    deviceId,
    codeHash: hashEnrolmentCode(normalised),
    codeHint: enrolmentCodeHint(normalised),
    expiresAt: new Date(Date.now() + ENROLMENT_TTL_MINUTES * 60_000),
  });

  // One assignment per line, so a shell can `eval` the output directly.
  process.stdout.write(`HPC_E2E_CODE=${code}\n`);
  process.stdout.write(`HPC_E2E_DEVICE_ID=${deviceId}\n`);
  process.stdout.write(`HPC_E2E_HOUSEHOLD_ID=${householdId}\n`);
  await closeDb();
}

await main();
