type Environment = Record<string, string | undefined>;

// Never fall back across Clerk instances: the browser, middleware and user API
// must all use the same environment.
export function resolveClerkConfiguration(env: Environment) {
  const development = env.NODE_ENV === "development";
  const publishableKey = development ? env.CLERK_DEV_PUBLISHABLE_KEY : env.CLERK_PUBLISHABLE_KEY;
  const secretKey = development ? env.CLERK_DEV_SECRET_KEY : env.CLERK_SECRET_KEY;
  const suffix = development ? "test" : "live";
  if (!publishableKey?.startsWith(`pk_${suffix}_`) || !secretKey?.startsWith(`sk_${suffix}_`)) {
    throw new Error(`Configure the matching Clerk ${development ? "development" : "production"} keys before starting the API.`);
  }
  return { publishableKey, secretKey };
}
