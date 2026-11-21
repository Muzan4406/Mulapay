import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import router from "./routes";
import { logger } from "./lib/logger";
import { clerkClient, clerkConfiguration } from "./lib/clerk";

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

app.use("/api", router);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") {
    res.status(401).json({ error: "Authentification requise." });
    return;
  }
  logger.error({ error }, "Unhandled API error");
  res.status(500).json({ error: "Une erreur interne est survenue." });
});

export default app;
