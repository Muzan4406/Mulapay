import { useEffect, useState } from 'react';
import { Ban, Eye, Plus, Save, ShieldOff, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { AdminConsoleRow, AdminCommandInputProvider } from '@workspace/api-client-react';
import { COUNTRIES, fmtDate, fmtMoney, useAdminCommand, useConsole, useDebounced, useIsSuperAdmin } from './lib';
import { ConfirmDialog, Country, DataState, Field, PageHead, Pager, Panel, SearchBox, StatusPill, SuperNotice, Toggle, Toolbar } from './ui';
import { routeOperatorOptions } from './route-options';

const PROVIDERS: AdminCommandInputProvider[] = ['DRIMPAY', 'ASHTECHPAY'];

function useSearchPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => { setPage(1); }, [dq]);
  return { q, setQ, page, setPage, filters: { q: dq, page } };
}

function LimitBar({ row }: { row: AdminConsoleRow }) {
  const used = row.dailyUsed ?? 0;
  if (row.dailyLimit == null) return <div className="ad-limit"><span>Traité aujourd’hui <b className="ad-mono">{fmtMoney(used)}</b></span><small>Sans limite journalière</small></div>;
  const pct = Math.min(100, row.dailyLimit > 0 ? (used / row.dailyLimit) * 100 : 100);
  return <div className="ad-limit"><span>Traité <b className="ad-mono">{fmtMoney(used)}</b> / {fmtMoney(row.dailyLimit)}</span><div className={`ad-bar ${pct > 85 ? 'hot' : ''}`}><i style={{ transform: `scaleX(${pct / 100})` }} /></div><small>Reste {fmtMoney(row.dailyRemaining ?? Math.max(0, row.dailyLimit - used))}</small></div>;
}

