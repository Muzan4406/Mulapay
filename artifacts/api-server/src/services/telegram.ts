import { asc, eq, gt } from "drizzle-orm";
import { db } from "@workspace/db";
import { notifications, users } from "@workspace/db";
import { logger } from "../lib/logger";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 3900;
let workerStartedAt: Date | null = null;
let polling = false;
const deliveredNotificationIds = new Set<string>();

function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

function telegramText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function sendTelegramMessage(text: string) {
  const config = telegramConfig();
  if (!config) return false;
  const response = await fetch(`${TELEGRAM_API}/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: text.slice(0, MAX_MESSAGE_LENGTH),
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Telegram sendMessage failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const payload = await response.json() as { ok?: boolean; description?: string };
  if (!payload.ok) throw new Error(payload.description ?? "Telegram rejected the message.");
  return true;
}

async function deliverNewNotifications() {
  if (polling || !workerStartedAt || !telegramConfig()) return;
  polling = true;
  try {
    const pending = await db
      .select({
        id: notifications.id,
        userId: notifications.userId,
        title: notifications.title,
        body: notifications.body,
        createdAt: notifications.createdAt,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(notifications)
      .innerJoin(users, eq(notifications.userId, users.id))
      .where(gt(notifications.createdAt, workerStartedAt))
      .orderBy(asc(notifications.createdAt))
      .limit(50);

    for (const notification of pending) {
      if (deliveredNotificationIds.has(notification.id)) continue;
      const account = [notification.firstName, notification.lastName].filter(Boolean).join(" ") || "Compte Mulapay";
      const message = [
        "🔔 Mulapay",
        `Événement : ${telegramText(notification.title)}`,
        `Compte : ${telegramText(account)}`,
        `Email : ${telegramText(notification.email)}`,
        `Détails : ${telegramText(notification.body)}`,
        `Date : ${notification.createdAt.toISOString()}`,
      ].join("\n");
      try {
        await sendTelegramMessage(message);
        deliveredNotificationIds.add(notification.id);
      } catch (error) {
        logger.error({ error, notificationId: notification.id }, "Telegram notification delivery failed");
        break;
      }
    }
  } catch (error) {
    logger.error({ error }, "Telegram notification polling failed");
  } finally {
    polling = false;
  }
}

export function startTelegramNotificationWorker() {
  if (workerStartedAt) return;
  workerStartedAt = new Date();
  if (!telegramConfig()) {
    logger.warn("Telegram notifications disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
    return;
  }
  void deliverNewNotifications();
  setInterval(() => void deliverNewNotifications(), 3000);
  logger.info("Telegram notification worker started");
}
