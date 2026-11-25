type Environment = Record<string, string | undefined>;

// Never fall back across Clerk instances: the browser, middleware and user API
// must all use the same environment.
export function resolveClerkConfiguration(env: Environment) {
  const development = env.NODE_ENV === "development";
  const publishableKey = development ? env.CLERK_DEV_PUBLISHABLE_KEY : env.CLERK_PUBLISHABLE_KEY;
  const secretKey = development ? env.CLERK_DEV_SECRET_KEY : env.CLERK_SECRET_KEY;
  const suffix = development ? "test" : "live";
  const invalidVariables: string[] = [];
  if (!publishableKey?.startsWith(`pk_${suffix}_`)) {
    invalidVariables.push(`CLERK_${development ? "DEV_" : ""}PUBLISHABLE_KEY must start with pk_${suffix}_`);
  }
  if (!secretKey?.startsWith(`sk_${suffix}_`)) {
    invalidVariables.push(`CLERK_${development ? "DEV_" : ""}SECRET_KEY must start with sk_${suffix}_`);
  }
  if (invalidVariables.length > 0) {
    throw new Error(
      `Invalid Clerk ${development ? "development" : "production"} runtime configuration: ${invalidVariables.join("; ")}. Key values are not logged.`,
    );
  }
  return { publishableKey, secretKey };
}
