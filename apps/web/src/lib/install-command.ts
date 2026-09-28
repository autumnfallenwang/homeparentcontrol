/**
 * The one command a parent pastes into Terminal on the child's Mac, from a
 * copy of this project, to install and enrol the agent in a single step.
 *
 * `install.sh` builds the package from source, installs it, and hands the
 * server address and the code to the agent, which enrols on its next tick.
 * `--safe` builds the variant whose power-off is only a log line — the right
 * choice until the real shutdown has been seen once on real hardware.
 */
export function installCommand({
  apiOrigin,
  code,
  safe,
}: {
  apiOrigin: string;
  code: string;
  safe: boolean;
}): string {
  const baseUrl = `${apiOrigin.replace(/\/+$/, "")}/api/agent/v1/`;
  return [
    "sudo agent/scripts/install.sh",
    safe ? "--safe" : null,
    `--base-url ${baseUrl}`,
    `--code ${code}`,
  ]
    .filter(Boolean)
    .join(" ");
}
