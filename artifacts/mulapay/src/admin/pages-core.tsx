import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, BadgePercent, Check, Eye, FileImage, Globe2, KeyRound, Pencil, Plus, RotateCcw, ShieldCheck, Trash2, Users, WalletCards, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { AdminConsoleRow } from '@workspace/api-client-react';
import { COUNTRIES, fmtDate, fmtMoney, fmtNumber, useAdminCommand, useConsole, useDebounced, useIsSuperAdmin } from './lib';
import { ConfirmDialog, Country, DataState, Field, FilterSelect, PageHead, Pager, Panel, SearchBox, Stat, StatusPill, SuperNotice, Toggle, Toolbar } from './ui';

const countryOptions = COUNTRIES.map(c => ({ value: c.name, label: c.name }));

function useListFilters() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [country, setCountry] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => { setPage(1); }, [dq, status, country, type]);
  return { q, setQ, status, setStatus, country, setCountry, type, setType, page, setPage, filters: { q: dq, status, country, type, page } };
}

/* ---------------- Dashboard ---------------- */

export function AdminDashboard() {
  const query = useConsole('dashboard');
  const data = query.data;
  const s = data?.stats ?? {};
  const st = (k: string) => s[k];
  const { run } = useAdminCommand();
  const [payinFee, setPayinFee] = useState('');
  const [payoutFee, setPayoutFee] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminConsoleRow | null>(null);
  const [integration, setIntegration] = useState({ merchantId: '', name: '', url: '' });
  const initialized = useRef(false);
  useEffect(() => {
    if (data && !initialized.current) { initialized.current = true; setPayinFee(String(data.settings.payinFee ?? '')); setPayoutFee(String(data.settings.payoutFee ?? '')); }
  }, [data]);

  const isSuper = useIsSuperAdmin();
  const treasury = data?.platformTreasuryAvailable;
  return <main className="ad-page">
    <PageHead eyebrow="Pilotage · fuseau Africa/Lome" title="Tableau de bord" note={data?.settings.statsSince ? `Statistiques de période depuis le ${fmtDate(data.settings.statsSince)}. Les cumuls historiques restent intacts.` : 'Statistiques calculées depuis le lancement. Journées en heure de Lomé (UTC).'} action={<button className="ad-btn ad-btn-ghost" disabled={!isSuper} title={isSuper ? undefined : 'Réservé au SUPER_ADMIN'} onClick={() => setResetOpen(true)} data-testid="button-stats-reset"><RotateCcw size={14} /> Réinitialiser les statistiques</button>} />
    <DataState isLoading={query.isLoading} error={query.error} empty={false} onRetry={() => void query.refetch()} emptyTitle="" rows={8}>
      <div className="ad-hero-row">
        <div className="ad-treasury" data-testid="card-platform-treasury">
          <span className="ad-eyebrow light">Solde de la plateforme</span>
          {treasury === null || treasury === undefined
            ? <><strong className="unavailable">Indisponible</strong><p>Aucune trésorerie PSP vérifiée n’est disponible. Aucun solde n’est estimé.</p></>
            : <><strong>{fmtMoney(treasury)}</strong><p>Trésorerie PSP vérifiée par le serveur.</p></>}
          <div className="ad-treasury-foot"><span>Fonds marchands disponibles (total wallets)</span><b data-testid="text-merchant-funds">{fmtMoney(st('availableMerchantFunds'))}</b></div>
        </div>
        <div className="ad-stat-grid">
          <Stat label="Total marchands" value={fmtNumber(st('merchants'))} icon={<Users size={15} />} testId="stat-merchants" />
          <Stat label="Marchands vérifiés" value={fmtNumber(st('verifiedMerchants'))} icon={<ShieldCheck size={15} />} tone="teal" testId="stat-verified" />
          <Stat label="KYC en attente" value={fmtNumber(st('pendingKyc'))} tone="amber" hint="Dossiers à examiner" testId="stat-pending-kyc" />
          <Stat label="Échanges en file" value={fmtNumber(st('exchangeQueue'))} tone="amber" testId="stat-exchange-queue" />
        </div>
      </div>
      <div className="ad-stat-grid wide">
        <Stat label="Montant total des transactions" value={fmtMoney(st('totalVolume'))} icon={<Activity size={15} />} hint={st('statsVolume') !== undefined ? `Période : ${fmtMoney(st('statsVolume'))}` : 'Historique complet'} testId="stat-volume" />
        <Stat label="Total dépôts" value={fmtMoney(st('totalDeposits'))} icon={<ArrowDownLeft size={15} />} testId="stat-deposits" />
        <Stat label="Total retraits" value={fmtMoney(st('totalWithdrawals'))} icon={<ArrowUpRight size={15} />} testId="stat-withdrawals" />
        <Stat label="Payin aujourd’hui" value={fmtMoney(st('payinTodayAmount'))} hint={`${fmtNumber(st('payinTodayCount'))} opération(s)`} tone="teal" testId="stat-payin-today" />
        <Stat label="Payout aujourd’hui" value={fmtMoney(st('payoutTodayAmount'))} hint={`${fmtNumber(st('payoutTodayCount'))} opération(s)`} tone="ink" testId="stat-payout-today" />
        <Stat label="Commission du jour" value={fmtMoney(st('commissionToday'))} icon={<BadgePercent size={15} />} testId="stat-commission-today" />
        <Stat label="Commission totale" value={fmtMoney(st('commissionTotal'))} hint={st('statsCommission') !== undefined ? `Période : ${fmtMoney(st('statsCommission'))}` : 'Depuis le lancement'} testId="stat-commission-total" />
        <Stat label="Frais d’échange wallet" value={fmtMoney(st('exchangeFees'))} testId="stat-exchange-fees" />
      </div>
      <div className="ad-split">
        <Panel title="Frais globaux" note={isSuper ? 'Appliqués aux marchands sans taux personnalisé.' : 'Modification réservée au SUPER_ADMIN.'}>
          <div className="ad-form-grid two">
            <Field label="Frais Payin (%)"><input type="number" step="0.01" min={0} max={100} value={payinFee} onChange={e => setPayinFee(e.target.value)} data-testid="input-dashboard-payin-fee" /></Field>
            <Field label="Frais Payout (%)"><input type="number" step="0.01" min={0} max={100} value={payoutFee} onChange={e => setPayoutFee(e.target.value)} data-testid="input-dashboard-payout-fee" /></Field>
          </div>
          <button className="ad-btn ad-btn-primary" disabled={!isSuper || payinFee === '' || payoutFee === ''} onClick={() => void run({ action: 'settings_update', settings: { payinFee: Number(payinFee), payoutFee: Number(payoutFee) } })} data-testid="button-save-dashboard-fees"><Check size={14} /> Enregistrer les modifications</button>
        </Panel>
        <Panel title="Totaux par devise" note="Soldes agrégés des wallets marchands, par devise.">
          {(data?.currencyTotals ?? []).length === 0 ? <p className="ad-dim">Aucun wallet enregistré.</p> : <div className="ad-mini-list">{data?.currencyTotals?.map((row, i) => <div key={`${row.currency}-${i}`}><span className="ad-tag">{row.currency}</span><span className="ad-mono">{fmtMoney(row.available ?? row.balance, row.currency)}</span></div>)}</div>}
        </Panel>
      </div>
      <Panel title="Sites utilisant l’API" note="Intégrations déclarées par l’administration pour un marchand." action={<span className="ad-count">{data?.items.length ?? 0}</span>}>
        <form className="ad-inline-form" onSubmit={async e => { e.preventDefault(); if (await run({ action: 'integration_create', targetId: integration.merchantId.trim(), name: integration.name.trim(), url: integration.url.trim() })) setIntegration({ merchantId: '', name: '', url: '' }); }}>
          <input placeholder="ID marchand" value={integration.merchantId} onChange={e => setIntegration(v => ({ ...v, merchantId: e.target.value }))} required data-testid="input-integration-merchant" />
          <input placeholder="Nom du site ou de l’application" value={integration.name} onChange={e => setIntegration(v => ({ ...v, name: e.target.value }))} required data-testid="input-integration-name" />
          <input type="url" placeholder="https://" value={integration.url} onChange={e => setIntegration(v => ({ ...v, url: e.target.value }))} required data-testid="input-integration-url" />
          <button className="ad-btn ad-btn-primary" data-testid="button-integration-create"><Plus size={14} /> Déclarer</button>
        </form>
        {(data?.items ?? []).length === 0 ? <p className="ad-dim">Aucun site déclaré pour le moment.</p> :
          <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>Site</th><th>URL</th><th>Marchand</th><th>Déclaré le</th><th /></tr></thead><tbody>
            {data?.items.map(item => <tr key={item.id} data-testid={`row-integration-${item.id}`}><td><strong>{item.name}</strong></td><td><a className="ad-link" href={item.url} target="_blank" rel="noreferrer">{item.url}</a></td><td>{item.merchantName ?? '—'}</td><td className="ad-mono">{fmtDate(item.createdAt)}</td><td className="ad-right"><button className="ad-icon-btn danger" onClick={() => setDeleteTarget(item)} aria-label="Supprimer" data-testid={`button-integration-delete-${item.id}`}><Trash2 size={14} /></button></td></tr>)}
          </tbody></table></div>}
      </Panel>
      <Panel title="Dernières transactions" note="Mouvements réels enregistrés dans le ledger.">
        {(data?.activity ?? []).length === 0 ? <p className="ad-dim">Aucune transaction enregistrée.</p> : <TransactionTable rows={data?.activity ?? []} />}
      </Panel>
    </DataState>
    <ConfirmDialog open={resetOpen} onOpenChange={setResetOpen} title="Réinitialiser les statistiques ?" description="Les compteurs de période repartent de maintenant. Aucune donnée financière ni aucun historique n’est supprimé." confirmLabel="Réinitialiser" tone="danger" onConfirm={() => run({ action: 'stats_reset' })} />
    <ConfirmDialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)} title="Retirer ce site ?" description={`${deleteTarget?.name ?? ''} ne sera plus listé parmi les intégrations.`} confirmLabel="Supprimer" tone="danger" onConfirm={() => run({ action: 'integration_delete', targetId: deleteTarget?.id })} />
  </main>;
}

