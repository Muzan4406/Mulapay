import { useState } from 'react';
import { AlertTriangle, Megaphone, Save, Send, Trash2 } from 'lucide-react';
import type { AdminConfiguration, AdminConsoleRow } from '@workspace/api-client-react';
import { fmtDate, useAdminCommand, useConsole, useIsSuperAdmin } from './lib';
import { ConfirmDialog, DataState, Field, PageHead, Pager, Panel, StatusPill, SuperNotice } from './ui';
import { MaintenancePanel } from './pages-ops';

/* ---------------- Messages ---------------- */

export function AdminMessages() {
  const [page, setPage] = useState(1);
  const query = useConsole('messages', { page });
  const { run } = useAdminCommand();
  const [mode, setMode] = useState<'one' | 'all'>('one');
  const [form, setForm] = useState({ email: '', subject: '', body: '' });
  const [confirm, setConfirm] = useState(false);
  const emailConfigured = query.data?.emailConfigured;
  const valid = form.subject.trim().length >= 2 && form.body.trim().length >= 2 && (mode === 'all' || /\S+@\S+\.\S+/.test(form.email));
  return <main className="ad-page">
    <PageHead eyebrow="Communication" title="Messages marchands" note="E-mails individuels ou groupés, avec historique d’envoi." />
    {query.data && !emailConfigured && <div className="ad-banner" data-testid="status-email-unconfigured"><AlertTriangle size={17} /><div><strong>Aucun service d’envoi e-mail n’est configuré.</strong><p>Les envois seront refusés par le serveur tant qu’un fournisseur e-mail n’est pas branché. Aucun envoi n’est simulé.</p></div></div>}
    <Panel title="Nouveau message">
      <div className="ad-seg"><button className={mode === 'one' ? 'on' : ''} onClick={() => setMode('one')} data-testid="button-message-mode-one">Message individuel</button><button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')} data-testid="button-message-mode-all">Tous les marchands</button></div>
      <form onSubmit={e => { e.preventDefault(); if (valid) setConfirm(true); }}>
        {mode === 'one' && <Field label="Adresse e-mail du destinataire"><input type="email" value={form.email} onChange={e => setForm(v => ({ ...v, email: e.target.value }))} data-testid="input-message-email" /></Field>}
        <Field label="Sujet"><input value={form.subject} onChange={e => setForm(v => ({ ...v, subject: e.target.value }))} data-testid="input-message-subject" /></Field>
        <Field label="Contenu"><textarea rows={6} value={form.body} onChange={e => setForm(v => ({ ...v, body: e.target.value }))} data-testid="input-message-body" /></Field>
        <button className="ad-btn ad-btn-primary" disabled={!valid} data-testid="button-message-send"><Send size={14} /> Envoyer</button>
      </form>
    </Panel>
    <Panel title="Historique des envois">
      <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucun message envoyé">
        <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th>Sujet</th><th>Destinataire</th><th>Date</th><th>Statut</th></tr></thead><tbody>
          {query.data?.items.map((m: AdminConsoleRow) => <tr key={m.id} data-testid={`row-message-${m.id}`}><td><strong>{m.subject}</strong></td><td>{m.recipient === 'ALL' ? 'Tous les marchands' : m.recipient}</td><td className="ad-mono">{fmtDate(m.createdAt)}</td><td><StatusPill status={m.status} />{m.error && <small className="ad-sub ad-err">{m.error}</small>}</td></tr>)}
        </tbody></table></div>
        {query.data && <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />}
      </DataState>
    </Panel>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={mode === 'all' ? 'Envoyer à tous les marchands ?' : `Envoyer à ${form.email} ?`} description={`Sujet : ${form.subject}`} confirmLabel="Envoyer" onConfirm={async () => { const ok = await run({ action: 'message_send', recipient: mode === 'all' ? 'ALL' : form.email.trim(), subject: form.subject.trim(), body: form.body.trim() }, 'Le message n’a pas été envoyé.'); if (ok) setForm({ email: '', subject: '', body: '' }); return ok; }} />
  </main>;
}

