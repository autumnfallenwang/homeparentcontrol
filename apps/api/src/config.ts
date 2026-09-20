/** Centralized env access. Nothing outside this module reads process.env. */
export const config = {
  databaseUrl: process.env.DATABASE_URL,
  apiPort: Number(process.env.API_PORT ?? 3001),
  logLevel: process.env.LOG_LEVEL ?? "info",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  tz: process.env.TZ ?? "America/New_York",
} as const;
