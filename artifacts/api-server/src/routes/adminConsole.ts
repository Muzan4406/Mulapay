import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { adminAnnouncements, announcementDismissals, db, users, type MulapayUser } from "@workspace/db";
import { ExecuteAdminCommandBody, GetAdminConsoleQueryParams, GetAdminConsoleResponse } from "@workspace/api-zod";
import { readAdminConsole } from "../services/adminConsoleRead";
import { executeConsoleCommand } from "../services/adminCommands";
import { assertMerchantAccess, OperationalError } from "../services/adminConfiguration";

export const adminConsoleRouter: IRouter = Router();
adminConsoleRouter.use(async (req, res, next) => {
  const id = getAuth(req).userId;
  if (!id) throw new OperationalError("Une session administrateur Clerk est requise.", 401);
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!user || !["ADMIN", "SUPER_ADMIN"].includes(user.role) || user.status !== "ACTIVE") throw new OperationalError("Accès administrateur refusé.");
  res.locals.adminActor = user;
  next();
});
adminConsoleRouter.get("/", async (req, res) => {
  const input = GetAdminConsoleQueryParams.parse(req.query);
  const data = await readAdminConsole(input);
  res.json(GetAdminConsoleResponse.parse(data));
});
adminConsoleRouter.post("/commands", async (req, res) => {
  const input = ExecuteAdminCommandBody.parse(req.body);
  const actor = res.locals.adminActor as MulapayUser;
  const host = req.get("x-forwarded-host")?.split(",")[0].trim() || req.get("host");
  const protocol = req.get("x-forwarded-proto")?.split(",")[0].trim() || "https";
  res.json(await executeConsoleCommand(actor, input, `${protocol}://${host}`));
});

export const announcementsRouter: IRouter = Router();
announcementsRouter.use(async (req, res, next) => {
  const id = getAuth(req).userId;
  if (!id) throw new OperationalError("Authentification requise.", 401);
  await assertMerchantAccess(id);
  res.locals.userId = id;
  next();
});
announcementsRouter.get("/", async (_req, res) => {
  const id = res.locals.userId as string;
  const dismissed = await db.select({ id: announcementDismissals.announcementId }).from(announcementDismissals).where(eq(announcementDismissals.userId, id));
  const result = await db.select({ id: adminAnnouncements.id, title: adminAnnouncements.title, body: adminAnnouncements.body, createdAt: adminAnnouncements.createdAt })
    .from(adminAnnouncements).where(and(isNull(adminAnnouncements.deletedAt), dismissed.length ? notInArray(adminAnnouncements.id, dismissed.map(d => d.id)) : undefined)).orderBy(desc(adminAnnouncements.createdAt));
  res.json(result);
});
announcementsRouter.post("/:id/dismiss", async (req, res) => {
  const id = String(req.params.id);
  const publication = await db.query.adminAnnouncements.findFirst({ where: and(eq(adminAnnouncements.id, id), isNull(adminAnnouncements.deletedAt)) });
  if (!publication) throw new OperationalError("Publication introuvable.", 404);
  await db.insert(announcementDismissals).values({ userId: res.locals.userId, announcementId: id }).onConflictDoNothing();
  res.json({ ok: true, message: "Notification fermée." });
});
