import express, { type Express } from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import router from "./routes";
import { logger } from "./lib/logger";
import { clerkClient, clerkConfiguration } from "./lib/clerk";
import { adminConsoleRouter, announcementsRouter } from "./routes/adminConsole";
import { OperationalError } from "./services/adminConfiguration";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true, origin: true }));
app.use(
  "/api/v1/kyc/uploads",
  express.raw({
    type: ["image/jpeg", "image/png", "image/webp"],
    limit: "10mb",
  }),
);
app.use(
  express.json({
    verify: (req, _res, buffer) => {
      if (["/api/v1/webhooks/drimpay", "/api/v1/webhooks/ashtechpay"].includes((req as express.Request).path)) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      }
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(
  clerkMiddleware({
    ...clerkConfiguration,
    clerkClient,
  }),
);

app.use("/api/v1/admin/console", adminConsoleRouter);
app.use("/api/v1/announcements", announcementsRouter);
app.use("/api", router);

if (process.env.PLESK_SERVE_FRONTEND === "true") {
  const appDirectory = path.dirname(fileURLToPath(import.meta.url));
  const frontendDirectory = process.env.MULAPAY_FRONTEND_DIR
    ? path.resolve(process.env.MULAPAY_FRONTEND_DIR)
    : path.resolve(appDirectory, "../../mulapay/dist/public");
  const indexFile = path.join(frontendDirectory, "index.html");

  if (!existsSync(indexFile)) {
    throw new Error(`Mulapay frontend build was not found at ${frontendDirectory}. Run pnpm run build:plesk before starting the app.`);
  }

  app.use(express.static(frontendDirectory, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res, next) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexFile, (error) => {
      if (error) next(error);
    });
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof OperationalError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof Error && error.name === "ZodError") {
    res.status(400).json({ error: "Les données saisies ne respectent pas les valeurs attendues." });
    return;
  }
  if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") {
    res.status(401).json({ error: "Authentification requise." });
    return;
  }
  logger.error({ error }, "Unhandled API error");
  res.status(500).json({ error: "Une erreur interne est survenue." });
});

export default app;