function TransactionTable({ rows }: { rows: AdminConsoleRow[] }) {
  return <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>ID / Référence</th><th>Marchand</th><th>Type</th><th className="ad-right">Montant</th><th className="ad-right">Frais</th><th>Pays</th><th>Opérateur</th><th>Statut</th><th>Date</th></tr></thead><tbody>
    {rows.map(t => <tr key={t.id} data-testid={`row-transaction-${t.id}`}>
      <td><span className="ad-mono ad-id">{t.id.slice(0, 10)}</span><small className="ad-sub ad-mono">{t.reference ?? '—'}</small></td>
      <td>{t.merchantName ?? '—'}</td>
      <td><span className="ad-tag">{t.type ?? '—'}</span></td>
      <td className="ad-right ad-mono">{fmtMoney(t.amount, t.currency ?? 'XOF')}</td>
      <td className="ad-right ad-mono ad-dim">{fmtMoney(t.fee, t.currency ?? 'XOF')}</td>
      <td><Country value={t.country} /></td>
      <td>{t.operator ?? '—'}</td>
      <td><StatusPill status={t.status} /></td>
      <td className="ad-mono">{fmtDate(t.createdAt)}</td>
    </tr>)}
  </tbody></table></div>;
}

/* ---------------- Merchants ---------------- */

