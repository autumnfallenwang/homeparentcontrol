---
name: corepack-runtime-download
description: A Dockerfile that runs corepack as root but CMDs as USER node re-downloads pnpm on every cold start, and fails to boot with no network.
metadata:
  type: feedback
---

**If a Dockerfile's `CMD` invokes `pnpm`, set `COREPACK_HOME` to a path the runtime user owns.**

The house Dockerfile pattern does this:

```dockerfile
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate   # runs as root
...
USER node
CMD ["pnpm", "--filter", "@hpc/api", "start"]                      # runs as node
```

Corepack caches the pnpm tarball under `$COREPACK_HOME`, which defaults to **root's** home
(`/root/.cache/node/corepack`). `USER node` cannot read it, so corepack **re-downloads pnpm from
registry.npmjs.org on every cold container start**.

**Verified 2026-09-18, and the failure mode is worse than slow:**

| Scenario | Result |
|---|---|
| Cold container, network up | Downloads pnpm, ~6 s added to start |
| `docker restart` of an existing container | Fast — the download persists in the writable layer |
| **Cold container, no network** | ❌ **Exits 1.** DNS failure on `registry.npmjs.org`; the app never starts |

The middle row is why this hides: restarting a container locally looks fine. **Kubernetes creates a
*new* container on every pod restart**, so it always takes the first row — or the third, if npm is
unreachable. That is a crashloop on any pod restart during an npm outage.

**Fix** — two lines:

```dockerfile
ENV COREPACK_HOME=/home/node/.cache/corepack
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
...
RUN pnpm install --frozen-lockfile && chown -R node:node /app /home/node/.cache
```

Confirmed: the patched image boots with `--network none`.

⚠️ **`homework` and `homecal` ship the unpatched Dockerfile** — this was inherited, not introduced.
Worth fixing there too. Their web images are unaffected, because the production stage runs
`node apps/web/server.js` directly and never touches corepack.

See [[verify-macos-claims]] — same lesson, different domain: the thing everyone copies is not
automatically the thing that works.
