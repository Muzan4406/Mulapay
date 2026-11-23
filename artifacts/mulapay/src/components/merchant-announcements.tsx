import { useState } from 'react';
import { Megaphone, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { getListAnnouncementsQueryKey, useDismissAnnouncement, useListAnnouncements } from '@workspace/api-client-react';
import type { AdminAnnouncement } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import '@/admin/admin.css';

export function MerchantAnnouncements({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useListAnnouncements({ query: { queryKey: getListAnnouncementsQueryKey(), enabled, retry: false } });
  const dismiss = useDismissAnnouncement();
  const [closing, setClosing] = useState<string | null>(null);
  const current = data?.[0];
  if (!enabled || !current) return null;
  const close = async (item: AdminAnnouncement) => {
    setClosing(item.id);
    try {
      await dismiss.mutateAsync({ id: item.id });
      qc.setQueryData<AdminAnnouncement[]>(getListAnnouncementsQueryKey(), old => old?.filter(a => a.id !== item.id));
    } catch {
      toast({ variant: 'destructive', title: 'Fermeture impossible', description: 'La notification n’a pas pu être fermée. Réessayez.' });
    } finally { setClosing(null); }
  };
  return <div className="mp-announce-layer" role="dialog" aria-modal="true" aria-labelledby="mp-announce-title">
    <div className="mp-announce" data-testid={`popup-announcement-${current.id}`}>
      <button className="mp-announce-close" onClick={() => void close(current)} disabled={closing === current.id} aria-label="Fermer la notification" data-testid="button-announcement-dismiss"><X size={16} /></button>
      <span className="mp-announce-icon"><Megaphone size={18} /></span>
      <span className="ad-eyebrow">Annonce Mulapay{data && data.length > 1 ? ` · 1 sur ${data.length}` : ''}</span>
      <h2 id="mp-announce-title">{current.title}</h2>
      <p>{current.body}</p>
      <small>{new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Lome', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(current.createdAt))}</small>
    </div>
  </div>;
}
