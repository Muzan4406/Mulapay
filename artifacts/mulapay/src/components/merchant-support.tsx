import { CircleAlert, LogOut, Mail, MessageCircle, RefreshCw } from 'lucide-react';
import { getGetBootstrapQueryKey, useGetBootstrap } from '@workspace/api-client-react';

function errorText(error: unknown) {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'error' in data && typeof (data as { error?: unknown }).error === 'string') return (data as { error: string }).error;
  }
  return null;
}

export function MerchantSupport() {
  const { data, isLoading } = useGetBootstrap({ query: { queryKey: getGetBootstrapQueryKey() } });
  const platform = data?.platform;
  const email = platform?.supportEmail?.trim();
  const whatsapp = platform?.supportWhatsapp?.trim();
  const waDigits = whatsapp?.replace(/\D/g, '');
  return <main className="page-wrap">
    <div className="eyebrow">Assistance</div>
    <h1 className="page-title">Support Mulapay</h1>
    <p className="page-subtitle">Contactez l’équipe Mulapay via les canaux officiels configurés par l’administration.</p>
    <div className="card card-pad" style={{ marginTop: 24, display: 'grid', gap: 12, maxWidth: 620 }}>
      {isLoading ? <p className="section-note">Chargement des contacts…</p> : !email && !waDigits ? <div className="notice"><CircleAlert size={15} /><span>Aucun contact de support n’est encore configuré. Réessayez plus tard.</span></div> : <>
        {email && <a className="button button-primary" href={`mailto:${email}`} data-testid="link-support-email"><Mail size={15} /> Écrire à {email}</a>}
        {waDigits && <a className="button button-ghost" href={`https://wa.me/${waDigits}`} target="_blank" rel="noreferrer" data-testid="link-support-whatsapp"><MessageCircle size={15} /> WhatsApp {whatsapp}</a>}
      </>}
    </div>
  </main>;
}

export function BootstrapErrorPage({ error, onRetry, onSignOut }: { error: unknown; onRetry: () => void; onSignOut: () => void }) {
  const message = errorText(error);
  const status = error && typeof error === 'object' && 'status' in error ? (error as { status?: number }).status : undefined;
  const blocked = !!message && (status === 403 || status === 423 || status === 503);
  return <main className="page-wrap"><div className="card card-pad api-unavailable">
    <CircleAlert size={28} />
    <div>
      <h1 className="section-title">{blocked ? 'Accès momentanément restreint' : 'Mulapay est momentanément indisponible'}</h1>
      <p className="section-note" data-testid="text-bootstrap-error">{message ?? 'Les données réelles de votre compte n’ont pas pu être chargées. Aucun solde ou statut de démonstration n’est affiché.'}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        <button className="button button-primary" type="button" onClick={onRetry} data-testid="button-bootstrap-retry"><RefreshCw size={14} /> Réessayer</button>
        <button className="button button-ghost" type="button" onClick={onSignOut} data-testid="button-bootstrap-signout"><LogOut size={14} /> Changer de compte</button>
      </div>
    </div>
  </div></main>;
}
