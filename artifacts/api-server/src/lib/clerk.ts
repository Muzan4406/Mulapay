import { createClerkClient } from "@clerk/express";
import { resolveClerkConfiguration } from "./clerkConfiguration";

export const clerkConfiguration = resolveClerkConfiguration(process.env);
export const clerkClient = createClerkClient(clerkConfiguration);
