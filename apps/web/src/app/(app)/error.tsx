"use client";

import { Page } from "../../components/shell/page.js";
import { Banner, Button } from "../../components/ui.js";

/**
 * A page that failed on the server. Next hands over `digest` — the id of the
 * `web.request_error` line the server just wrote to Loki — so the reference
 * shown here finds exactly that line: `| json | digest="…"`.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Page title="Something went wrong">
      <Banner tone="alarm" title="This page could not load">
        Bedtime is not affected — the Macs keep enforcing the rules they have.
        {error.digest ? (
          <span className="mt-1 block text-xs text-muted-foreground">
            Reference: <span className="select-all font-mono">{error.digest}</span>
          </span>
        ) : null}
      </Banner>
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </Page>
  );
}
