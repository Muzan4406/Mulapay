import { useEffect, useState } from 'react';
import { ArrowLeftRight, Ban, Bell, FileCheck2, Globe2, KeyRound, LayoutDashboard, Link2, ListFilter, LogOut, Mail, Menu, Network, RadioTower, Settings2, Users, WalletCards, X } from 'lucide-react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { useClerk } from '@clerk/react';
import { getGetBootstrapQueryKey, useGetBootstrap } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';
import { AdminDashboard, AdminExchanges, AdminKyc, AdminMerchants, AdminTransactions, AdminWallets } from './pages-core';
import { AdminApiKeys, AdminBlacklist, AdminOperators, AdminPaymentLinks, AdminProviders } from './pages-ops';
import { AdminMessages, AdminNotifications, AdminSettings } from './pages-comms';
import { ConfirmDialog } from './ui';
import './admin.css';

const NAV = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/merchants', label: 'Marchands', icon: Users },
  { href: '/admin/kyc', label: 'Vérification KYC', icon: FileCheck2 },
  { href: '/admin/transactions', label: 'Transactions', icon: ListFilter },
  { href: '/admin/wallets', label: 'Wallet par pays', icon: WalletCards },
  { href: '/admin/exchanges', label: 'Échange Wallet', icon: ArrowLeftRight },
  { href: '/admin/providers', label: 'Agrégateurs', icon: Network },
  { href: '/admin/operators', label: 'Opérateurs par pays', icon: Globe2 },
  { href: '/admin/api-keys', label: 'Clés API marchand', icon: KeyRound },
  { href: '/admin/payment-links', label: 'Liens de paiement', icon: Link2 },
  { href: '/admin/blacklist', label: 'Liste noire', icon: Ban },
  { href: '/admin/messages', label: 'Messages marchands', icon: Mail },
  { href: '/admin/notifications', label: 'Notifications', icon: Bell },
  { href: '/admin/settings', label: 'Paramètres', icon: Settings2 },
];

export function AdminPanel() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [logout, setLogout] = useState(false);
  const { signOut } = useClerk();
  const { data } = useGetBootstrap({ query: { queryKey: getGetBootstrapQueryKey() } });
  const profile = data?.profile;
  useEffect(() => { setOpen(false); window.scrollTo({ top: 0 }); }, [location]);
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const current = NAV.find(n => n.href === location) ?? NAV.find(n => n.href !== '/admin' && location.startsWith(n.href));

  return <div className="ad-shell">
    <aside className={`ad-side ${open ? 'open' : ''}`} id="admin-nav">
      <div className="ad-brand"><img src={`${import.meta.env.BASE_URL}mulapay-logo.png`} alt="Mulapay" /><span>Console admin</span></div>
      <nav className="ad-nav">
        {NAV.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`ad-nav-link ${current?.href === href ? 'active' : ''}`} data-testid={`link-admin-nav-${href.split('/')[2] ?? 'dashboard'}`}><Icon size={16} /><span>{label}</span></Link>)}
        <button className="ad-nav-link ad-nav-logout" onClick={() => setLogout(true)} data-testid="button-admin-logout"><LogOut size={16} /><span>Déconnexion</span></button>
      </nav>
      <div className="ad-side-foot">
        {profile && <div className="ad-me"><span className="ad-avatar">{(profile.firstName[0] ?? 'A') + (profile.lastName[0] ?? '')}</span><div><strong>{profile.firstName} {profile.lastName}</strong><small>{profile.role === 'SUPER_ADMIN' ? 'Super administrateur' : 'Administrateur'}</small></div></div>}
        <Link href="/app" className="ad-switch" data-testid="link-admin-to-app"><RadioTower size={13} /> Espace marchand</Link>
      </div>
    </aside>
    {open && <div className="ad-backdrop" onClick={() => setOpen(false)} />}
    <div className="ad-main">
      <div className="ad-topbar">
        <button className="ad-icon-btn ad-menu" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-controls="admin-nav" aria-label="Menu" data-testid="button-admin-menu">{open ? <X size={17} /> : <Menu size={17} />}</button>
        <span className="ad-crumb">Mulapay / Administration / <b>{current?.label ?? 'Page'}</b></span>
        <span className="ad-clock">Heure de référence · Africa/Lome (UTC)</span>
      </div>
      <div className="ad-content" key={location}>
        <Switch>
          <Route path="/admin" component={AdminDashboard} />
          <Route path="/admin/merchants" component={AdminMerchants} />
          <Route path="/admin/kyc" component={AdminKyc} />
          <Route path="/admin/transactions" component={AdminTransactions} />
          <Route path="/admin/wallets" component={AdminWallets} />
          <Route path="/admin/exchanges" component={AdminExchanges} />
          <Route path="/admin/providers" component={AdminProviders} />
          <Route path="/admin/operators" component={AdminOperators} />
          <Route path="/admin/api-keys" component={AdminApiKeys} />
          <Route path="/admin/payment-links" component={AdminPaymentLinks} />
          <Route path="/admin/blacklist" component={AdminBlacklist} />
          <Route path="/admin/messages" component={AdminMessages} />
          <Route path="/admin/notifications" component={AdminNotifications} />
          <Route path="/admin/settings" component={AdminSettings} />
          <Route component={NotFound} />
        </Switch>
      </div>
    </div>
    <ConfirmDialog open={logout} onOpenChange={setLogout} title="Se déconnecter ?" description="Votre session administrateur sera fermée et vous serez redirigé vers la page de connexion." confirmLabel="Se déconnecter" tone="danger" onConfirm={async () => { await signOut({ redirectUrl: `${base}/sign-in` }); return true; }} />
  </div>;
}
