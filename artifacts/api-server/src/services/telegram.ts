import { and, asc, count, desc, eq, gt, gte, inArray, sql, sum } from "drizzle-orm";
import { db } from "@workspace/db";
import { exchanges, notifications, transactions, users, wallets } from "@workspace/db";
import { logger } from "../lib/logger";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 3900;
let workerStartedAt: Date | null = null;
let polling = false;
let commandPolling = false;
let updateOffset: number | undefined;
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

async function fetchTelegramUpdates() {
  const config = telegramConfig();
  if (!config) return [];
  const params = new URLSearchParams({
    timeout: "1",
    allowed_updates: JSON.stringify(["message"]),
  });
  if (updateOffset !== undefined) params.set("offset", String(updateOffset));
  const response = await fetch(`${TELEGRAM_API}/bot${config.token}/getUpdates?${params.toString()}`);
  if (!response.ok) throw new Error(`Telegram getUpdates failed (${response.status})`);
  const payload = await response.json() as {
    ok?: boolean;
    description?: string;
    result?: Array<{
      update_id: number;
      message?: {
        chat?: { id?: number; type?: string };
        text?: string;
      };
    }>;
  };
  if (!payload.ok) throw new Error(payload.description ?? "Telegram rejected getUpdates.");
  return payload.result ?? [];
}

async function handleTelegramCommands() {
  if (commandPolling || !telegramConfig()) return;
  commandPolling = true;
  try {
    const updates = await fetchTelegramUpdates();
    for (const update of updates) {
      updateOffset = update.update_id + 1;
      const chatId = update.message?.chat?.id;
      const text = update.message?.text?.trim();
      if (!chatId || String(chatId) !== telegramConfig()?.chatId || !text?.startsWith("/")) continue;
      const command = text.split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
      if (command === "/aide" || command === "/start") {
        await sendTelegramMessage([
          "🤖 Commandes Mulapay",
          "/aide — afficher toutes les commandes",
          "/statut — vérifier que le bot est actif",
          "/notifications — compter les notifications des dernières 24 h",
          "/dernieres — afficher les 5 derniers événements",
          "/inscriptions — compter les inscriptions des dernières 24 h",
          "",
          "Les notifications financières et de sécurité sont envoyées automatiquement dans ce groupe.",
        ].join("\n"));
      } else if (command === "/statut") {
        await sendTelegramMessage("✅ Mulapay est actif. Les notifications sont surveillées.");
      } else if (command === "/notifications") {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recent = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(gte(notifications.createdAt, since));
        await sendTelegramMessage(`📊 Notifications des dernières 24 h : ${recent.length}`);
      } else if (command === "/inscriptions") {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const registrations = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(and(
            eq(notifications.title, "Nouvelle inscription"),
            gte(notifications.createdAt, since),
          ));
        await sendTelegramMessage(`👤 Inscriptions des dernières 24 h : ${registrations.length}`);
      } else if (command === "/statistiques" || command === "/stats") {
        const [
          [userStats],
          [verifiedStats],
          walletStats,
          [transactionStats],
          transactionVolumes,
          transactionFees,
          [exchangeStats],
          [exchangeFees],
        ] = await Promise.all([
          db.select({ total: count() }).from(users),
          db.select({ total: count() }).from(users).where(inArray(users.kycStatus, ["VERIFIE", "VERIFIED"])),
          db.select({
            currency: wallets.currency,
            balance: sum(wallets.balance),
            pending: sum(wallets.pending),
          }).from(wallets).groupBy(wallets.currency),
          db.select({
            total: count(),
            completed: sql<number>`count(*) filter (where ${transactions.status} = 'Completed')`,
            pending: sql<number>`count(*) filter (where ${transactions.status} = 'Pending')`,
          }).from(transactions),
          db.select({
            currency: transactions.currency,
            amount: sum(transactions.amount),
          }).from(transactions).where(eq(transactions.status, "Completed")).groupBy(transactions.currency),
          db.select({
            currency: transactions.currency,
            amount: sum(transactions.platformFee),
          }).from(transactions).where(and(
            eq(transactions.status, "Completed"),
            sql`${transactions.platformFee} is not null`,
          )).groupBy(transactions.currency),
          db.select({ total: count() }).from(exchanges).where(eq(exchanges.status, "COMPLETED")),
          db.select({ amount: sum(exchanges.platformFee) }).from(exchanges).where(eq(exchanges.status, "COMPLETED")),
        ]);
        const formatAmount = (value: string | number | null | undefined) => new Intl.NumberFormat("fr-FR").format(Number(value ?? 0));
        const balances = walletStats.map(item => `• ${item.currency} : disponible ${formatAmount(item.balance)} · réservé ${formatAmount(item.pending)}`);
        const volumes = transactionVolumes.map(item => `• ${item.currency} : ${formatAmount(item.amount)}`);
        const fees = transactionFees.map(item => `• ${item.currency} : ${formatAmount(item.amount)}`);
        await sendTelegramMessage([
          "📊 Statistiques Mulapay",
          "",
          `👥 Utilisateurs : ${userStats?.total ?? 0}`,
          `✅ KYC vérifiés : ${verifiedStats?.total ?? 0}`,
          "",
          "💰 Soldes wallets",
          ...(balances.length ? balances : ["• Aucun wallet"]),
          "",
          `🔄 Transactions : ${transactionStats?.total ?? 0}`,
          `✅ Transactions confirmées : ${transactionStats?.completed ?? 0}`,
          `⏳ Transactions en attente : ${transactionStats?.pending ?? 0}`,
          "📈 Volume confirmé par devise",
          ...(volumes.length ? volumes : ["• Aucun volume"]),
          "",
          "💸 Commissions transactions",
          ...(fees.length ? fees : ["• Aucune commission"]),
          `💱 Échanges confirmés : ${exchangeStats?.total ?? 0}`,
          `💱 Commissions échanges : ${formatAmount(exchangeFees?.amount)}`,
          "",
          `🕒 ${new Date().toISOString()}`,
        ].join("\n"));
      } else if (command === "/dernieres") {
        const latest = await db
          .select({
            title: notifications.title,
            createdAt: notifications.createdAt,
          })
          .from(notifications)
          .orderBy(desc(notifications.createdAt))
          .limit(5);
        const lines = latest.map(item => `• ${item.title} · ${item.createdAt.toISOString()}`);
        await sendTelegramMessage(lines.length ? `🕘 5 derniers événements\n${lines.join("\n")}` : "🕘 Aucun événement récent.");
      }
    }
  } catch (error) {
    logger.error({ error }, "Telegram command polling failed");
  } finally {
    commandPolling = false;
  }
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
  void handleTelegramCommands();
  setInterval(() => void handleTelegramCommands(), 1500);
  logger.info("Telegram notification worker started");
}