/* ---------------- Notifications ---------------- */

export function AdminNotifications() {
  const [page, setPage] = useState(1);
  const query = useConsole('notifications', { page });
  const { run, pending } = useAdminCommand();
  const [form, setForm] = useState({ title: '', body: '' });
  const [remove, setRemove] = useState<AdminConsoleRow | null>(null);
  return <main className="ad-page">
    <PageHead eyebrow="Diffusion" title="Notifications" note="Affichées en fenêtre sur le tableau de bord de chaque marchand, jusqu’à fermeture." />
    <div className="ad-split">
      <Panel title="Créer une notification">
        <form onSubmit={async e => { e.preventDefault(); if (await run({ action: 'announcement_create', title: form.title.trim(), body: form.body.trim() })) setForm({ title: '', body: '' }); }}>
          <Field label="Titre"><input required maxLength={120} value={form.title} onChange={e => setForm(v => ({ ...v, title: e.target.value }))} data-testid="input-announcement-title" /></Field>
          <Field label="Message"><textarea required maxLength={600} rows={4} value={form.body} onChange={e => setForm(v => ({ ...v, body: e.target.value }))} data-testid="input-announcement-body" /></Field>
          <button className="ad-btn ad-btn-primary" disabled={pending} data-testid="button-announcement-create"><Megaphone size={14} /> Publier</button>
        </form>
      </Panel>
      <Panel title="Aperçu marchand">
        <div className="ad-preview"><span className="ad-eyebrow">Annonce Mulapay</span><strong>{form.title || 'Titre de la notification'}</strong><p>{form.body || 'Le message apparaîtra ici.'}</p></div>
      </Panel>
    </div>
    <Panel title="Notifications publiées">
      <DataState isLoading={query.isLoading} error={query.error} empty={(query.data?.items.length ?? 0) === 0} onRetry={() => void query.refetch()} emptyTitle="Aucune notification publiée">
        <div className="ad-announce-list">{query.data?.items.map(a => <article key={a.id} data-testid={`card-announcement-${a.id}`}><div><strong>{a.title}</strong><p>{a.body}</p><small className="ad-mono">{fmtDate(a.createdAt)}</small></div><button className="ad-icon-btn danger" onClick={() => setRemove(a)} aria-label="Supprimer" data-testid={`button-announcement-delete-${a.id}`}><Trash2 size={14} /></button></article>)}</div>
        {query.data && <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />}
      </DataState>
    </Panel>
    <ConfirmDialog open={!!remove} onOpenChange={v => !v && setRemove(null)} title="Supprimer cette notification ?" description="Elle ne sera plus affichée aux marchands." confirmLabel="Supprimer" tone="danger" onConfirm={() => run({ action: 'announcement_delete', targetId: remove?.id })} />
  </main>;
}

/* ---------------- Settings ---------------- */

function SettingsSection({ title, note, fields, settings }: { title: string; note: string; fields: { key: keyof AdminConfiguration; label: string; type?: string; hint?: string }[]; settings: AdminConfiguration }) {
  const { run, pending: busy } = useAdminCommand();
  const isSuper = useIsSuperAdmin();
  const pending = busy || !isSuper;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(f => [f.key, settings[f.key] == null ? '' : String(settings[f.key])])));
  const save = () => {
    const out: Record<string, unknown> = {};
    fields.forEach(f => { out[f.key] = f.type === 'number' ? Number(values[f.key]) : values[f.key].trim(); });
    return run({ action: 'settings_update', settings: out as AdminConfiguration });
  };
  const testKey = title.toLowerCase().replace(/[^a-z]+/g, '-');
  return <Panel title={title} note={note}>
    <div className="ad-form-grid two">{fields.map(f => <Field key={f.key} label={f.label} hint={f.hint}><input type={f.type ?? 'text'} step={f.type === 'number' ? 'any' : undefined} value={values[f.key]} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} data-testid={`input-setting-${f.key}`} /></Field>)}</div>
    <button className="ad-btn ad-btn-primary" disabled={pending || fields.some(f => f.type === 'number' && values[f.key] === '')} onClick={() => void save()} data-testid={`button-save-${testKey}`}><Save size={14} /> Enregistrer les modifications</button>
  </Panel>;
}

