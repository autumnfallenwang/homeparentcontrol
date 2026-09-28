import type { Instrumentation } from "next";
import { webErrorLine } from "./lib/web-error-log.js";

/**
 * Next 15's server error hook: every failed render, route handler or server
 * action becomes one JSON line on stdout, where Alloy ships it to Loki.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const line = webErrorLine(error, request, context);
  if (process.env.NEXT_RUNTIME === "nodejs") process.stdout.write(`${line}\n`);
  else console.error(line);
};
