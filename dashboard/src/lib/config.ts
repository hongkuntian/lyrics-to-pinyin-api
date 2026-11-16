export function dataMode(env: Record<string, string | undefined>) {
  const mode = env.LYRICA_DASHBOARD_MODE ?? "fixtures";
  if (mode === "production") {
    if (
      env.VERCEL_ENV !== "production" ||
      env.LYRICA_DASHBOARD_PROTECTION !== "vercel-all" ||
      !env.LYRICA_DASHBOARD_DATABASE_URL
    )
      throw new Error("dashboard_configuration_required");
    return mode;
  }
  if (env.VERCEL_ENV === "production")
    throw new Error("dashboard_configuration_required");
  if (!["fixtures", "empty", "error"].includes(mode))
    throw new Error("dashboard_configuration_required");
  return mode;
}
