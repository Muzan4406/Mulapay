import { useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, RefreshCw, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorMessage, flagUrl, countryInfo } from './lib';

export function PageHead({ eyebrow, title, note, action }: { eyebrow: string; title: string; note?: string; action?: ReactNode }) {
  return <header className="ad-head">
    <div><span className="ad-eyebrow">{eyebrow}</span><h1 data-testid="text-admin-title">{title}</h1>{note && <p>{note}</p>}</div>
    {action && <div className="ad-head-action">{action}</div>}
  </header>;
}

export function Stat({ label, value, hint, tone, icon, testId }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'teal' | 'amber' | 'ink' | 'rose' | 'muted'; icon?: ReactNode; testId?: string }) {
  return <div className={`ad-stat ad-tone-${tone ?? 'plain'}`} data-testid={testId}>
    <div className="ad-stat-top"><span>{label}</span>{icon}</div>
    <strong>{value}</strong>
    {hint && <small>{hint}</small>}
  </div>;
}

const STATUS_TONES: Record<string, { label: string; tone: string }> = {
  pending: { label: 'En attente', tone: 'amber' }, pending_admin: { label: 'À examiner', tone: 'amber' }, en_attente: { label: 'En attente', tone: 'amber' }, processing: { label: 'En traitement', tone: 'amber' },
  'pending review': { label: 'À examiner', tone: 'amber' }, a_revoir: { label: 'À revoir', tone: 'amber' }, review: { label: 'À revoir', tone: 'amber' },
  completed: { label: 'Réussie', tone: 'teal' }, success: { label: 'Réussie', tone: 'teal' }, approved: { label: 'Approuvé', tone: 'teal' },
  verified: { label: 'Vérifié', tone: 'teal' }, verifie: { label: 'Vérifié', tone: 'teal' }, active: { label: 'Actif', tone: 'teal' }, actif: { label: 'Actif', tone: 'teal' },
  sent: { label: 'Envoyé', tone: 'teal' }, enabled: { label: 'Actif', tone: 'teal' },
  failed: { label: 'Échouée', tone: 'rose' }, rejected: { label: 'Rejeté', tone: 'rose' }, refused: { label: 'Rejeté', tone: 'rose' }, refuse: { label: 'Rejeté', tone: 'rose' },
  suspended: { label: 'Suspendu', tone: 'rose' }, revoked: { label: 'Révoqué', tone: 'rose' }, blocked: { label: 'Bloqué', tone: 'rose' }, deleted: { label: 'Supprimé', tone: 'rose' },
  cancelled: { label: 'Annulée', tone: 'muted' }, expired: { label: 'Expiré', tone: 'muted' }, reversed: { label: 'Remboursée', tone: 'muted' }, disabled: { label: 'Inactif', tone: 'muted' },
  non_verifie: { label: 'Non vérifié', tone: 'muted' }, inactive: { label: 'Inactif', tone: 'muted' },
};

export function StatusPill({ status, testId }: { status?: string | null; testId?: string }) {
  const s = (status ?? '').trim();
  const m = STATUS_TONES[s.toLowerCase()];
  return <span className={`ad-pill ad-pill-${m?.tone ?? 'muted'}`} data-testid={testId}><i />{m?.label ?? (s || 'Inconnu')}</span>;
}

export function Country({ value }: { value?: string | null }) {
  if (!value) return <span className="ad-dim">—</span>;
  const url = flagUrl(value);
  return <span className="ad-country">{url ? <img src={url} alt="" /> : <b>{value.slice(0, 2).toUpperCase()}</b>}{countryInfo(value)?.name ?? value}</span>;
}

export function SuperNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="ad-banner" data-testid="status-super-admin-required"><AlertTriangle size={17} /><div><strong>Lecture seule pour votre rôle.</strong><p>Les actions sensibles de cette page sont réservées au rôle SUPER_ADMIN.</p></div></div>;
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="ad-toolbar">{children}</div>;
}

export function SearchBox({ value, onChange, placeholder, testId = 'input-admin-search' }: { value: string; onChange: (v: string) => void; placeholder: string; testId?: string }) {
  return <label className="ad-search"><Search size={15} /><input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} data-testid={testId} /></label>;
}

