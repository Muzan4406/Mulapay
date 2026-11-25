import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const apiBundlePath = path.join(appRoot, "artifacts/api-server/dist/index.mjs");
const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const secretKey = process.env.CLERK_SECRET_KEY;

let bundleText = "";
try {
  bundleText = readFileSync(apiBundlePath, "utf8");
} catch {
  // Keep the startup trace useful when the bundle is missing or unreadable.
}

console.error(
  "[Mulapay startup check]",
  JSON.stringify({
    appRoot,
    apiBundlePath,
    bundleReadable: bundleText.length > 0,
    hasCurrentClerkDiagnostic: bundleText.includes("Key values are not logged."),
    hasOldClerkDiagnostic: bundleText.includes("Configure the matching Clerk"),
    nodeEnv: process.env.NODE_ENV ?? null,
    publishableKeyPresent: Boolean(publishableKey),
    publishableKeyLooksProduction: publishableKey?.startsWith("pk_live_") ?? false,
    secretKeyPresent: Boolean(secretKey),
    secretKeyLooksProduction: secretKey?.startsWith("sk_live_") ?? false,
  }),
);

await import(pathToFileURL(apiBundlePath).href);
