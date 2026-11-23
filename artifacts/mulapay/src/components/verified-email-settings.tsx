import { useState } from 'react';
import { useClerk, useUser } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetBootstrapQueryKey, useSyncVerifiedProfileEmail } from '@workspace/api-client-react';
import { errorMessage } from '../admin/lib';

export function VerifiedEmailSettings() {
  const { user } = useUser();
  const { openUserProfile } = useClerk();
  const mutation = useSyncVerifiedProfileEmail();
  const client = useQueryClient();
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const manage = async () => {
    setOpening(true);
    try { await user?.reload(); openUserProfile(); }
    catch (error) { setFailed(true); setMessage(errorMessage(error, 'Le profil sécurisé n’a pas pu être ouvert.')); }
    finally { setOpening(false); }
  };
  const sync = async () => {
    try {
      const result = await mutation.mutateAsync(undefined);
      await user?.reload();
      await client.invalidateQueries({ queryKey: getGetBootstrapQueryKey() });
      setFailed(false); setMessage(result.message);
    } catch (error) { setFailed(true); setMessage(errorMessage(error, 'L’adresse vérifiée n’a pas pu être synchronisée.')); }
  };
  return <section className="card card-pad" style={{ marginBottom: 24 }}>
    <h2 className="section-title">Adresse e-mail vérifiée</h2>
    <p className="section-note">Pour changer d’adresse, ouvrez le profil sécurisé Clerk, vérifiez la nouvelle adresse et choisissez-la comme principale. Synchronisez ensuite votre compte Mulapay. Aucune adresse non vérifiée ne remplace votre accès actuel.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
      <button className="button button-primary" disabled={opening} onClick={() => void manage()} data-testid="button-manage-verified-email">Gérer mes adresses e-mail</button>
      <button className="button button-ghost" disabled={mutation.isPending} onClick={() => void sync()} data-testid="button-sync-verified-email">{mutation.isPending ? 'Synchronisation…' : 'Synchroniser mon adresse principale'}</button>
    </div>
    {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'auth-error' : 'section-note'} style={{ marginTop: 12 }}>{message}</p>}
  </section>;
}