export function FilterSelect({ value, onChange, options, label, testId }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string; testId: string }) {
  return <label className="ad-select"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)} data-testid={testId}><option value="">Tous</option>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
}

export function DataState({ isLoading, error, empty, onRetry, emptyTitle, emptyNote, children, rows = 6 }: { isLoading: boolean; error: unknown; empty: boolean; onRetry: () => void; emptyTitle: string; emptyNote?: string; children: ReactNode; rows?: number }) {
  if (isLoading) return <div className="ad-skeleton" aria-busy="true">{Array.from({ length: rows }).map((_, i) => <span key={i} style={{ animationDelay: `${i * 70}ms` }} />)}</div>;
  if (error) return <div className="ad-state ad-state-error" data-testid="status-admin-error"><AlertTriangle size={20} /><div><strong>Chargement impossible</strong><p>{errorMessage(error, 'Le serveur n’a pas répondu.')}</p></div><button className="ad-btn ad-btn-ghost" onClick={onRetry} data-testid="button-admin-retry"><RefreshCw size={14} /> Réessayer</button></div>;
  if (empty) return <div className="ad-state" data-testid="status-admin-empty"><Inbox size={20} /><div><strong>{emptyTitle}</strong>{emptyNote && <p>{emptyNote}</p>}</div></div>;
  return <>{children}</>;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return <div className="ad-pager">
    <span data-testid="text-admin-total">{total} résultat{total > 1 ? 's' : ''} · page {page}/{pages}</span>
    <div><button className="ad-icon-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Page précédente" data-testid="button-page-prev"><ChevronLeft size={15} /></button><button className="ad-icon-btn" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Page suivante" data-testid="button-page-next"><ChevronRight size={15} /></button></div>
  </div>;
}

export function Panel({ title, note, action, children, className = '' }: { title?: string; note?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`ad-panel ${className}`}>
    {title && <div className="ad-panel-head"><div><h2>{title}</h2>{note && <p>{note}</p>}</div>{action}</div>}
    {children}
  </section>;
}

export function Toggle({ checked, onChange, label, hint, testId, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; testId: string; disabled?: boolean }) {
  return <label className={`ad-toggle ${checked ? 'on' : ''}`}>
    <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} data-testid={testId}><i /></button>
  </label>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="ad-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, tone = 'primary', reason, typeToConfirm, onConfirm, children }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; description: ReactNode; confirmLabel: string; tone?: 'primary' | 'danger';
  reason?: { label: string; required?: boolean; placeholder?: string }; typeToConfirm?: string; onConfirm: (reason: string) => Promise<boolean>; children?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = busy || (reason?.required && text.trim().length < 3) || (typeToConfirm !== undefined && typed.trim() !== typeToConfirm);
  const close = (v: boolean) => { if (busy) return; if (!v) { setText(''); setTyped(''); } onOpenChange(v); };
  return <Dialog open={open} onOpenChange={close}>
    <DialogContent className="ad-dialog">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      {children}
      {reason && <Field label={reason.label} hint={reason.required ? 'Obligatoire, transmis au journal d’audit.' : undefined}><textarea value={text} onChange={e => setText(e.target.value)} placeholder={reason.placeholder} data-testid="input-confirm-reason" /></Field>}
      {typeToConfirm !== undefined && <Field label={`Saisissez ${typeToConfirm} pour confirmer`}><input value={typed} onChange={e => setTyped(e.target.value)} data-testid="input-confirm-type" /></Field>}
      <DialogFooter className="ad-dialog-foot" data-testid="confirm-dialog-actions">
        <button className="ad-btn ad-btn-ghost" onClick={() => close(false)} disabled={busy} data-testid="button-confirm-cancel">Annuler</button>
        <button className={`ad-btn ${tone === 'danger' ? 'ad-btn-danger' : 'ad-btn-primary'}`} disabled={!!blocked} data-testid="button-confirm-submit" onClick={async () => {
          if (blocked) return;
          setBusy(true);
          try {
            const ok = await onConfirm(text.trim());
            if (ok) { setText(''); setTyped(''); onOpenChange(false); }
          } finally {
            setBusy(false);
          }
        }}>{busy ? 'Traitement…' : confirmLabel}</button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
