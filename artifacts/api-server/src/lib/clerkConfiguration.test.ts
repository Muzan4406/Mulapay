import assert from "node:assert/strict";
import test from "node:test";
import { resolveClerkConfiguration } from "./clerkConfiguration";

const env = {
  CLERK_DEV_PUBLISHABLE_KEY: "pk_test_example",
  CLERK_DEV_SECRET_KEY: "sk_test_example",
  CLERK_PUBLISHABLE_KEY: "pk_live_example",
  CLERK_SECRET_KEY: "sk_live_example",
};

test("preview selects only development credentials", () => {
  assert.deepEqual(resolveClerkConfiguration({ ...env, NODE_ENV: "development" }), {
    publishableKey: env.CLERK_DEV_PUBLISHABLE_KEY,
    secretKey: env.CLERK_DEV_SECRET_KEY,
  });
});

test("production ignores development credentials", () => {
  assert.deepEqual(resolveClerkConfiguration({ ...env, NODE_ENV: "production" }), {
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
  });
});

test("preview cannot fall back to production credentials", () => {
  assert.throws(() => resolveClerkConfiguration({ ...env, NODE_ENV: "development", CLERK_DEV_SECRET_KEY: undefined }));
  assert.throws(() => resolveClerkConfiguration({ ...env, NODE_ENV: "development", CLERK_DEV_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY }));
});

test("production rejects test credentials", () => {
  assert.throws(() => resolveClerkConfiguration({ ...env, NODE_ENV: "production", CLERK_SECRET_KEY: env.CLERK_DEV_SECRET_KEY }));
});