function RouteForm({ onDone }: { onDone?: () => void }) {
  const { run, pending: busy } = useAdminCommand();
  const isSuper = useIsSuperAdmin();
  const pending = busy || !isSuper;
  const [f, setF] = useState({ countryCode: 'TG', operator: 'Mixx by Yas', providerOperator: 'tmoney', provider: 'DRIMPAY' as AdminCommandInputProvider, dailyLimit: '', enabled: false });
  const country = COUNTRIES.find(c => c.code === f.countryCode)!;
  const options = routeOperatorOptions(f.provider, f.countryCode);
  const selected = options.find(option => option.operator === f.operator && option.providerOperator === f.providerOperator);
  const selectContext = (countryCode: string, provider: AdminCommandInputProvider) => {
    const first = routeOperatorOptions(provider, countryCode)[0];
    setF(v => ({ ...v, countryCode, provider, operator: first?.operator ?? '', providerOperator: first?.providerOperator ?? '' }));
  };
  return <form className="ad-form-grid three" onSubmit={async e => {
    e.preventDefault();
    if (!selected) return;
    const ok = await run({ action: 'route_update', countryCode: f.countryCode, country: country.name, operator: selected.operator, providerOperator: selected.providerOperator, provider: f.provider, enabled: f.enabled, dailyLimit: f.dailyLimit === '' ? null : Number(f.dailyLimit) });
    if (ok) { setF(v => ({ ...v, dailyLimit: '' })); onDone?.(); }
  }}>
    <Field label="Pays"><select value={f.countryCode} onChange={e => selectContext(e.target.value, f.provider)} data-testid="select-route-country">{COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
    <Field label="Agrégateur"><select value={f.provider} onChange={e => selectContext(f.countryCode, e.target.value as AdminCommandInputProvider)} data-testid="select-route-provider">{PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}</select></Field>
    <Field label="Opérateur Mulapay"><select required value={selected?.providerOperator ?? ''} onChange={e => {
      const option = options.find(item => item.providerOperator === e.target.value);
      setF(v => ({ ...v, operator: option?.operator ?? '', providerOperator: option?.providerOperator ?? '' }));
    }} data-testid="input-route-operator" disabled={options.length === 0}>
      <option value="" disabled>{options.length ? 'Choisir un opérateur' : 'Aucun opérateur disponible'}</option>
      {options.map(option => <option key={option.providerOperator} value={option.providerOperator}>{option.operator} · {option.providerOperator}</option>)}
    </select></Field>
    <Field label={`Code exact ${f.provider === 'DRIMPAY' ? 'DrimPay' : 'AshtechPay'}`} hint="Rempli automatiquement; ne pas modifier"><input readOnly value={selected?.providerOperator ?? ''} data-testid="input-route-provider-operator" /></Field>
    <Field label="Limite journalière (XOF)" hint="Vide = illimitée"><input type="number" min={1} value={f.dailyLimit} onChange={e => setF(v => ({ ...v, dailyLimit: e.target.value }))} data-testid="input-route-limit" /></Field>
    <div className="ad-form-end"><button className="ad-btn ad-btn-primary" type="submit" disabled={pending || !selected} data-testid="button-route-create"><Plus size={14} /> Ajouter l’opérateur</button></div>
    <p className="ad-route-help">Le code affiché est envoyé exactement à l’agrégateur. Toute nouvelle route est créée désactivée; activez-la après avoir configuré le fournisseur.</p>
  </form>;
}

/* ---------------- Providers ---------------- */

export function AdminProviders() {
  const providers = useConsole('providers');
  const routes = useConsole('operators');
  const { run } = useAdminCommand();
  const [toggle, setToggle] = useState<AdminConsoleRow | null>(null);
  const isSuper = useIsSuperAdmin();
  return <main className="ad-page">
    <PageHead eyebrow="Infrastructure de paiement" title="Agrégateurs" note="Activation des PSP et opérateurs routés avec leur consommation journalière." />
    <SuperNotice show={!isSuper} />
    <DataState isLoading={providers.isLoading} error={providers.error} empty={(providers.data?.items.length ?? 0) === 0} onRetry={() => void providers.refetch()} emptyTitle="Aucun agrégateur" rows={2}>
      <div className="ad-provider-grid">{providers.data?.items.map(p => <div className={`ad-provider ${p.enabled ? 'on' : ''}`} key={p.id} data-testid={`card-provider-${p.id}`}>
        <div><span className="ad-eyebrow">{p.id}</span><h3>{p.name ?? p.id}</h3><p>{p.configured ? 'Identifiants serveur configurés' : 'Identifiants serveur manquants'}</p>
          {p.id === 'DRIMPAY' && !p.configured && <p className="ad-dim ad-small">Production uniquement : clé API live, secret webhook associé à cette clé et URL HTTPS publique requis. Aucun mode de test n’est activé. <a href="https://docs.drimpay.com/fr/docs/payin" target="_blank" rel="noreferrer">Guide officiel DrimPay</a></p>}
        </div>
        <div className="ad-provider-foot"><StatusPill status={p.enabled ? 'enabled' : 'disabled'} /><button className={`ad-btn sm ${p.enabled ? 'ad-btn-warn' : 'ad-btn-primary'}`} disabled={!isSuper || (!p.configured && !p.enabled)} onClick={() => setToggle(p)} data-testid={`button-provider-toggle-${p.id}`}>{p.enabled ? 'Désactiver' : 'Activer'}</button></div>
      </div>)}</div>
    </DataState>
    <Panel title="Ajouter un opérateur" note="Pays, opérateur, agrégateur et limite journalière."><RouteForm /></Panel>
    <Panel title="Consommation journalière" note="Montant traité et restant, remis à zéro chaque jour à minuit (Lomé).">
      <DataState isLoading={routes.isLoading} error={routes.error} empty={(routes.data?.items.length ?? 0) === 0} onRetry={() => void routes.refetch()} emptyTitle="Aucun opérateur configuré">
        <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>Pays</th><th>Opérateur</th><th>Agrégateur</th><th>Limite</th><th>Statut</th></tr></thead><tbody>
          {routes.data?.items.map(r => <tr key={r.id}><td><Country value={r.country ?? r.countryCode} /></td><td><strong>{r.operator}</strong></td><td className="ad-mono">{r.provider}</td><td style={{ minWidth: 220 }}><LimitBar row={r} /></td><td><StatusPill status={r.enabled ? 'enabled' : 'disabled'} /></td></tr>)}
        </tbody></table></div>
      </DataState>
    </Panel>
    <ConfirmDialog open={!!toggle} onOpenChange={v => !v && setToggle(null)} title={toggle?.enabled ? `Désactiver ${toggle?.name ?? toggle?.id} ?` : `Activer ${toggle?.name ?? toggle?.id} ?`} description={toggle?.enabled ? 'Les routes utilisant cet agrégateur ne pourront plus traiter de paiements.' : 'Les routes configurées pourront à nouveau utiliser cet agrégateur.'} confirmLabel="Confirmer" tone={toggle?.enabled ? 'danger' : 'primary'} onConfirm={() => run({ action: 'provider_update', targetId: toggle?.id, enabled: !toggle?.enabled })} />
  </main>;
}

/* ---------------- Operators ---------------- */

function RouteRow({ row }: { row: AdminConsoleRow }) {
  const { run, pending: busy } = useAdminCommand();
  const isSuper = useIsSuperAdmin();
  const pending = busy || !isSuper;
  const [f, setF] = useState({ operator: row.operator ?? '', providerOperator: row.providerOperator ?? '', provider: (row.provider ?? 'DRIMPAY') as AdminCommandInputProvider, dailyLimit: row.dailyLimit == null ? '' : String(row.dailyLimit), enabled: !!row.enabled });
  const options = routeOperatorOptions(f.provider, row.countryCode ?? '');
  const selected = options.find(option => option.operator === f.operator && option.providerOperator === f.providerOperator);
  const dirty = f.operator !== (row.operator ?? '') || f.providerOperator !== (row.providerOperator ?? '') || f.provider !== (row.provider ?? 'DRIMPAY') || f.dailyLimit !== (row.dailyLimit == null ? '' : String(row.dailyLimit)) || f.enabled !== !!row.enabled;
  return <div className={`ad-route-card ${dirty ? 'dirty' : ''}`} data-testid={`card-route-${row.id}`}>
    <div className="ad-route-head"><Country value={row.country ?? row.countryCode} /><Toggle label={f.enabled ? 'Actif' : 'Inactif'} checked={f.enabled} onChange={v => setF(p => ({ ...p, enabled: v }))} testId={`toggle-route-${row.id}`} /></div>
    <div className="ad-form-grid four">
      <Field label="Opérateur Mulapay"><select value={selected?.providerOperator ?? ''} onChange={e => {
        const option = options.find(item => item.providerOperator === e.target.value);
        setF(p => ({ ...p, operator: option?.operator ?? '', providerOperator: option?.providerOperator ?? '' }));
      }} data-testid={`input-route-operator-${row.id}`} disabled={options.length === 0}>
        {!selected && <option value="">Choisir un opérateur valide</option>}
        {options.map(option => <option key={option.providerOperator} value={option.providerOperator}>{option.operator} · {option.providerOperator}</option>)}
      </select></Field>
      <Field label={`Code exact ${f.provider === 'DRIMPAY' ? 'DrimPay' : 'AshtechPay'}`}><input readOnly value={selected?.providerOperator ?? ''} /></Field>
      <Field label="Agrégateur"><select value={f.provider} onChange={e => {
        const provider = e.target.value as AdminCommandInputProvider;
        const nextOptions = routeOperatorOptions(provider, row.countryCode ?? '');
        const match = nextOptions.find(option => option.operator === f.operator) ?? nextOptions[0];
        setF(p => ({ ...p, provider, operator: match?.operator ?? '', providerOperator: match?.providerOperator ?? '' }));
      }} data-testid={`select-route-provider-${row.id}`}>{PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}</select></Field>
      <Field label="Limite / jour (XOF)" hint="Vide = illimitée"><input type="number" min={1} value={f.dailyLimit} onChange={e => setF(p => ({ ...p, dailyLimit: e.target.value }))} data-testid={`input-route-limit-${row.id}`} /></Field>
    </div>
    <div className="ad-route-foot"><LimitBar row={row} /><button className="ad-btn ad-btn-primary sm" disabled={!dirty || pending || !selected} onClick={() => void run({ action: 'route_update', targetId: row.id, country: row.country, countryCode: row.countryCode, operator: f.operator, providerOperator: f.providerOperator, provider: f.provider, enabled: f.enabled, dailyLimit: f.dailyLimit === '' ? null : Number(f.dailyLimit) })} data-testid={`button-route-save-${row.id}`}><Save size={13} /> Enregistrer les modifications</button></div>
  </div>;
}

export function MaintenancePanel({ settings }: { settings: { maintenance?: boolean; maintenanceMessage?: string; payinMaintenance?: boolean; payoutMaintenance?: boolean; linksMaintenance?: boolean; apiMaintenance?: boolean } }) {
  const { run, pending: busy } = useAdminCommand();
  const isSuper = useIsSuperAdmin();
  const pending = busy || !isSuper;
  const initial = { maintenance: !!settings.maintenance, maintenanceMessage: settings.maintenanceMessage ?? '', payinMaintenance: !!settings.payinMaintenance, payoutMaintenance: !!settings.payoutMaintenance, linksMaintenance: !!settings.linksMaintenance, apiMaintenance: !!settings.apiMaintenance };
  const [f, setF] = useState(initial);
  const [confirm, setConfirm] = useState(false);
  return <Panel title="Maintenance" note="Générale ou par service. Le message est affiché aux marchands." className={f.maintenance ? 'ad-panel-alert' : ''}>
    <Toggle label="Maintenance générale" hint="Suspend l’ensemble des services marchands" checked={f.maintenance} onChange={v => setF(p => ({ ...p, maintenance: v }))} testId="toggle-maintenance-global" />
    <Field label="Message affiché aux utilisateurs"><textarea value={f.maintenanceMessage} onChange={e => setF(p => ({ ...p, maintenanceMessage: e.target.value }))} placeholder="Ex. Maintenance programmée jusqu’à 14 h (Lomé)." data-testid="input-maintenance-message" /></Field>
    <div className="ad-form-grid two">
      <Toggle label="Dépôts (Payin)" checked={f.payinMaintenance} onChange={v => setF(p => ({ ...p, payinMaintenance: v }))} testId="toggle-maintenance-payin" />
      <Toggle label="Retraits (Payout)" checked={f.payoutMaintenance} onChange={v => setF(p => ({ ...p, payoutMaintenance: v }))} testId="toggle-maintenance-payout" />
      <Toggle label="Liens de paiement" checked={f.linksMaintenance} onChange={v => setF(p => ({ ...p, linksMaintenance: v }))} testId="toggle-maintenance-links" />
      <Toggle label="API / Clés API" checked={f.apiMaintenance} onChange={v => setF(p => ({ ...p, apiMaintenance: v }))} testId="toggle-maintenance-api" />
    </div>
    <button className="ad-btn ad-btn-primary" disabled={pending} onClick={() => setConfirm(true)} data-testid="button-maintenance-save"><Save size={14} /> Enregistrer les modifications</button>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Appliquer la configuration de maintenance ?" description="Les services concernés sont immédiatement affectés pour tous les marchands." confirmLabel="Appliquer" tone={f.maintenance ? 'danger' : 'primary'} onConfirm={() => run({ action: 'settings_update', settings: f })} />
  </Panel>;
}

export function AdminOperators() {
  const query = useConsole('operators');
  const [adding, setAdding] = useState(false);
  const isSuper = useIsSuperAdmin();
  return <main className="ad-page">
    <SuperNotice show={!isSuper} />
    <PageHead eyebrow="Routage" title="Opérateurs par pays" note="Nom, agrégateur, limite et activation de chaque opérateur." action={<button className="ad-btn ad-btn-primary" disabled={!isSuper} onClick={() => setAdding(v => !v)} data-testid="button-toggle-add-route"><Plus size={14} /> Ajouter</button>} />
    {adding && <Panel title="Nouvel opérateur"><RouteForm onDone={() => setAdding(false)} /></Panel>}
    <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucun opérateur" emptyNote="Ajoutez une première route pour un pays.">
      <div className="ad-route-list">{query.data?.items.map(r => <RouteRow key={`${r.id}-${r.provider}-${r.dailyLimit}-${r.enabled}-${r.operator}`} row={r} />)}</div>
    </DataState>
    {query.data && <MaintenancePanel key={JSON.stringify(query.data.settings)} settings={query.data.settings} />}
  </main>;
}

/* ---------------- API keys ---------------- */

export function AdminApiKeys() {
  const s = useSearchPage();
  const query = useConsole('api-keys', s.filters);
  const { run } = useAdminCommand();
  const [detail, setDetail] = useState<AdminConsoleRow | null>(null);
  const [revoke, setRevoke] = useState<AdminConsoleRow | null>(null);
  const activity = (query.data?.activity ?? []).filter(a => a.keyId === detail?.id);
  const isSuper = useIsSuperAdmin();
  return <main className="ad-page">
    <PageHead eyebrow="Accès développeur" title="Clés API marchand" note="Les secrets ne sont jamais affichés : seul le préfixe est conservé." />
    <Toolbar><SearchBox value={s.q} onChange={s.setQ} placeholder="Marchand, nom ou préfixe" /></Toolbar>
    <Panel>
      <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucune clé API">
        <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>Marchand</th><th>Préfixe</th><th>Nom</th><th>Statut</th><th>Créée le</th><th>Dernier usage</th><th /></tr></thead><tbody>
          {query.data?.items.map(k => <tr key={k.id} data-testid={`row-api-key-${k.id}`}><td>{k.merchantName ?? '—'}</td><td className="ad-mono">{k.keyPrefix}…</td><td><strong>{k.name}</strong></td><td><StatusPill status={k.status} /></td><td className="ad-mono">{fmtDate(k.createdAt)}</td><td className="ad-mono">{fmtDate(k.lastUsedAt)}</td>
            <td className="ad-right ad-nowrap"><button className="ad-icon-btn" onClick={() => setDetail(k)} aria-label="Détails" data-testid={`button-api-key-detail-${k.id}`}><Eye size={14} /></button> {(k.status ?? '').toLowerCase() !== 'revoked' && <button className="ad-icon-btn danger" disabled={!isSuper} title={isSuper ? undefined : 'Réservé au SUPER_ADMIN'} onClick={() => setRevoke(k)} aria-label="Révoquer" data-testid={`button-api-key-revoke-${k.id}`}><ShieldOff size={14} /></button>}</td></tr>)}
        </tbody></table></div>
        {query.data && <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={s.setPage} />}
      </DataState>
    </Panel>
    <Dialog open={!!detail} onOpenChange={v => !v && setDetail(null)}>
      <DialogContent className="ad-dialog ad-dialog-wide">
        <DialogHeader><DialogTitle>{detail?.name}</DialogTitle><DialogDescription><span className="ad-mono">{detail?.keyPrefix}…</span> · {detail?.merchantName}</DialogDescription></DialogHeader>
        <div className="ad-kv"><span>Statut</span><StatusPill status={detail?.status} /><span>Créée le</span><b>{fmtDate(detail?.createdAt)}</b><span>Dernier usage</span><b>{fmtDate(detail?.lastUsedAt)}</b><span>Permissions</span><div className="ad-chips">{(detail?.scopes ?? []).length ? detail?.scopes?.map(sc => <span className="ad-tag" key={sc}>{sc}</span>) : <span className="ad-dim">Aucune</span>}</div></div>
        <h3 className="ad-h3">Historique d’utilisation</h3>
        {activity.length === 0 ? <p className="ad-dim">Aucun appel enregistré pour cette clé.</p> : <div className="ad-table-wrap"><table className="ad-table compact"><thead><tr><th>Méthode</th><th>Chemin</th><th>Réponse</th><th>Date</th></tr></thead><tbody>{activity.map(a => <tr key={a.id}><td className="ad-mono">{a.method}</td><td className="ad-mono">{a.path}</td><td><span className={`ad-code ${(a.responseStatus ?? 0) >= 400 ? 'bad' : ''}`}>{a.responseStatus}</span></td><td className="ad-mono">{fmtDate(a.createdAt)}</td></tr>)}</tbody></table></div>}
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={!!revoke} onOpenChange={v => !v && setRevoke(null)} title="Révoquer définitivement cette clé ?" description={`La clé ${revoke?.keyPrefix ?? ''}… de ${revoke?.merchantName ?? ''} cessera immédiatement de fonctionner. Action irréversible.`} confirmLabel="Révoquer" tone="danger" onConfirm={() => run({ action: 'key_revoke', targetId: revoke?.id })} />
  </main>;
}

/* ---------------- Payment links ---------------- */

export function AdminPaymentLinks() {
  const s = useSearchPage();
  const query = useConsole('payment-links', s.filters);
  const { run } = useAdminCommand();
  const [detail, setDetail] = useState<AdminConsoleRow | null>(null);
  const [revoke, setRevoke] = useState<AdminConsoleRow | null>(null);
  const activity = (query.data?.activity ?? []).filter(a => a.linkId === detail?.id);
  const isSuper = useIsSuperAdmin();
  const amountLabel = (l: AdminConsoleRow) => l.amountType === 'CUSTOMER_CHOOSES' ? `${fmtMoney(l.amountMin, l.currency ?? 'XOF')} – ${fmtMoney(l.amountMax, l.currency ?? 'XOF')}` : fmtMoney(l.amount, l.currency ?? 'XOF');
  return <main className="ad-page">
    <PageHead eyebrow="Encaissement" title="Liens de paiement" note="Liens créés par les marchands, utilisation et historique." />
    <Toolbar><SearchBox value={s.q} onChange={s.setQ} placeholder="Marchand, nom ou identifiant" /></Toolbar>
    <Panel>
      <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucun lien de paiement">
        <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>Marchand</th><th>Identifiant</th><th>Nom</th><th className="ad-right">Montant</th><th>Utilisation</th><th>Statut</th><th>Créé le</th><th /></tr></thead><tbody>
          {query.data?.items.map(l => <tr key={l.id} data-testid={`row-link-${l.id}`}><td>{l.merchantName ?? '—'}</td><td className="ad-mono">{l.slug}</td><td><strong>{l.productName ?? l.name}</strong></td><td className="ad-right ad-mono">{amountLabel(l)}</td><td className="ad-mono">{l.payments ?? 0}{l.maxPayments ? ` / ${l.maxPayments}` : ''}</td><td><StatusPill status={l.status} /></td><td className="ad-mono">{fmtDate(l.createdAt)}</td>
            <td className="ad-right ad-nowrap"><button className="ad-icon-btn" onClick={() => setDetail(l)} aria-label="Détails" data-testid={`button-link-detail-${l.id}`}><Eye size={14} /></button> {!['revoked', 'expired', 'disabled'].includes((l.status ?? '').toLowerCase()) && <button className="ad-icon-btn danger" disabled={!isSuper} title={isSuper ? undefined : 'Réservé au SUPER_ADMIN'} onClick={() => setRevoke(l)} aria-label="Désactiver" data-testid={`button-link-revoke-${l.id}`}><Ban size={14} /></button>}</td></tr>)}
        </tbody></table></div>
        {query.data && <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={s.setPage} />}
      </DataState>
    </Panel>
    <Dialog open={!!detail} onOpenChange={v => !v && setDetail(null)}>
      <DialogContent className="ad-dialog ad-dialog-wide">
        <DialogHeader><DialogTitle>{detail?.productName ?? detail?.name}</DialogTitle><DialogDescription><span className="ad-mono">{detail?.slug}</span> · {detail?.merchantName}</DialogDescription></DialogHeader>
        {detail && <div className="ad-kv"><span>Montant</span><b className="ad-mono">{amountLabel(detail)}</b><span>Utilisation</span><b>{detail.payments ?? 0} paiement(s){detail.maxPayments ? ` sur ${detail.maxPayments}` : ' · illimité'}</b><span>Expiration</span><b>{fmtDate(detail.expiresAt)}</b><span>Statut</span><StatusPill status={detail.status} />{detail.description && <><span>Description</span><b>{detail.description}</b></>}</div>}
        <h3 className="ad-h3">Historique des transactions</h3>
        {activity.length === 0 ? <p className="ad-dim">Aucun paiement reçu via ce lien.</p> : <div className="ad-table-wrap"><table className="ad-table compact"><thead><tr><th>Référence</th><th className="ad-right">Montant</th><th>Statut</th><th>Date</th></tr></thead><tbody>{activity.map(a => <tr key={a.id}><td className="ad-mono">{a.reference}</td><td className="ad-right ad-mono">{fmtMoney(a.amount)}</td><td><StatusPill status={a.status} /></td><td className="ad-mono">{fmtDate(a.createdAt)}</td></tr>)}</tbody></table></div>}
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={!!revoke} onOpenChange={v => !v && setRevoke(null)} title="Désactiver définitivement ce lien ?" description={`Le lien ${revoke?.slug ?? ''} n’acceptera plus aucun paiement. Action irréversible.`} confirmLabel="Désactiver" tone="danger" onConfirm={() => run({ action: 'link_revoke', targetId: revoke?.id })} />
  </main>;
}

/* ---------------- Blacklist ---------------- */

export function AdminBlacklist() {
  const s = useSearchPage();
  const query = useConsole('blacklist', s.filters);
  const { run } = useAdminCommand();
  const [form, setForm] = useState({ phone: '', name: '', reason: '' });
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [remove, setRemove] = useState<AdminConsoleRow | null>(null);
  const isSuper = useIsSuperAdmin();
  const phoneOk = /^\+?[0-9 ]{8,18}$/.test(form.phone.trim());
  return <main className="ad-page">
    <PageHead eyebrow="Sécurité" title="Liste noire" note="Un numéro bloqué ne peut plus effectuer de transaction ni utiliser Mulapay." />
    <SuperNotice show={!isSuper} />
    <Panel title="Bloquer un utilisateur">
      <form className="ad-form-grid three" onSubmit={e => { e.preventDefault(); if (phoneOk && form.reason.trim().length >= 3) setConfirmAdd(true); }}>
        <Field label="Numéro de téléphone" hint="Format international, ex. +228 90 00 00 00"><input required value={form.phone} onChange={e => setForm(v => ({ ...v, phone: e.target.value }))} data-testid="input-blacklist-phone" /></Field>
        <Field label="Nom (facultatif)"><input value={form.name} onChange={e => setForm(v => ({ ...v, name: e.target.value }))} data-testid="input-blacklist-name" /></Field>
        <Field label="Motif"><input required minLength={3} value={form.reason} onChange={e => setForm(v => ({ ...v, reason: e.target.value }))} data-testid="input-blacklist-reason" /></Field>
        <div className="ad-form-end"><button className="ad-btn ad-btn-danger" disabled={!isSuper || !phoneOk || form.reason.trim().length < 3} data-testid="button-blacklist-add"><Ban size={14} /> Bloquer</button></div>
      </form>
    </Panel>
    <Toolbar><SearchBox value={s.q} onChange={s.setQ} placeholder="Numéro ou nom" /></Toolbar>
    <Panel>
      <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucun numéro bloqué">
        <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>Nom</th><th>Téléphone</th><th>Motif</th><th>Bloqué le</th><th /></tr></thead><tbody>
          {query.data?.items.map(b => <tr key={b.id} data-testid={`row-blacklist-${b.id}`}><td><strong>{b.name || '—'}</strong></td><td className="ad-mono">{b.phone ?? b.recipient}</td><td>{b.reason ?? '—'}</td><td className="ad-mono">{fmtDate(b.createdAt)}</td><td className="ad-right"><button className="ad-btn ad-btn-ghost sm" disabled={!isSuper} onClick={() => setRemove(b)} data-testid={`button-blacklist-remove-${b.id}`}><Trash2 size={13} /> Débloquer</button></td></tr>)}
        </tbody></table></div>
        {query.data && <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={s.setPage} />}
      </DataState>
    </Panel>
    <ConfirmDialog open={confirmAdd} onOpenChange={setConfirmAdd} title={`Bloquer ${form.phone} ?`} description="Ce numéro ne pourra plus effectuer de transactions sur Mulapay." confirmLabel="Bloquer définitivement" tone="danger" onConfirm={async () => { const ok = await run({ action: 'blacklist_add', recipient: form.phone.trim(), name: form.name.trim() || undefined, reason: form.reason.trim() }); if (ok) setForm({ phone: '', name: '', reason: '' }); return ok; }} />
    <ConfirmDialog open={!!remove} onOpenChange={v => !v && setRemove(null)} title="Débloquer ce numéro ?" description={`${remove?.phone ?? remove?.recipient ?? ''} pourra de nouveau utiliser Mulapay.`} confirmLabel="Débloquer" onConfirm={() => run({ action: 'blacklist_remove', targetId: remove?.id })} />
  </main>;
}

