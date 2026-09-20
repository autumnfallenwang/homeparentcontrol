import { z } from "zod";
import { enrolmentRequest, enrolmentResponse, serverHealth } from "./enrolment.js";
import { eventEnvelope, eventsRequest, eventsResponse } from "./events.js";
import { policyDocument } from "./policy.js";
import { problemDocument } from "./problem.js";
import { syncRequest, syncResponse } from "./sync.js";

/**
 * Every shape the Swift agent needs, named. `emit.ts` turns this into a single
 * JSON-Schema artefact (R9) so the agent author is working from the same
 * definitions rather than a prose transcription.
 */
export const contractRegistry = z.registry<{ id: string }>();

contractRegistry.add(syncRequest, { id: "SyncRequest" });
contractRegistry.add(syncResponse, { id: "SyncResponse" });
contractRegistry.add(policyDocument, { id: "PolicyDocument" });
contractRegistry.add(eventEnvelope, { id: "EventEnvelope" });
contractRegistry.add(eventsRequest, { id: "EventsRequest" });
contractRegistry.add(eventsResponse, { id: "EventsResponse" });
contractRegistry.add(problemDocument, { id: "ProblemDocument" });
contractRegistry.add(enrolmentRequest, { id: "EnrolmentRequest" });
contractRegistry.add(enrolmentResponse, { id: "EnrolmentResponse" });
contractRegistry.add(serverHealth, { id: "ServerHealth" });