export function AdminMerchants() {
  const f = useListFilters();
  const query = useConsole('merchants', f.filters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = query.data?.items.find(m => m.id === selectedId) ?? null;
  return <main className="ad-page">
    <PageHead eyebrow="Comptes" title="Marchands" note="Profils, frais personnalisés, accès Payin/Payout et wallets." />
    <Toolbar>
      <SearchBox value={f.q} onChange={f.setQ} placeholder="ID, nom ou e-mail" />
      <FilterSelect label="Statut" value={f.status} onChange={f.setStatus} testId="select-merchant-status" options={[{ value: 'ACTIVE', label: 'Actif' }, { value: 'SUSPENDED', label: 'Suspendu' }, { value: 'DELETED', label: 'Supprimé' }]} />
      <FilterSelect label="Pays" value={f.country} onChange={f.setCountry} testId="select-merchant-country" options={countryOptions} />
    </Toolbar>
    <Panel>
      <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucun marchand trouvé" emptyNote="Modifiez la recherche ou les filtres.">
        <div className={`ad-table-wrap ${query.isFetching ? 'is-fetching' : ''}`}><table className="ad-table"><thead><tr><th>Marchand</th><th>Pays</th><th>KYC</th><th className="ad-right">Solde</th><th>Payin / Payout</th><th>Statut</th><th>Inscription</th><th /></tr></thead><tbody>
          {query.data?.items.map(m => <tr key={m.id} className="ad-clickable" onClick={() => setSelectedId(m.id)} data-testid={`row-merchant-${m.id}`}>
            <td><strong>{m.name ?? `${m.firstName ?? ''} ${m.lastName ?? ''}`}</strong><small className="ad-sub">{m.email}</small><small className="ad-sub ad-mono">{m.id}</small></td>
            <td><Country value={m.country} /></td>
            <td><StatusPill status={m.kycStatus} /></td>
            <td className="ad-right ad-mono">{fmtMoney(m.balance)}<small className="ad-sub">dispo {fmtMoney(m.available)}</small></td>
            <td><span className={`ad-flag ${m.payinEnabled ? 'on' : ''}`}>IN</span><span className={`ad-flag ${m.payoutEnabled ? 'on' : ''}`}>OUT</span></td>
            <td><StatusPill status={m.status} /></td>
            <td className="ad-mono">{fmtDate(m.createdAt, false)}</td>
            <td className="ad-right"><button className="ad-icon-btn" aria-label="Gérer" data-testid={`button-merchant-open-${m.id}`}><Pencil size={14} /></button></td>
          </tr>)}
        </tbody></table></div>
        {query.data && <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={f.setPage} />}
      </DataState>
    </Panel>
    <Dialog open={!!selected} onOpenChange={v => !v && setSelectedId(null)}>
      <DialogContent className="ad-dialog ad-dialog-wide">
        {selected && <MerchantEditor key={selected.id} merchant={selected} onClose={() => setSelectedId(null)} />}
      </DialogContent>
    </Dialog>
  </main>;
}

function MerchantEditor({ merchant, onClose }: { merchant: AdminConsoleRow; onClose: () => void }) {
  const { run, pending } = useAdminCommand();
  const [form, setForm] = useState({ firstName: merchant.firstName ?? '', lastName: merchant.lastName ?? '', email: merchant.email ?? '', country: merchant.country ?? '', payinFee: merchant.payinFee == null ? '' : String(merchant.payinFee), payoutFee: merchant.payoutFee == null ? '' : String(merchant.payoutFee), payinEnabled: merchant.payinEnabled ?? true, payoutEnabled: merchant.payoutEnabled ?? true });
  const [confirm, setConfirm] = useState<null | 'suspend' | 'activate' | 'delete' | 'password'>(null);
  const isSuper = useIsSuperAdmin();
  const status = (merchant.status ?? '').toUpperCase();
  const suspended = status === 'SUSPENDED';
  const deleted = status === 'DELETED';
  const locked = !isSuper || deleted;
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm(p => ({ ...p, [k]: v }));
  const save = () => run({ action: 'merchant_update', targetId: merchant.id, firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim(), country: form.country, payinFee: form.payinFee === '' ? null : Number(form.payinFee), payoutFee: form.payoutFee === '' ? null : Number(form.payoutFee), payinEnabled: form.payinEnabled, payoutEnabled: form.payoutEnabled });
  return <>
    <DialogHeader><DialogTitle>{merchant.name ?? `${merchant.firstName} ${merchant.lastName}`}</DialogTitle><DialogDescription><span className="ad-mono">{merchant.id}</span> · inscrit le {fmtDate(merchant.createdAt, false)} · <StatusPill status={merchant.status} /></DialogDescription></DialogHeader>
    <SuperNotice show={!isSuper} />
    {deleted && <p className="ad-dim">Compte supprimé : seules les données historiques restent consultables.</p>}
    <div className="ad-editor">
      <section>
        <h3>Profil</h3>
        <div className="ad-form-grid two">
          <Field label="Prénom"><input value={form.firstName} onChange={e => set('firstName', e.target.value)} data-testid="input-merchant-firstname" /></Field>
          <Field label="Nom"><input value={form.lastName} onChange={e => set('lastName', e.target.value)} data-testid="input-merchant-lastname" /></Field>
          <Field label="E-mail"><input type="email" value={form.email} onChange={e => set('email', e.target.value)} data-testid="input-merchant-email" /></Field>
          <Field label="Pays"><select value={form.country} onChange={e => set('country', e.target.value)} data-testid="select-merchant-country-edit">{!COUNTRIES.some(c => c.name === form.country) && form.country && <option value={form.country}>{form.country}</option>}{COUNTRIES.map(c => <option key={c.code} value={c.name}>{c.name}</option>)}</select></Field>
        </div>
        <h3>Frais personnalisés</h3>
        <div className="ad-form-grid two">
          <Field label="Payin (%)" hint="Vide = taux global"><input type="number" step="0.01" min={0} max={100} value={form.payinFee} onChange={e => set('payinFee', e.target.value)} placeholder="Global" data-testid="input-merchant-payin-fee" /></Field>
          <Field label="Payout (%)" hint="Vide = taux global"><input type="number" step="0.01" min={0} max={100} value={form.payoutFee} onChange={e => set('payoutFee', e.target.value)} placeholder="Global" data-testid="input-merchant-payout-fee" /></Field>
        </div>
        <Toggle label="Opérations Payin" hint="Dépôts, liens et API d’encaissement" checked={form.payinEnabled} onChange={v => set('payinEnabled', v)} testId="toggle-merchant-payin" />
        <Toggle label="Opérations Payout" hint="Retraits et transferts sortants" checked={form.payoutEnabled} onChange={v => set('payoutEnabled', v)} testId="toggle-merchant-payout" />
        <button className="ad-btn ad-btn-primary ad-full" disabled={pending || locked} onClick={() => void save()} data-testid="button-merchant-save"><Check size={14} /> Enregistrer les modifications</button>
      </section>
      <section>
        <h3>Wallets</h3>
        {(merchant.wallets ?? []).length === 0 ? <p className="ad-dim">Aucun wallet.</p> : merchant.wallets?.map(w => <WalletAdjust key={w.id} wallet={w} disabled={locked} />)}
        <h3>Accès et compte</h3>
        <div className="ad-action-stack">
          <button className="ad-btn ad-btn-ghost" disabled={deleted} onClick={() => setConfirm('password')} data-testid="button-merchant-password"><KeyRound size={14} /> Réinitialiser le mot de passe</button>
          {suspended
            ? <button className="ad-btn ad-btn-ghost" disabled={locked} onClick={() => setConfirm('activate')} data-testid="button-merchant-activate"><Check size={14} /> Réactiver le compte</button>
            : <button className="ad-btn ad-btn-warn" disabled={locked} onClick={() => setConfirm('suspend')} data-testid="button-merchant-suspend"><X size={14} /> Suspendre le compte</button>}
          <button className="ad-btn ad-btn-danger" disabled={locked} onClick={() => setConfirm('delete')} data-testid="button-merchant-delete"><Trash2 size={14} /> Supprimer définitivement</button>
        </div>
        <p className="ad-dim ad-small">Les historiques financiers sont conservés en cas de suspension ou de suppression.</p>
      </section>
    </div>
    <ConfirmDialog open={confirm === 'password'} onOpenChange={v => !v && setConfirm(null)} title="Envoyer la procédure de récupération ?" description="Un e-mail guidera le marchand vers la récupération Clerk. Son mot de passe actuel reste inchangé tant qu’il n’a pas terminé cette procédure." confirmLabel="Envoyer la procédure" onConfirm={() => run({ action: 'password_reset', targetId: merchant.id })} />
    <ConfirmDialog open={confirm === 'suspend'} onOpenChange={v => !v && setConfirm(null)} title="Suspendre ce compte ?" description="Le marchand ne pourra plus effectuer d’opérations jusqu’à sa réactivation." confirmLabel="Suspendre" tone="danger" reason={{ label: 'Motif de suspension', required: true }} onConfirm={r => run({ action: 'merchant_suspend', targetId: merchant.id, reason: r })} />
    <ConfirmDialog open={confirm === 'activate'} onOpenChange={v => !v && setConfirm(null)} title="Réactiver ce compte ?" description="Le marchand retrouve l’accès à ses opérations." confirmLabel="Réactiver" onConfirm={() => run({ action: 'merchant_activate', targetId: merchant.id })} />
    <ConfirmDialog open={confirm === 'delete'} onOpenChange={v => !v && setConfirm(null)} title="Supprimer définitivement ?" description="L’accès du marchand est supprimé. Les transactions et le ledger restent conservés." confirmLabel="Supprimer" tone="danger" typeToConfirm="SUPPRIMER" reason={{ label: 'Motif', required: true }} onConfirm={async r => { const ok = await run({ action: 'merchant_delete', targetId: merchant.id, reason: r }); if (ok) onClose(); return ok; }} />
  </>;
}

function WalletAdjust({ wallet, disabled }: { wallet: NonNullable<AdminConsoleRow['wallets']>[number]; disabled: boolean }) {
  const { run } = useAdminCommand();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const keyRef = useRef<string | null>(null);
  const reset = () => { keyRef.current = null; };
  const valid = /^\d+$/.test(amount) && Number(amount) >= 1 && reason.trim().length >= 3;
  return <div className="ad-wallet">
    <div className="ad-wallet-row"><Country value={wallet.country} /><div className="ad-right"><strong className="ad-mono">{fmtMoney(wallet.balance, wallet.currency)}</strong><small className="ad-sub">en attente {fmtMoney(wallet.pending, wallet.currency)}</small></div><button className="ad-btn ad-btn-ghost sm" disabled={disabled} onClick={() => setOpen(true)} data-testid={`button-wallet-adjust-${wallet.id}`}><WalletCards size={13} /> Ajuster</button></div>
    <ConfirmDialog open={open} onOpenChange={v => { setOpen(v); if (!v) { setAmount(''); setReason(''); reset(); } }} title={`Ajuster le wallet ${wallet.country}`} description={`Solde actuel ${fmtMoney(wallet.balance, wallet.currency)}. L’écriture est journalisée et protégée contre les doublons.`} confirmLabel={direction === 'credit' ? 'Créditer' : 'Débiter'} tone={direction === 'debit' ? 'danger' : 'primary'}
      onConfirm={async () => {
        if (!valid) return false;
        if (!keyRef.current) keyRef.current = crypto.randomUUID();
        const ok = await run({ action: 'wallet_adjust', walletId: wallet.id, direction, amount: Number(amount), reason: reason.trim(), idempotencyKey: keyRef.current });
        if (ok) { reset(); setAmount(''); setReason(''); }
        return ok;
      }}>
      <div className="ad-seg"><button type="button" className={direction === 'credit' ? 'on' : ''} onClick={() => { setDirection('credit'); reset(); }} data-testid="button-direction-credit">Crédit</button><button type="button" className={direction === 'debit' ? 'on' : ''} onClick={() => { setDirection('debit'); reset(); }} data-testid="button-direction-debit">Débit</button></div>
      <Field label={`Montant entier (${wallet.currency})`}><input inputMode="numeric" value={amount} onChange={e => { setAmount(e.target.value.replace(/\D/g, '')); reset(); }} data-testid="input-wallet-amount" /></Field>
      <Field label="Motif (obligatoire)"><textarea value={reason} onChange={e => { setReason(e.target.value); reset(); }} data-testid="input-wallet-reason" /></Field>
    </ConfirmDialog>
  </div>;
}

/* ---------------- KYC ---------------- */

const DOC_LABELS: Record<string, string> = { document_front: 'Pièce d’identité — recto', document_back: 'Pièce d’identité — verso', face_capture: 'Photo avec la pièce' };

function docUrl(url: string) {
  if (/^https?:/i.test(url)) return url;
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return url.startsWith(base + '/') || !base ? url : `${base}${url}`;
}

export function AdminKyc() {
  const f = useListFilters();
  const query = useConsole('kyc', f.filters);
  const { run } = useAdminCommand();
  const [docs, setDocs] = useState<AdminConsoleRow | null>(null);
  const [decision, setDecision] = useState<{ row: AdminConsoleRow; kind: 'approve' | 'reject' } | null>(null);
  return <main className="ad-page">
    <PageHead eyebrow="Conformité" title="Vérification KYC" note="Consultez les trois captures avant toute décision." />
    <Toolbar>
      <SearchBox value={f.q} onChange={f.setQ} placeholder="ID, nom ou e-mail" />
      <FilterSelect label="Statut" value={f.status} onChange={f.setStatus} testId="select-kyc-status" options={[{ value: 'EN_ATTENTE', label: 'En attente' }, { value: 'A_REVOIR', label: 'À revoir' }, { value: 'VERIFIE', label: 'Approuvé' }, { value: 'REFUSE', label: 'Rejeté' }]} />
    </Toolbar>
    <Panel>
      <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucune demande KYC" emptyNote="Les dossiers soumis apparaîtront ici.">
        <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>Marchand</th><th>Pays</th><th>Soumis le</th><th>Statut</th><th>Documents</th><th className="ad-right">Décision</th></tr></thead><tbody>
          {query.data?.items.map(k => { const pending = ['EN_ATTENTE', 'A_REVOIR'].includes((k.status ?? '').toUpperCase()); return <tr key={k.id} data-testid={`row-kyc-${k.id}`}>
            <td><strong>{k.merchantName ?? k.name}</strong><small className="ad-sub">{k.email}</small><small className="ad-sub ad-mono">{k.userId ?? k.id}</small></td>
            <td><Country value={k.country} /></td>
            <td className="ad-mono">{fmtDate(k.createdAt)}</td>
            <td><StatusPill status={k.status} /></td>
            <td><button className="ad-btn ad-btn-ghost sm" onClick={() => setDocs(k)} data-testid={`button-kyc-docs-${k.id}`}><Eye size={13} /> {k.documents?.length ?? 0} capture(s)</button></td>
            <td className="ad-right ad-nowrap">{pending ? <><button className="ad-btn ad-btn-primary sm" onClick={() => setDecision({ row: k, kind: 'approve' })} data-testid={`button-kyc-approve-${k.id}`}><Check size={13} /> Approuver</button> <button className="ad-btn ad-btn-danger sm" onClick={() => setDecision({ row: k, kind: 'reject' })} data-testid={`button-kyc-reject-${k.id}`}><X size={13} /> Rejeter</button></> : <span className="ad-dim">Traité</span>}</td>
          </tr>; })}
        </tbody></table></div>
        {query.data && <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={f.setPage} />}
      </DataState>
    </Panel>
    <Dialog open={!!docs} onOpenChange={v => !v && setDocs(null)}>
      <DialogContent className="ad-dialog ad-dialog-wide">
        <DialogHeader><DialogTitle>Documents de {docs?.merchantName ?? docs?.name}</DialogTitle><DialogDescription>Fichiers servis par l’API authentifiée.</DialogDescription></DialogHeader>
        <div className="ad-docs">{(docs?.documents ?? []).length === 0 ? <p className="ad-dim">Aucun document disponible.</p> : docs?.documents?.map(d => <a key={d.kind + d.fileName} href={docUrl(d.url)} target="_blank" rel="noreferrer" className="ad-doc" data-testid={`link-kyc-doc-${d.kind}`}><img src={docUrl(d.url)} alt={DOC_LABELS[d.kind] ?? d.kind} /><span><FileImage size={13} /> {DOC_LABELS[d.kind] ?? d.kind}</span><small>{d.fileName}</small></a>)}</div>
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={decision?.kind === 'approve'} onOpenChange={v => !v && setDecision(null)} title="Approuver ce KYC ?" description={`Le compte de ${decision?.row.merchantName ?? ''} sera marqué vérifié.`} confirmLabel="Approuver" reason={{ label: 'Note interne (facultatif)' }} onConfirm={r => run({ action: 'kyc_approve', targetId: decision?.row.id, reason: r || undefined })} />
    <ConfirmDialog open={decision?.kind === 'reject'} onOpenChange={v => !v && setDecision(null)} title="Rejeter ce KYC ?" description="Le motif sera communiqué au marchand." confirmLabel="Rejeter" tone="danger" reason={{ label: 'Motif du rejet', required: true, placeholder: 'Ex. photo floue, document expiré' }} onConfirm={r => run({ action: 'kyc_reject', targetId: decision?.row.id, reason: r })} />
  </main>;
}

/* ---------------- Transactions ---------------- */

export function AdminTransactions() {
  const f = useListFilters();
  const query = useConsole('transactions', f.filters);
  return <main className="ad-page">
    <PageHead eyebrow="Ledger" title="Transactions" note="Toutes les opérations de la plateforme, en heure de Lomé." />
    <Toolbar>
      <SearchBox value={f.q} onChange={f.setQ} placeholder="ID, marchand ou référence" />
      <FilterSelect label="Type" value={f.type} onChange={f.setType} testId="select-transaction-type" options={[{ value: 'payin', label: 'Payin' }, { value: 'payout', label: 'Payout' }]} />
      <FilterSelect label="Statut" value={f.status} onChange={f.setStatus} testId="select-transaction-status" options={[{ value: 'Pending', label: 'En attente' }, { value: 'Completed', label: 'Réussie' }, { value: 'Failed', label: 'Échouée' }, { value: 'Cancelled', label: 'Annulée' }]} />
      <FilterSelect label="Pays" value={f.country} onChange={f.setCountry} testId="select-transaction-country" options={countryOptions} />
    </Toolbar>
    <Panel>
      <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucune transaction" emptyNote="Aucun mouvement ne correspond à ces critères.">
        <div className={query.isFetching ? 'is-fetching' : ''}><TransactionTable rows={query.data?.items ?? []} /></div>
        {query.data && <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={f.setPage} />}
      </DataState>
    </Panel>
  </main>;
}

/* ---------------- Wallets ---------------- */

export function AdminWallets() {
  const query = useConsole('wallets');
  const s = query.data?.stats ?? {};
  return <main className="ad-page">
    <PageHead eyebrow="Réseau" title="Wallet par pays" note="Disponibilités agrégées des wallets marchands par pays." />
    <DataState isLoading={query.isLoading} error={query.error} empty={false} onRetry={() => void query.refetch()} emptyTitle="">
      <div className="ad-stat-grid">
        <Stat label="Total des wallets" value={fmtNumber(s.walletCount)} icon={<WalletCards size={15} />} testId="stat-wallet-count" />
        <Stat label="Pays couverts" value={fmtNumber(s.countryCount)} icon={<Globe2 size={15} />} tone="ink" testId="stat-country-count" />
        <Stat label="Wallets actifs" value={fmtNumber(s.activeWallets)} tone="teal" testId="stat-active-wallets" />
        <Stat label="Fonds marchands disponibles" value={fmtMoney(s.availableMerchantFunds)} tone="amber" hint="Total XOF · autres devises séparées ci-dessous" testId="stat-merchant-funds" />
      </div>
      <Panel title="Totaux par devise" note="Chaque devise est totalisée séparément.">
        {(query.data?.currencyTotals ?? []).length === 0 ? <p className="ad-dim">Aucun total disponible.</p> : <div className="ad-country-grid">{query.data?.currencyTotals?.map((row, i) => <div className="ad-country-card" key={`${row.currency}-${i}`} data-testid={`card-currency-${row.currency}`}><span className="ad-tag">{row.currency}</span><strong className="ad-mono">{fmtMoney(row.available ?? row.balance, row.currency ?? 'XOF')}</strong><small className="ad-sub">Solde {fmtMoney(row.balance, row.currency ?? 'XOF')} · en attente {fmtMoney(row.pending, row.currency ?? 'XOF')}{row.count !== undefined ? ` · ${row.count} wallet(s)` : ''}</small></div>)}</div>}
      </Panel>
      <Panel title="Pays couverts" note="Drapeau, devise et solde par pays.">
        {(query.data?.items ?? []).length === 0 ? <p className="ad-dim">Aucun pays enregistré.</p> :
          <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>Pays</th><th>Code</th><th>Devise</th><th className="ad-right">Solde</th><th className="ad-right">En attente</th><th className="ad-right">Disponible</th><th className="ad-right">Wallets</th><th className="ad-right">Actifs</th></tr></thead><tbody>
             {query.data?.items.map(row => <tr key={row.id} data-testid={`row-country-wallet-${row.code ?? row.id}`}><td><Country value={row.country ?? row.code} /></td><td className="ad-mono">{row.code ?? row.countryCode ?? '—'}</td><td><span className="ad-tag">{row.currency ?? '—'}</span></td><td className="ad-right ad-mono">{fmtMoney(row.balance, row.currency ?? 'XOF')}</td><td className="ad-right ad-mono ad-dim">{fmtMoney(row.pending, row.currency ?? 'XOF')}</td><td className="ad-right ad-mono"><strong>{fmtMoney(row.available, row.currency ?? 'XOF')}</strong></td><td className="ad-right ad-mono">{fmtNumber(row.count)}</td><td className="ad-right ad-mono">{fmtNumber(row.active)}</td></tr>)}
          </tbody></table></div>}
      </Panel>
    </DataState>
  </main>;
}

/* ---------------- Exchanges ---------------- */

export function AdminExchanges() {
  const f = useListFilters();
  const query = useConsole('exchanges', f.filters);
  const { run } = useAdminCommand();
  const [decision, setDecision] = useState<{ row: AdminConsoleRow; kind: 'approve' | 'reject' } | null>(null);
  return <main className="ad-page">
    <PageHead eyebrow="File de décision" title="Échange wallet" note="Demandes de conversion entre wallets marchands, historique complet conservé." />
    <Toolbar>
      <SearchBox value={f.q} onChange={f.setQ} placeholder="Marchand ou ID" />
      <FilterSelect label="Statut" value={f.status} onChange={f.setStatus} testId="select-exchange-status" options={[{ value: 'PENDING_ADMIN', label: 'À examiner' }, { value: 'COMPLETED', label: 'Approuvé' }, { value: 'REJECTED', label: 'Rejeté' }]} />
      <FilterSelect label="Pays" value={f.country} onChange={f.setCountry} testId="select-exchange-country" options={countryOptions} />
    </Toolbar>
    <Panel>
      <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucune demande d’échange" emptyNote="Les demandes des marchands apparaîtront ici.">
        <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>ID</th><th>Marchand</th><th>Source → Destination</th><th className="ad-right">Montant</th><th className="ad-right">Frais</th><th className="ad-right">À recevoir</th><th>Statut</th><th>Date</th><th className="ad-right">Décision</th></tr></thead><tbody>
          {query.data?.items.map(x => { const open = (x.status ?? '').toUpperCase() === 'PENDING_ADMIN'; return <tr key={x.id} data-testid={`row-exchange-${x.id}`}>
            <td className="ad-mono ad-id">{x.id.slice(0, 10)}</td>
            <td>{x.merchantName ?? '—'}</td>
            <td><span className="ad-route"><Country value={x.source} /><span>→</span><Country value={x.destination} /></span></td>
            <td className="ad-right ad-mono">{fmtMoney(x.amount)}</td>
            <td className="ad-right ad-mono ad-dim">{fmtMoney(x.fee)}</td>
            <td className="ad-right ad-mono"><strong>{fmtMoney(x.receivedAmount)}</strong></td>
            <td><StatusPill status={x.status} /></td>
            <td className="ad-mono">{fmtDate(x.requestedAt)}</td>
            <td className="ad-right ad-nowrap">{open ? <><button className="ad-btn ad-btn-primary sm" onClick={() => setDecision({ row: x, kind: 'approve' })} data-testid={`button-exchange-approve-${x.id}`}><Check size={13} /> Approuver</button> <button className="ad-btn ad-btn-danger sm" onClick={() => setDecision({ row: x, kind: 'reject' })} data-testid={`button-exchange-reject-${x.id}`}><X size={13} /> Rejeter</button></> : <span className="ad-dim">Clôturé</span>}</td>
          </tr>; })}
        </tbody></table></div>
        {query.data && <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={f.setPage} />}
      </DataState>
    </Panel>
    <ConfirmDialog open={decision?.kind === 'approve'} onOpenChange={v => !v && setDecision(null)} title="Approuver cet échange ?" description={`${fmtMoney(decision?.row.amount)} débités de ${decision?.row.source ?? ''}, ${fmtMoney(decision?.row.receivedAmount)} crédités sur ${decision?.row.destination ?? ''}.`} confirmLabel="Approuver" reason={{ label: 'Note (facultatif)' }} onConfirm={r => run({ action: 'exchange_approve', targetId: decision?.row.id, reason: r || undefined })} />
    <ConfirmDialog open={decision?.kind === 'reject'} onOpenChange={v => !v && setDecision(null)} title="Rejeter cet échange ?" description="Les fonds réservés sont restitués au wallet source." confirmLabel="Rejeter" tone="danger" reason={{ label: 'Motif du rejet', required: true }} onConfirm={r => run({ action: 'exchange_reject', targetId: decision?.row.id, reason: r })} />
  </main>;
}