function TelegramPanel({ configured }: { configured: boolean }) {
  const { run, pending: busy } = useAdminCommand();
  const isSuper = useIsSuperAdmin();
  const pending = busy || !isSuper;
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  return <Panel title="Bot Telegram" note="Notifications automatiques de la plateforme." action={<StatusPill status={configured ? 'active' : 'inactive'} testId="status-telegram" />}>
    <p className="ad-dim ad-small">{configured ? 'Un bot est configuré. Les valeurs enregistrées ne sont jamais réaffichées ; saisissez-en de nouvelles pour les remplacer.' : 'Aucun bot configuré.'}</p>
    <form className="ad-form-grid two" onSubmit={async e => { e.preventDefault(); if (await run({ action: 'telegram_configure', telegramToken: token.trim(), telegramChatId: chatId.trim() })) { setToken(''); setChatId(''); } }}>
      <Field label="Bot Token"><input type="password" autoComplete="off" required value={token} onChange={e => setToken(e.target.value)} placeholder="123456:ABC…" data-testid="input-telegram-token" /></Field>
      <Field label="Chat ID"><input autoComplete="off" required value={chatId} onChange={e => setChatId(e.target.value)} placeholder="-100…" data-testid="input-telegram-chat" /></Field>
      <div className="ad-form-end ad-row"><button className="ad-btn ad-btn-primary" disabled={pending} data-testid="button-telegram-save"><Save size={14} /> Enregistrer les modifications</button><button type="button" className="ad-btn ad-btn-ghost" disabled={!configured || pending} onClick={() => void run({ action: 'telegram_test' }, 'Le message de test n’a pas pu être envoyé.')} data-testid="button-telegram-test"><Send size={14} /> Envoyer un test</button></div>
    </form>
  </Panel>;
}

export function AdminSettings() {
  const query = useConsole('settings');
  const s = query.data?.settings;
  const k = s ? JSON.stringify(s) : '';
  const isSuper = useIsSuperAdmin();
  return <main className="ad-page">
    <PageHead eyebrow="Configuration" title="Paramètres" note="Chaque bloc s’enregistre indépendamment et est conservé côté serveur." />
    <SuperNotice show={!isSuper} />
    <DataState isLoading={query.isLoading} error={query.error} empty={!s} onRetry={() => void query.refetch()} emptyTitle="Configuration indisponible">
      {s && <>
        <div className="ad-split">
          <SettingsSection key={`fees${k}`} settings={s} title="Frais globaux" note="Taux appliqués par défaut à tous les marchands." fields={[{ key: 'payinFee', label: 'Frais Payin (%)', type: 'number' }, { key: 'payoutFee', label: 'Frais Payout (%)', type: 'number' }]} />
          <SettingsSection key={`support${k}`} settings={s} title="Service client" note="Coordonnées affichées aux marchands." fields={[{ key: 'supportEmail', label: 'E-mail du support', type: 'email' }, { key: 'supportWhatsapp', label: 'WhatsApp', hint: 'Format international' }]} />
        </div>
        <div className="ad-split">
          <SettingsSection key={`dep${k}`} settings={s} title="Limites de dépôt" note="Montants par opération, en XOF." fields={[{ key: 'depositMin', label: 'Minimum', type: 'number' }, { key: 'depositMax', label: 'Maximum', type: 'number' }]} />
          <SettingsSection key={`wd${k}`} settings={s} title="Limites de retrait" note="Montants par opération, en XOF." fields={[{ key: 'withdrawalMin', label: 'Minimum', type: 'number' }, { key: 'withdrawalMax', label: 'Maximum', type: 'number' }]} />
        </div>
        <MaintenancePanel key={`m${k}`} settings={s} />
        <TelegramPanel configured={!!query.data?.telegramConfigured} />
      </>}
    </DataState>
  </main>;
}
