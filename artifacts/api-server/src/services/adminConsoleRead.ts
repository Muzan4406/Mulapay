import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  db, pool, users, wallets, transactions, exchanges, kycVerifications, apiKeys, paymentLinks, paymentProviderRoutes,
  adminAnnouncements, adminProviders, apiUsage, blacklistedPhones, merchantIntegrations, merchantMessages, routeReservations,
  adminConfiguration,
} from "@workspace/db";
import type { AdminConsoleRow, AdminConsoleState, GetAdminConsoleParams } from "@workspace/api-zod";
import { getAdminConfiguration, profilePhone } from "./adminConfiguration";
import { emailIsConfigured } from "./merchantMail";
import { isDrimPayConfigured } from "./drimpay";
import { isAshtechPayConfigured } from "./ashtechpay";

const iso = (d: Date | null) => d?.toISOString() ?? null;
const dateLabel = (d: Date) => d.toISOString();
export async function readAdminConsole(input: GetAdminConsoleParams): Promise<AdminConsoleState> {
  const settings = await getAdminConfiguration();
  const [config, allUsers] = await Promise.all([
    db.query.adminConfiguration.findFirst({ where: eq(adminConfiguration.id, "global") }),
    db.select().from(users),
  ]);
  const names = new Map(allUsers.map(u => [u.id, u]));
  const owner = (id: string) => {
    const u = names.get(id);
    return { userId: id, merchantName: u ? `${u.firstName} ${u.lastName}` : "Compte conservé", email: u?.email ?? "" };
  };
  let items: AdminConsoleRow[] = [];
  let activity: AdminConsoleRow[] = [];
  let stats: Record<string, number> = {};
  let currencyTotals: AdminConsoleRow[] = [];
  if (input.section === "dashboard" || input.section === "wallets") {
    const [walletRows, totals, people, kyc, queue, fees] = await Promise.all([
      pool.query(`select country,code,currency,count(*)::int as count,count(*) filter(where status='Active')::int as active,
        coalesce(sum(balance),0)::float8 as balance,coalesce(sum(pending),0)::float8 as pending,
        coalesce(sum(greatest(balance-pending,0)),0)::float8 as available from mulapay_wallets group by country,code,currency order by country`),
      pool.query(`select
        coalesce(sum(amount) filter(where status='Completed'),0)::float8 as "totalVolume",
        coalesce(sum(amount) filter(where status='Completed' and type in ('Deposit','Payment')),0)::float8 as "totalDeposits",
        coalesce(sum(amount) filter(where status='Completed' and type in ('Withdrawal','Transfer')),0)::float8 as "totalWithdrawals",
        count(*) filter(where type in ('Deposit','Payment') and created_at>=date_trunc('day',now() at time zone 'Africa/Lome') at time zone 'Africa/Lome')::int as "payinTodayCount",
        coalesce(sum(amount) filter(where status='Completed' and type in ('Deposit','Payment') and created_at>=date_trunc('day',now() at time zone 'Africa/Lome') at time zone 'Africa/Lome'),0)::float8 as "payinTodayAmount",
        count(*) filter(where type in ('Withdrawal','Transfer') and created_at>=date_trunc('day',now() at time zone 'Africa/Lome') at time zone 'Africa/Lome')::int as "payoutTodayCount",
        coalesce(sum(amount) filter(where status='Completed' and type in ('Withdrawal','Transfer') and created_at>=date_trunc('day',now() at time zone 'Africa/Lome') at time zone 'Africa/Lome'),0)::float8 as "payoutTodayAmount",
        coalesce(sum(coalesce(platform_fee,fee,0)) filter(where status='Completed' and type in ('Deposit','Payment','Withdrawal','Transfer')),0)::float8 as "commissionTotal",
        coalesce(sum(coalesce(platform_fee,fee,0)) filter(where status='Completed' and type in ('Deposit','Payment','Withdrawal','Transfer') and coalesce(settled_at,created_at)>=date_trunc('day',now() at time zone 'Africa/Lome') at time zone 'Africa/Lome'),0)::float8 as "commissionToday",
        coalesce(sum(amount) filter(where status='Completed' and created_at>=coalesce($1::timestamptz,'epoch') and type in ('Deposit','Payment','Withdrawal','Transfer')),0)::float8 as "statsVolume",
        coalesce(sum(coalesce(platform_fee,fee,0)) filter(where status='Completed' and created_at>=coalesce($1::timestamptz,'epoch') and type in ('Deposit','Payment','Withdrawal','Transfer')),0)::float8 as "statsCommission"
        from mulapay_transactions where currency='XOF' and type in ('Deposit','Payment','Withdrawal','Transfer')`, [settings.statsSince]),
      pool.query(`select count(*) filter(where role='USER' and status<>'DELETED')::int as merchants,
        count(*) filter(where role='USER' and status<>'DELETED' and kyc_status in ('VERIFIE','VERIFIED'))::int as "verifiedMerchants" from mulapay_users`),
      pool.query(`select count(*)::int as count from mulapay_kyc_verifications where status in ('EN_ATTENTE','A_REVOIR')`),
      pool.query(`select count(*)::int as count from mulapay_exchanges where status='PENDING_ADMIN'`),
      pool.query(`select coalesce(sum(e.platform_fee),0)::float8 as fees from mulapay_exchanges e join mulapay_wallets w on w.id=e.source_wallet_id where e.status='COMPLETED' and w.currency='XOF'`),
    ]);
    items = walletRows.rows.map(r => ({ ...r, id: r.code }));
    currencyTotals = [...new Set(items.map(r => r.currency!))].map(currency => ({
      id: currency, currency, balance: items.filter(r => r.currency === currency).reduce((a, r) => a + r.balance!, 0),
      pending: items.filter(r => r.currency === currency).reduce((a, r) => a + r.pending!, 0),
      available: items.filter(r => r.currency === currency).reduce((a, r) => a + r.available!, 0),
      count: items.filter(r => r.currency === currency).reduce((a, r) => a + r.count!, 0),
      active: items.filter(r => r.currency === currency).reduce((a, r) => a + (r.active ?? 0), 0),
    }));
    stats = { ...totals.rows[0], ...people.rows[0], pendingKyc: kyc.rows[0].count, exchangeQueue: queue.rows[0].count,
      exchangeFees: fees.rows[0].fees, walletCount: items.reduce((a, r) => a + r.count!, 0), activeWallets: walletRows.rows.reduce((a, r) => a + r.active, 0),
      countryCount: items.length, availableMerchantFunds: currencyTotals.find(r => r.currency === "XOF")?.available ?? 0 };
    if (input.section === "dashboard") {
      items = (await db.select().from(merchantIntegrations).orderBy(desc(merchantIntegrations.createdAt))).map(r => ({ ...r, ...owner(r.userId), createdAt: dateLabel(r.createdAt) }));
      activity = (await db.select().from(transactions).orderBy(desc(transactions.createdAt)).limit(10))
        .map(r => ({ id: r.id, ...owner(r.userId), amount: r.amount, currency: r.currency, type: r.type, status: r.status, reference: r.reference, createdAt: dateLabel(r.createdAt) }));
    }
  } else if (input.section === "merchants") {
    const allWallets = await db.select().from(wallets);
    items = allUsers.map(u => {
      const owned = allWallets.filter(w => w.userId === u.id);
      return { id: u.id, ...owner(u.id), firstName: u.firstName, lastName: u.lastName, country: u.country, phone: u.phone,
        role: u.role, status: u.status, kycStatus: u.kycStatus, payinEnabled: u.payinEnabled, payoutEnabled: u.payoutEnabled,
        payinFee: u.payinFee === null ? null : Number(u.payinFee), payoutFee: u.payoutFee === null ? null : Number(u.payoutFee),
        currency: "XOF", balance: owned.filter(w => w.currency === "XOF").reduce((a, w) => a + w.balance, 0),
        available: owned.filter(w => w.currency === "XOF").reduce((a, w) => a + Math.max(0, w.balance - w.pending), 0),
        wallets: owned, createdAt: dateLabel(u.createdAt) };
    });
  } else if (input.section === "kyc") {
    items = (await db.select().from(kycVerifications).orderBy(desc(kycVerifications.submittedAt))).map(r => ({
      id: r.id, ...owner(r.userId), country: r.country, status: r.status, createdAt: dateLabel(r.submittedAt),
      documents: r.documents.map(d => ({ kind: d.kind, fileName: d.fileName, url: `/api/v1/admin/kyc/${r.id}/documents/${d.kind}` })),
    }));
  } else if (input.section === "transactions") {
    items = (await db.select().from(transactions).orderBy(desc(transactions.createdAt))).map(r => ({
      id: r.id, ...owner(r.userId), amount: r.amount, fee: r.platformFee ?? r.fee ?? 0, country: r.country, currency: r.currency,
      operator: r.operator ?? (r.counterparty.includes(" · ") ? r.counterparty.split(" · ").at(-1) ?? null : null),
      status: r.status, type: r.type, reference: r.reference, createdAt: dateLabel(r.createdAt),
    }));
  } else if (input.section === "exchanges") {
    items = (await db.select().from(exchanges).orderBy(desc(exchanges.requestedAt))).map(r => ({
      ...r, ...owner(r.userId), rate: Number(r.rate), fee: r.platformFee, createdAt: dateLabel(r.requestedAt), requestedAt: dateLabel(r.requestedAt),
    }));
  } else if (input.section === "providers" || input.section === "operators") {
    const saved = await db.select().from(adminProviders);
    const providerItems = [{ id: "DRIMPAY", name: "DrimPay", configured: isDrimPayConfigured() }, { id: "ASHTECHPAY", name: "AshtechPay", configured: isAshtechPayConfigured() }]
      .map(p => ({ ...p, enabled: saved.find(s => s.id === p.id)?.enabled ?? true }));
    if (input.section === "providers") items = providerItems;
    else {
      const day = new Date().toISOString().slice(0, 10);
      const usage = await db.select({ routeId: routeReservations.routeId, used: sql<number>`sum(${routeReservations.amount})::int` })
        .from(routeReservations).where(and(eq(routeReservations.day, day), ne(routeReservations.state, "RELEASED"))).groupBy(routeReservations.routeId);
      items = (await db.select().from(paymentProviderRoutes)).map(r => {
        const used = Number(usage.find(u => u.routeId === r.id)?.used ?? 0);
        return { ...r, dailyUsed: used, dailyRemaining: r.dailyLimit === null ? null : Math.max(0, r.dailyLimit - used), createdAt: dateLabel(r.updatedAt) };
      });
    }
  } else if (input.section === "api-keys") {
    items = (await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt))).map(r => ({
      id: r.id, ...owner(r.userId), name: r.name, keyPrefix: r.keyPrefix, scopes: r.scopes,
      status: r.revokedAt ? "REVOKED" : "ACTIVE", createdAt: dateLabel(r.createdAt), lastUsedAt: iso(r.lastUsedAt),
    }));
    activity = (await db.select().from(apiUsage).orderBy(desc(apiUsage.createdAt)).limit(1000)).map(r => ({ ...r, responseStatus: r.status, status: String(r.status), createdAt: dateLabel(r.createdAt) }));
  } else if (input.section === "payment-links") {
    const links = await db.select().from(paymentLinks).orderBy(desc(paymentLinks.createdAt));
    items = links.map(r => ({ ...r, ...owner(r.userId), reference: r.reference ?? undefined, expiresAt: r.expiresAt ?? "", status: r.adminRevokedAt ? "REVOKED" : r.status, createdAt: dateLabel(r.createdAt) }));
    const history = await db.select().from(transactions).where(eq(transactions.type, "Payment")).orderBy(desc(transactions.createdAt));
    activity = history.flatMap(r => {
      const link = links.find(l => r.providerOrderId?.startsWith(`paylink_${l.id}_`));
      return link ? [{ id: r.id, linkId: link.id, amount: r.amount, currency: r.currency, status: r.status, reference: r.reference, createdAt: dateLabel(r.createdAt) }] : [];
    });
  } else if (input.section === "blacklist") {
    items = (await db.select().from(blacklistedPhones).orderBy(desc(blacklistedPhones.createdAt))).map(r => ({
      ...r, merchantName: r.name || allUsers.filter(u => u.phone && profilePhone(u.phone, u.country) === r.phone).map(u => `${u.firstName} ${u.lastName}`).join(", ") || "Numéro bloqué",
      createdAt: dateLabel(r.createdAt),
    }));
  } else if (input.section === "messages") {
    items = (await db.select().from(merchantMessages).orderBy(desc(merchantMessages.createdAt))).map(r => ({ ...r, createdAt: dateLabel(r.createdAt) }));
  } else if (input.section === "notifications") {
    items = (await db.select().from(adminAnnouncements).where(isNull(adminAnnouncements.deletedAt)).orderBy(desc(adminAnnouncements.createdAt))).map(r => ({ ...r, createdAt: dateLabel(r.createdAt) }));
  }
  const q = input.q?.trim().toLocaleLowerCase("fr");
  if (q) items = items.filter(r => [r.id, r.merchantName, r.email, r.name, r.phone, r.keyPrefix, r.reference, r.productName, r.title, r.subject, r.recipient, r.operator, r.country].some(s => s?.toLocaleLowerCase("fr").includes(q)));
  if (input.status) items = items.filter(r => r.status === input.status);
  if (input.country) items = items.filter(r => r.country === input.country || r.source === input.country || r.destination === input.country);
  if (input.type) items = items.filter(r => input.type?.toLowerCase() === "payin" ? ["Deposit", "Payment"].includes(r.type ?? "") : input.type?.toLowerCase() === "payout" ? ["Withdrawal", "Transfer"].includes(r.type ?? "") : r.type === input.type);
  const total = items.length;
  const page = Math.max(1, Math.floor(input.page ?? 1));
  return { section: input.section, items: items.slice((page - 1) * 30, page * 30), total, page, pageSize: 30, activity, stats, currencyTotals,
    settings, telegramConfigured: Boolean(config?.telegramEncrypted || (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)), emailConfigured: emailIsConfigured(), platformTreasuryAvailable: null };
}
