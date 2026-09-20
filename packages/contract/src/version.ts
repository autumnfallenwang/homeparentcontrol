/**
 * Contract versioning (R3): major in the path (`/v1/`), minor in a field.
 *
 * `CONTRACT_MINOR` is what an agent advertises and what the server echoes, so
 * capability negotiation (R4) can send a device only what it said it understands.
 * Bump it for any additive change; a breaking change gets a new path instead.
 */
export const CONTRACT_MINOR = 1 as const;

/** Path segment for the current major version. */
export const CONTRACT_MAJOR_PATH = "/v1" as const;
