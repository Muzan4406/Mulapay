import { createContext, type FormEvent, type ReactNode, useContext, useState } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Banknote, Bell, Check, CheckCircle2,
  ChevronRight, CircleAlert, Clock3, Copy, Download, Eye, FileCheck2, Globe2, Info, LayoutDashboard,
  Link2, ListFilter, LockKeyhole, LogOut, Menu, MoreHorizontal, Plus, QrCode, RefreshCw, Search,
  Send, Settings2, ShieldCheck, WalletCards, X
} from 'lucide-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { frFR } from '@clerk/localizations';
import {
  getGetBootstrapQueryKey,
  getGetAdminSummaryQueryKey,
  getListAdminKycQueryKey,
  getListAdminTransactionsQueryKey,
  useCreateExchange,
  useCreatePaymentLink,
  useCreateTransfer,
  useDecideExchange,
  useDecideKyc,
  useGetAdminSummary,
  useGetBootstrap,
  useListAdminKyc,
  useListAdminTransactions,
  useMarkNotificationRead,
  useSubmitKyc,
} from '@workspace/api-client-react';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

type Wallet = { id: string; country: string; code: string; currency: string; balance: number; pending: number; status: string };
type Transaction = { id: string; type: string; status: string; amount: number; currency: string; country: string; counterparty: string; createdAt: string; reference: string };
type Exchange = { id: string; source: string; destination: string; amount: number; rate: number; receivedAmount: number; status: string; requestedAt: string };
type PaymentLink = { id: string; slug: string; amount: number; currency: string; description: string; status: string; expiresAt: string; payments: number };
type Notification = { id: string; title: string; body: string; read: boolean };
type AdminKycCase = { id: string; userId: string; name: string; country: string; status: string; documents: string[]; submittedAt: string };
type AdminSummary = { kycAwaiting: number; exchangeQueue: number; volume: number; successRate: number };
type Store = {
  wallets: Wallet[]; transactions: Transaction[]; exchanges: Exchange[]; links: PaymentLink[]; notifications: Notification[];
  adminKyc: AdminKycCase[]; adminTransactions: Transaction[]; adminSummary?: AdminSummary;
  transfer: (data: { amount: number; currency: string; counterparty: string; note: string }) => void;
  exchange: (data: { source: string; destination: string; amount: number }) => void;
  setExchangeStatus: (id: string, status: string) => void;
  addLink: (data: { amount: number; currency: string; description: string; expiresAt: string }) => void;
  markRead: (id: string) => void;
  submitKyc: (documents: string[]) => void;
  decideKyc: (id: string, accepted: boolean) => void;
  signOut: () => void;
  toast: (message: string) => void;
};

const queryClient = new QueryClient();
const StoreContext = createContext<Store | null>(null);
const useStore = () => useContext(StoreContext)!;

const initialWallets: Wallet[] = [
  { id: 'demo-tg', country: 'Togo', code: 'TG', currency: 'XOF', balance: 482500, pending: 12500, status: 'Active' },
  { id: 'demo-bj', country: 'Bénin', code: 'BJ', currency: 'XOF', balance: 218000, pending: 0, status: 'Active' },
  { id: 'demo-ci', country: 'CI', code: 'CI', currency: 'XOF', balance: 175250, pending: 48000, status: 'Active' },
  { id: 'demo-sn', country: 'Sénégal', code: 'SN', currency: 'XOF', balance: 94000, pending: 0, status: 'Active' },
  { id: 'demo-bf', country: 'Burkina Faso', code: 'BF', currency: 'XOF', balance: 0, pending: 0, status: 'Active' },
  { id: 'demo-ml', country: 'Mali', code: 'ML', currency: 'XOF', balance: 0, pending: 0, status: 'Active' },
  { id: 'demo-ne', country: 'Niger', code: 'NE', currency: 'XOF', balance: 0, pending: 0, status: 'Active' },
];
const initialTransactions: Transaction[] = [
  { id: 'txn-01', type: 'Received', status: 'Completed', amount: 17500, currency: 'XOF', country: 'Togo', counterparty: 'Afi Kossi', createdAt: 'Today, 09:42', reference: 'MP-8K4D2' },
  { id: 'txn-02', type: 'Exchange', status: 'Completed', amount: 75000, currency: 'XOF', country: 'Benin', counterparty: 'Togo wallet', createdAt: 'Yesterday, 16:18', reference: 'MP-8K2A9' },
  { id: 'txn-03', type: 'Sent', status: 'Completed', amount: 32000, currency: 'XOF', country: 'Côte d’Ivoire', counterparty: 'Koffi Mensah', createdAt: '24 May, 11:05', reference: 'MP-8J91Q' },
  { id: 'txn-04', type: 'Deposit', status: 'Pending', amount: 50000, currency: 'XOF', country: 'Togo', counterparty: 'Manual deposit', createdAt: '22 May, 14:26', reference: 'MP-8G21B' },
  { id: 'txn-05', type: 'Payment', status: 'Completed', amount: 8900, currency: 'XOF', country: 'Senegal', counterparty: 'Nia Atelier', createdAt: '20 May, 10:20', reference: 'MP-8E75N' },
];
const initialExchanges: Exchange[] = [
  { id: 'ex-01', source: 'Togo · XOF', destination: 'Benin · XOF', amount: 75000, rate: 1, receivedAmount: 75000, status: 'Completed', requestedAt: 'Yesterday, 16:18' },
  { id: 'ex-02', source: 'Côte d’Ivoire · XOF', destination: 'Togo · XOF', amount: 48000, rate: 1, receivedAmount: 48000, status: 'Pending review', requestedAt: 'Today, 08:15' },
];
const initialLinks: PaymentLink[] = [
  { id: 'lnk-01', slug: 'mulapay.me/afi-atelier', amount: 12500, currency: 'XOF', description: 'Afi Atelier order #184', status: 'Active', expiresAt: '18 Jun 2024', payments: 3 },
  { id: 'lnk-02', slug: 'mulapay.me/afi-consult', amount: 30000, currency: 'XOF', description: 'Consultation deposit', status: 'Active', expiresAt: '30 Jun 2024', payments: 0 },
];
const initialNotifications: Notification[] = [
  { id: 'n-01', title: 'Exchange request received', body: 'Your Côte d’Ivoire to Togo exchange is queued for review.', read: false },
  { id: 'n-02', title: 'Transfer completed', body: '17,500 XOF was received from Afi Kossi.', read: false },
  { id: 'n-03', title: 'KYC approved', body: 'Your identity check is complete. Your account is verified.', read: true },
];

function money(value: number, currency = 'XOF') {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(value) + ` ${currency}`;
}

function statusLabel(status: string) {
  return ({ Active: 'Actif', Pending: 'En attente', Completed: 'Effectué', 'Pending review': 'À examiner', Rejected: 'Refusé', EN_ATTENTE: 'En attente', VERIFIED: 'Vérifié', REFUSED: 'Refusé' } as Record<string, string>)[status] ?? status;
}

function movementLabel(type: string) {
  return ({ Received: 'Reçu', Sent: 'Envoyé', Exchange: 'Échange', Deposit: 'Dépôt', Withdrawal: 'Retrait', Payment: 'Paiement' } as Record<string, string>)[type] ?? type;
}

function countryLabel(country: string) {
  return ({ Benin: 'Bénin', Senegal: 'Sénégal' } as Record<string, string>)[country] ?? country;
}

function Logo({ light = false }: { light?: boolean }) {
  return <div className="brand" data-testid="brand-mulapay">
    <img className={`brand-image ${light ? 'brand-image-light' : ''}`} src={`${import.meta.env.BASE_URL}mulapay-logo.png`} alt="Mulapay — Votre argent, partout." />
  </div>;
}

function Landing() {
  return <div className="landing">
    <nav className="landing-nav">
      <Logo />
      <div className="landing-actions"><Link href="/sign-in" data-testid="link-landing-login">Se connecter</Link><Link href="/sign-up" className="button button-primary button-sm" data-testid="link-landing-demo">Ouvrir un compte <ChevronRight size={14} /></Link></div>
    </nav>
    <main>
      <section className="landing-hero">
        <div>
          <div className="landing-kicker"><span className="kicker-line" /> conçu pour l’Afrique de l’Ouest</div>
          <h1 className="landing-title">Votre argent avance<br /><em>à votre rythme.</em></h1>
          <p className="landing-copy">Mulapay réunit vos wallets par pays dans un compte clair — pour envoyer, recevoir et gérer votre argent dans toute la région avec simplicité.</p>
           <div className="landing-cta"><Link href="/connexion" className="button button-primary" data-testid="link-landing-open-app">Explorer la démo <ArrowRightLeft size={15} /></Link><Link href="/sign-in" className="button button-ghost" data-testid="link-landing-admin">Voir les opérations <Activity size={15} /></Link></div>
           <div className="landing-proof"><span><span className="proof-mark" /> Espace sécurisé</span><span><ShieldCheck size={13} /> Aucun PSP connecté</span></div>
        </div>
        <div className="cockpit-visual" aria-label="Mulapay product preview">
          <div className="visual-orbit" />
           <div className="visual-card"><div className="visual-label">tous les wallets · solde disponible</div><div className="visual-total">970,750 <span style={{ fontSize: 12, color: 'hsl(160 25% 72%)' }}>XOF</span></div><div className="visual-lines"><div className="visual-line" /><div className="visual-line" /><div className="visual-line" /></div><div style={{ marginTop: 28, color: 'hsl(160 42% 64%)', fontSize: 11 }}>4 wallets par pays en un coup d’œil</div></div>
           <div className="visual-mini"><div className="eyebrow">dernier mouvement</div><div style={{ fontWeight: 700, fontSize: 13, marginTop: 12 }}>Reçu de la part d’Afi</div><div style={{ color: 'hsl(160 42% 38%)', fontFamily: 'var(--font-mono)', fontSize: 17, marginTop: 9 }}>+17,500</div><div style={{ color: 'hsl(203 18% 46%)', fontSize: 10, marginTop: 5 }}>XOF · effectué</div></div>
        </div>
      </section>
       <section className="landing-section muted"><div className="landing-section-inner"><div className="eyebrow">un compte, pensé pour la région</div><h2 className="page-title" style={{ maxWidth: 600 }}>Une vue plus sereine<br />sur tout votre argent.</h2><div className="feature-grid"><div className="feature card"><Globe2 className="feature-icon" size={20} /><h3>Sept marchés, un même rythme.</h3><p>Gardez vos wallets du Togo, du Bénin, de Côte d’Ivoire, du Burkina Faso, du Sénégal, du Mali et du Niger à portée de main — sans tableurs ni approximations.</p></div><div className="feature card"><ArrowRightLeft className="feature-icon" size={20} /><h3>Chaque mouvement est contextualisé.</h3><p>Consultez le taux, les frais et le wallet destinataire avant de confirmer un échange.</p></div><div className="feature card"><ShieldCheck className="feature-icon" size={20} /><h3>La maîtrise, par conception.</h3><p>Chaque action est claire, traçable et vérifiée au bon endroit.</p></div></div></div></section>
    </main>
     <footer className="landing-footer"><Logo /><span>© 2024 Mulapay · Prototype de démonstration</span><span>Pour des marchés connectés</span></footer>
  </div>;
}

const demoAdmin = { email: 'admin@mulapay.demo', password: 'MulapayAdmin2026' };
const hasDemoSession = () => import.meta.env.DEV && typeof window !== 'undefined' && sessionStorage.getItem('mulapay-demo-role') === 'admin';

function Login() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState(demoAdmin.email);
  const [password, setPassword] = useState(demoAdmin.password);
  const [error, setError] = useState('');
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (email.trim().toLowerCase() !== demoAdmin.email || password !== demoAdmin.password) {
      setError('Les identifiants de démonstration ne correspondent pas.');
      return;
    }
    sessionStorage.setItem('mulapay-demo-role', 'admin');
    setLocation('/admin');
  };
  return <div className="auth-page"><div className="auth-orbit auth-orbit-one" /><div className="auth-orbit auth-orbit-two" /><div className="auth-card"><div className="auth-brand"><Logo /><span className="auth-mode">Development demo</span></div><div className="auth-heading"><div className="eyebrow"><ShieldCheck size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> Demo operations access</div><h1>Welcome back.</h1><p>Use this local-only account to review the Mulapay operations workspace without creating a Clerk account.</p></div><div className="demo-credentials"><div className="demo-credentials-label"><CircleAlert size={13} /> Compte admin de démonstration</div><div className="demo-credentials-row"><span>Email</span><strong>{demoAdmin.email}</strong></div><div className="demo-credentials-row"><span>Mot de passe</span><strong>{demoAdmin.password}</strong></div></div><form className="auth-form" onSubmit={handleSubmit}><label>Email professionnel<input type="email" value={email} onChange={event => { setEmail(event.target.value); setError(''); }} autoComplete="username" required data-testid="input-admin-email" /></label><label>Mot de passe<input type="password" value={password} onChange={event => { setPassword(event.target.value); setError(''); }} autoComplete="current-password" required data-testid="input-admin-password" /></label>{error && <div className="auth-error" role="alert">{error}</div>}<button className="button button-primary auth-submit" type="submit" data-testid="button-admin-login"><LockKeyhole size={15} /> Se connecter à l’admin <ChevronRight size={14} /></button></form><div className="auth-footer"><Link href="/">Retour à l’accueil</Link><Link href="/sign-in">Utiliser Clerk</Link></div><div className="auth-notice"><CircleAlert size={14} /><span>Mode local de développement uniquement. Aucun argent réel ni PSP n’est connecté.</span></div></div></div>;
}

const userNav = [
  { href: '/app', label: 'Vue d’ensemble', icon: LayoutDashboard },
  { href: '/app/wallets', label: 'Wallets', icon: WalletCards },
  { href: '/app/transactions', label: 'Transactions', icon: ListFilter },
  { href: '/app/transfer', label: 'Envoyer de l’argent', icon: Send },
  { href: '/app/exchange', label: 'Échanger', icon: RefreshCw },
  { href: '/app/payment-links', label: 'Liens de paiement', icon: Link2 },
];
const adminNav = [
  { href: '/admin', label: 'Opérations', icon: LayoutDashboard },
  { href: '/admin/kyc', label: 'Revue KYC', icon: FileCheck2 },
  { href: '/admin/exchanges', label: 'File des échanges', icon: RefreshCw },
  { href: '/admin/transactions', label: 'Transactions', icon: ListFilter },
];

function Shell({ children, admin = false, onNotifications }: { children: ReactNode; admin?: boolean; onNotifications: () => void }) {
  const [location, setLocation] = useLocation();
  const nav = admin ? adminNav : userNav;
  const unread = useStore().notifications.filter(n => !n.read).length;
  const current = nav.find(item => item.href === location)?.label || (location === '/app/kyc' ? 'Vérification' : location === '/app/settings' ? 'Paramètres' : admin ? 'Opérations' : 'Vue d’ensemble');
  return <div className="app-shell">
    <aside className="side-rail">
      <Link href={admin ? '/admin' : '/app'}><Logo light /></Link>
      <div className="side-label">{admin ? 'Bureau des opérations' : 'Votre Mulapay'}</div>
      <nav className="nav-list">{nav.map(item => { const Icon = item.icon; return <Link key={item.href} href={item.href} className={`nav-link ${location === item.href ? 'active' : ''}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><Icon className="nav-icon" /><span>{item.label}</span></Link>; })}</nav>
      {!admin && <><div className="side-label" style={{ marginTop: 30 }}>Compte</div><nav className="nav-list"><Link href="/app/kyc" className={`nav-link ${location === '/app/kyc' ? 'active' : ''}`} data-testid="link-nav-verification"><ShieldCheck className="nav-icon" /><span>Vérification</span></Link><Link href="/app/settings" className={`nav-link ${location === '/app/settings' ? 'active' : ''}`} data-testid="link-nav-settings"><Settings2 className="nav-icon" /><span>Paramètres</span></Link></nav></>}
      <div className="side-footer"><div className="demo-chip"><span className="demo-dot" /><span><strong style={{ color: 'hsl(160 42% 64%)' }}>Mode démo</strong><br />Les actions utilisent des données locales. Aucun PSP connecté.</span></div></div>
    </aside>
    <div className="main-pane">
      <div className="mobile-top"><Link href={admin ? '/admin' : '/app'}><Logo light /></Link><div className="mobile-menu"><button className="icon-button" style={{ background: 'transparent', color: 'inherit', borderColor: 'hsl(205 30% 25%)' }} onClick={() => setLocation(admin ? '/app' : '/admin')} data-testid="button-switch-area"><ArrowRightLeft size={16} /></button><button className="icon-button" style={{ background: 'transparent', color: 'inherit', borderColor: 'hsl(205 30% 25%)' }} data-testid="button-mobile-menu"><Menu size={17} /></button></div></div>
       {admin && <div className="admin-bar"><span><CircleAlert size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />Vue opérations · les validations démo sont simulées localement.</span><Link href="/app">Retour à l’espace utilisateur</Link></div>}
       <header className="topbar"><div className="crumb">{admin ? 'Opérations / ' : 'Espace / '}{current}</div><div className="top-actions"><Link href="/app" className="icon-button" title="Espace utilisateur" data-testid="link-top-user-app"><Globe2 size={16} /></Link><button className="icon-button" title="Notifications" onClick={onNotifications} data-testid="button-notifications"><Bell size={16} />{unread > 0 && <span className="notification-dot" />}</button><div className="avatar" data-testid="text-user-avatar">AK</div></div></header>
      {children}
    </div>
  </div>;
}

function PageIntro({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="section-head"><div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1>{subtitle && <p className="page-subtitle">{subtitle}</p>}</div>{action}</div>;
}

function Overview() {
  const { wallets, transactions } = useStore();
  const total = wallets.reduce((sum, item) => sum + (item.status === 'Active' ? item.balance : 0), 0);
  return <main className="page-wrap"><PageIntro eyebrow="Tuesday, 28 May 2024" title="Good morning, Afi." subtitle="Your money is in view. Here’s what is moving across your wallets today." action={<Link href="/app/transfer" className="button button-primary" data-testid="button-overview-send"><Send size={15} /> Send money</Link>} />
    <div className="notice"><Info size={15} /><span><strong>Simulation mode.</strong> Mulapay is a product prototype. Deposits, withdrawals and payment actions are manual simulations — no PSP or real money is connected.</span></div>
    <div className="dashboard-grid"><div><div className="card balance-hero card-pad"><div className="eyebrow" style={{ color: 'hsl(160 42% 64%)' }}>total across active wallets</div><div className="hero-balance">{money(total).replace('XOF', '')}<small>XOF</small></div><div className="hero-caption">Available now across Togo, Benin, Côte d’Ivoire and Senegal</div><div className="hero-footer"><Link href="/app/wallets" className="button button-amber" data-testid="button-view-wallets">View wallets <ChevronRight size={14} /></Link><Link href="/app/exchange" className="button button-ghost" data-testid="button-overview-exchange"><ArrowRightLeft size={14} /> Exchange</Link></div></div><div className="metric-grid"><div className="card metric"><div className="metric-label">Pending in <Clock3 size={14} /></div><div className="metric-value">{money(60500).replace(' XOF', '')}<small>XOF</small></div></div><div className="card metric"><div className="metric-label">This month <ArrowUpRight size={14} /></div><div className="metric-value">+{money(125000).replace(' XOF', '')}<small>XOF</small></div></div><div className="card metric"><div className="metric-label">Wallets active <WalletCards size={14} /></div><div className="metric-value">04<small>of 07</small></div></div></div></div>
       <div className="card card-pad"><div className="section-head" style={{ marginBottom: 4 }}><div><h2 className="section-title">Recent activity</h2><p className="section-note">Your latest wallet movements</p></div><Link href="/app/transactions" className="eyebrow" data-testid="link-overview-transactions">See all</Link></div>{transactions.slice(0, 4).map(t => <TransactionRow key={t.id} transaction={t} />)}</div>
    <div className="card card-pad"><div className="section-head" style={{ marginBottom: 18 }}><div><h2 className="section-title">Country wallets</h2><p className="section-note">Available balances</p></div><Link href="/app/wallets" className="icon-button" data-testid="link-overview-wallets"><ChevronRight size={15} /></Link></div><div className="country-list">{wallets.filter(w => w.status === 'Active').map(wallet => <div className="country-row" key={wallet.code} data-testid={`row-wallet-${wallet.code}`}><div className="country-flag">{wallet.code}</div><div className="country-info"><div className="country-name">{wallet.country}</div><div className="country-currency">{wallet.currency} · active</div></div><div className="country-balance">{new Intl.NumberFormat('fr-FR').format(wallet.balance)}</div></div>)}</div><div style={{ marginTop: 20 }}><Link href="/app/payment-links" className="button button-ghost button-wide" data-testid="button-overview-link"><Link2 size={14} /> Create a payment link</Link></div></div>
    </div>
  </main>;
}

function TransactionRow({ transaction }: { transaction: Transaction }) {
  const Icon = transaction.type === 'Received' ? ArrowDownLeft : transaction.type === 'Sent' ? ArrowUpRight : transaction.type === 'Exchange' ? ArrowRightLeft : Banknote;
  const positive = transaction.type === 'Received' || transaction.type === 'Deposit';
  return <div className="activity-row" data-testid={`row-transaction-${transaction.id}`}><div className="activity-main"><div className="activity-icon"><Icon size={15} /></div><div><div className="activity-name">{transaction.counterparty}</div><div className="activity-meta">{transaction.type} · {transaction.createdAt}</div></div></div><div style={{ textAlign: 'right' }}><div className={`amount ${positive ? 'positive' : 'negative'}`}>{positive ? '+' : '-'}{new Intl.NumberFormat('fr-FR').format(transaction.amount)} {transaction.currency}</div><div style={{ marginTop: 5 }}><span className={`pill ${transaction.status === 'Completed' ? 'pill-success' : 'pill-pending'}`}>{transaction.status}</span></div></div></div>;
}

function Wallets() {
  const { wallets } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Your money, by market" title="Country wallets" subtitle="Separate local balances, held under one Mulapay account. Availability is always explicit." action={<Link href="/app/exchange" className="button button-primary" data-testid="button-wallets-exchange"><ArrowRightLeft size={15} /> Request exchange</Link>} /><div className="notice"><ShieldCheck size={15} /><span>Active wallets are persisted independently for Togo, Bénin, Côte d’Ivoire, Burkina Faso, Sénégal, Mali and Niger.</span></div><div className="wallet-grid">{wallets.map(wallet => <div className={`card wallet-card ${wallet.status !== 'Active' ? 'coming-soon' : ''}`} key={wallet.code} data-testid={`card-wallet-${wallet.code}`}><div className="wallet-top"><div><div className="wallet-name">{wallet.country}</div><div className="wallet-currency">{wallet.currency} wallet</div></div><span className={`pill ${wallet.status === 'Active' ? 'pill-success' : 'pill-neutral'}`}>{wallet.status}</span></div><div className="wallet-total">{new Intl.NumberFormat('fr-FR').format(wallet.balance)} <span>{wallet.currency}</span></div><div className="wallet-stats"><div><div className="wallet-stat-label">Available</div><div className="wallet-stat-value">{new Intl.NumberFormat('fr-FR').format(wallet.balance - wallet.pending)}</div></div><div><div className="wallet-stat-label">Pending</div><div className="wallet-stat-value">{new Intl.NumberFormat('fr-FR').format(wallet.pending)}</div></div></div></div>)}</div><div className="card card-pad" style={{ marginTop: 28 }}><div className="section-head"><div><h2 className="section-title">Wallet logic</h2><p className="section-note">Built for clarity, not conversion tricks.</p></div></div><div className="feature-grid" style={{ marginTop: 0, gridTemplateColumns: 'repeat(3, 1fr)' }}><div><div className="eyebrow">01 · Available</div><p className="section-note" style={{ marginTop: 10 }}>Funds ready for internal transfers or exchanges.</p></div><div><div className="eyebrow">02 · Pending</div><p className="section-note" style={{ marginTop: 10 }}>Funds waiting on an approval or manual action.</p></div><div><div className="eyebrow">03 · Local context</div><p className="section-note" style={{ marginTop: 10 }}>Every movement keeps its wallet, currency and reference.</p></div></div></div></main>;
}

function Transactions() {
  const { transactions, toast } = useStore();
  const [filter, setFilter] = useState('All');
  const [query, setQuery] = useState('');
  const filtered = transactions.filter(t => (filter === 'All' || t.type === filter) && `${t.counterparty} ${t.reference}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="page-wrap"><PageIntro eyebrow="A clear paper trail" title="Transactions" subtitle="Every simulated movement, with enough context to understand it later." action={<button className="button button-ghost" onClick={() => toast('Export prepared in demo mode.')} data-testid="button-export-transactions"><Download size={15} /> Export CSV</button>} /><div className="card table-card"><div className="table-toolbar"><div className="filter-set">{['All', 'Received', 'Sent', 'Exchange', 'Deposit'].map(item => <button key={item} onClick={() => setFilter(item)} className={`filter-button ${filter === item ? 'active' : ''}`} data-testid={`button-filter-${item.toLowerCase()}`}>{item}</button>)}</div><div className="input-prefix" style={{ width: 190 }}><Search size={14} style={{ position: 'absolute', left: 12, top: 11, color: 'hsl(203 18% 46%)' }} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search reference" style={{ width: '100%', border: '1px solid hsl(38 28% 85%)', background: 'hsl(42 44% 99%)', borderRadius: 9, padding: '9px 10px 9px 32px', fontSize: 11, outline: 0 }} data-testid="input-search-transactions" /></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Movement</th><th>Wallet</th><th>Reference</th><th>Date</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th></tr></thead><tbody>{filtered.map(t => <tr key={t.id} data-testid={`row-table-transaction-${t.id}`}><td><div style={{ fontWeight: 700 }}>{t.counterparty}</div><div className="activity-meta">{t.type}</div></td><td>{t.country} · {t.currency}</td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(203 18% 46%)' }}>{t.reference}</td><td>{t.createdAt}</td><td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: t.type === 'Received' || t.type === 'Deposit' ? 'hsl(160 42% 38%)' : 'inherit' }}>{t.type === 'Received' || t.type === 'Deposit' ? '+' : '-'}{new Intl.NumberFormat('fr-FR').format(t.amount)} {t.currency}</td><td><span className={`pill ${t.status === 'Completed' ? 'pill-success' : 'pill-pending'}`}>{t.status}</span></td></tr>)}</tbody></table>{filtered.length === 0 && <div className="empty-state"><ListFilter size={25} /><strong>No movements found</strong><p>Try a different filter or reference.</p></div>}</div></div></main>;
}

function Transfer() {
  const { wallets, transfer } = useStore();
  const [amount, setAmount] = useState(''); const [currency, setCurrency] = useState('XOF'); const [recipient, setRecipient] = useState(''); const [note, setNote] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (!amount || !recipient) return; transfer({ amount: Number(amount), currency, counterparty: recipient, note }); setAmount(''); setRecipient(''); setNote(''); };
  return <main className="page-wrap"><PageIntro eyebrow="Move money internally" title="Send money" subtitle="Send to another Mulapay user using their phone or Mulapay handle. Fast, clear, and always traceable." /><div className="notice"><Info size={15} /><span>This is an internal demo transfer. No external payment rail or PSP is involved, and no real funds will move.</span></div><div className="form-layout"><form className="card card-pad" onSubmit={submit}><div className="field"><label htmlFor="recipient">Recipient</label><input id="recipient" value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="Phone number or @handle" data-testid="input-transfer-recipient" /><div className="field-hint">Try “@koffimensah” or “+228 90 12 45 67”.</div></div><div className="field"><label htmlFor="amount">Amount</label><div className="input-prefix"><span>{currency}</span><input id="amount" type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" data-testid="input-transfer-amount" /></div></div><div className="field"><label htmlFor="currency">From wallet</label><select id="currency" value={currency} onChange={e => setCurrency(e.target.value)} data-testid="select-transfer-wallet">{wallets.filter(w => w.status === 'Active').map(w => <option key={w.code} value={w.currency}>{w.country} wallet · {w.currency} · {new Intl.NumberFormat('fr-FR').format(w.balance)} available</option>)}</select></div><div className="field"><label htmlFor="note">Note <span style={{ color: 'hsl(203 18% 46%)', fontWeight: 400 }}>(optional)</span></label><textarea id="note" value={note} onChange={e => setNote(e.target.value)} placeholder="What is this for?" data-testid="input-transfer-note" /></div><button className="button button-primary button-wide" type="submit" disabled={!amount || !recipient} data-testid="button-submit-transfer"><Send size={15} /> Review and send</button></form><div className="card card-pad"><div className="eyebrow">Before you send</div><div className="step-list" style={{ marginTop: 12 }}><div className="step done"><div className="step-number">1</div><div><div className="step-title">Choose the wallet</div><div className="step-copy">Funds leave the selected active country wallet.</div></div></div><div className="step"><div className="step-number">2</div><div><div className="step-title">Confirm the person</div><div className="step-copy">We show the name attached to the handle before a real transfer.</div></div></div><div className="step"><div className="step-number">3</div><div><div className="step-title">Keep the receipt</div><div className="step-copy">A reference is created for every demo movement.</div></div></div></div></div></div></main>;
}

function Exchange() {
  const { wallets, exchanges, exchange } = useStore();
  const active = wallets.filter(w => w.status === 'Active'); const [source, setSource] = useState('Togo'); const [destination, setDestination] = useState('Benin'); const [amount, setAmount] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (!amount || source === destination) return; exchange({ source, destination, amount: Number(amount) }); setAmount(''); };
  return <main className="page-wrap"><PageIntro eyebrow="Balance the way you need it" title="Inter-wallet exchange" subtitle="Request a move between your country wallets. In this prototype, every exchange is reviewed by operations before it lands." /><div className="form-layout"><form className="card card-pad" onSubmit={submit}><div className="field"><label htmlFor="exchange-source">From</label><select id="exchange-source" value={source} onChange={e => setSource(e.target.value)} data-testid="select-exchange-source">{active.map(w => <option key={w.code}>{w.country}</option>)}</select></div><div style={{ display: 'grid', placeItems: 'center', margin: '-5px 0 10px' }}><div style={{ width: 31, height: 31, borderRadius: 10, background: 'hsl(39 78% 89%)', color: 'hsl(160 42% 38%)', display: 'grid', placeItems: 'center' }}><ArrowDownLeft size={15} /></div></div><div className="field"><label htmlFor="exchange-destination">To</label><select id="exchange-destination" value={destination} onChange={e => setDestination(e.target.value)} data-testid="select-exchange-destination">{active.map(w => <option key={w.code}>{w.country}</option>)}</select></div><div className="field"><label htmlFor="exchange-amount">Amount to exchange</label><div className="input-prefix"><span>XOF</span><input id="exchange-amount" type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" data-testid="input-exchange-amount" /></div></div><div className="summary-box"><div className="summary-line"><span>Indicative rate</span><strong>1.0000</strong></div><div className="summary-line"><span>Service fee</span><strong>0 XOF</strong></div><div className="summary-line total"><span>Estimated arrival</span><strong>{amount ? money(Number(amount)) : '—'}</strong></div></div><button className="button button-primary button-wide" style={{ marginTop: 16 }} type="submit" disabled={!amount || source === destination} data-testid="button-submit-exchange"><RefreshCw size={15} /> Request review</button></form><div><div className="notice"><Clock3 size={15} /><span>Typical review time in this demo is under one business day. Your source balance stays available until approval.</span></div><div className="card card-pad" style={{ marginTop: 14 }}><div className="section-head"><div><h2 className="section-title">Recent requests</h2><p className="section-note">Your exchange trail</p></div></div>{exchanges.map(ex => <div className="activity-row" key={ex.id} data-testid={`row-exchange-${ex.id}`}><div><div className="activity-name">{ex.source} <ChevronRight size={12} style={{ verticalAlign: 'middle' }} /> {ex.destination}</div><div className="activity-meta">{ex.requestedAt} · {new Intl.NumberFormat('fr-FR').format(ex.amount)} XOF</div></div><span className={`pill ${ex.status === 'Completed' ? 'pill-success' : ex.status === 'Rejected' ? 'pill-danger' : 'pill-pending'}`}>{ex.status}</span></div>)}</div></div></div></main>;
}

function PaymentLinks() {
  const { links, addLink, toast } = useStore(); const [amount, setAmount] = useState(''); const [description, setDescription] = useState(''); const [expiresAt, setExpiresAt] = useState('30 Jun 2024'); const [showForm, setShowForm] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); if (!amount || !description) return; addLink({ amount: Number(amount), currency: 'XOF', description, expiresAt }); setAmount(''); setDescription(''); setShowForm(false); };
  return <main className="page-wrap"><PageIntro eyebrow="Get paid, simply" title="Payment links" subtitle="Create a shareable request for a customer or friend. These links are simulated and do not connect to a payment processor." action={<button className="button button-primary" onClick={() => setShowForm(v => !v)} data-testid="button-new-payment-link"><Plus size={15} /> New payment link</button>} /><div className="notice"><QrCode size={15} /><span>Payment links are manual demo objects. QR codes are illustrative and payment counts are local sample data.</span></div>{showForm && <form className="card card-pad" style={{ marginTop: 18, maxWidth: 700 }} onSubmit={submit}><div className="section-title" style={{ marginBottom: 17 }}>Create a payment link</div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}><div className="field"><label>Amount</label><div className="input-prefix"><span>XOF</span><input type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" data-testid="input-link-amount" /></div></div><div className="field"><label>Expires</label><select value={expiresAt} onChange={e => setExpiresAt(e.target.value)} data-testid="select-link-expiry"><option>30 Jun 2024</option><option>15 Jul 2024</option><option>Never</option></select></div></div><div className="field"><label>Description</label><input value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this payment for?" data-testid="input-link-description" /></div><div style={{ display: 'flex', gap: 8 }}><button type="submit" className="button button-primary" disabled={!amount || !description} data-testid="button-submit-link">Create link</button><button type="button" className="button button-ghost" onClick={() => setShowForm(false)} data-testid="button-cancel-link">Cancel</button></div></form>}<div className="section-head" style={{ marginTop: 29 }}><div><h2 className="section-title">Your links</h2><p className="section-note">{links.length} active links · share anywhere</p></div></div><div className="link-list">{links.map(link => <div className="card link-card" key={link.id} data-testid={`card-payment-link-${link.id}`}><div><span className={`pill ${link.status === 'Active' ? 'pill-success' : 'pill-neutral'}`}>{link.status}</span><div className="section-title" style={{ marginTop: 10 }}>{link.description}</div><div className="link-slug">{link.slug}</div><div className="activity-meta" style={{ marginTop: 8 }}>{money(link.amount, link.currency)} · expires {link.expiresAt} · {link.payments} payments</div></div><div style={{ display: 'flex', gap: 7 }}><button className="icon-button" title="Copy link" onClick={() => toast('Link copied to clipboard in demo mode.')} data-testid={`button-copy-link-${link.id}`}><Copy size={15} /></button><button className="icon-button" title="Show QR" onClick={() => toast('QR preview ready in demo mode.')} data-testid={`button-qr-link-${link.id}`}><QrCode size={15} /></button><button className="icon-button" title="More options" onClick={() => toast('Link options are simulated in this prototype.')} data-testid={`button-more-link-${link.id}`}><MoreHorizontal size={15} /></button></div></div>)}</div></main>;
}

function Kyc() {
  const [uploaded, setUploaded] = useState(false); const { toast, submitKyc } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Account verification" title="Your verification" subtitle="A verified account keeps cross-border movement safer for everyone. New documents are recorded in the compliance queue." action={<span className="pill pill-success" style={{ padding: '8px 12px' }}><CheckCircle2 size={13} style={{ marginRight: 5 }} /> Verified</span>} /><div className="dashboard-grid" style={{ marginTop: 27 }}><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Verification status</h2><p className="section-note">Current status is persisted on your Mulapay profile.</p></div><ShieldCheck size={24} color="hsl(160 42% 38%)" /></div><div style={{ height: 7, borderRadius: 5, background: 'hsl(160 42% 38% / .12)', overflow: 'hidden', margin: '23px 0 25px' }}><div style={{ width: uploaded ? '100%' : '66%', height: '100%', background: 'hsl(160 42% 38%)', borderRadius: 5 }} /></div><div className="step-list"><div className="step done"><div className="step-number"><Check size={13} /></div><div><div className="step-title">Profile details</div><div className="step-copy">Name, email and phone number confirmed.</div></div></div><div className="step done"><div className="step-number"><Check size={13} /></div><div><div className="step-title">Identity document</div><div className="step-copy">National ID · reviewed and approved.</div></div></div><div className={`step ${uploaded ? 'done' : ''}`}><div className="step-number">{uploaded ? <Check size={13} /> : '3'}</div><div><div className="step-title">Address confirmation <span className="pill pill-neutral" style={{ marginLeft: 6 }}>{uploaded ? 'Submitted' : 'Optional'}</span></div><div className="step-copy">{uploaded ? 'Proof of address submitted for operations review.' : 'Add a proof of address to unlock higher limits.'}</div></div></div></div></div><div className="card card-pad"><div className="eyebrow">Document checklist</div><div className="step-list" style={{ marginTop: 10 }}><div className="step done"><div className="step-number"><Check size={13} /></div><div><div className="step-title">National ID</div><div className="step-copy">Approved and stored in the verification record.</div></div></div><div className={`step ${uploaded ? 'done' : ''}`}><div className="step-number">{uploaded ? <Check size={13} /> : '+'}</div><div style={{ flex: 1 }}><div className="step-title">Proof of address</div><div className="step-copy">{uploaded ? 'Document submitted successfully.' : 'Utility bill or bank statement, last 3 months.'}</div>{!uploaded && <button className="button button-ghost button-sm" style={{ marginTop: 11 }} onClick={() => { setUploaded(true); submitKyc(['National ID', 'Selfie', 'Proof of address']); toast('Proof of address submitted for review.'); }} data-testid="button-upload-kyc">Submit document</button>}</div></div></div><div className="notice" style={{ marginTop: 20 }}><LockKeyhole size={14} /><span>Documents are sent to the Mulapay compliance workflow; no payment processor is involved.</span></div></div></div></main>;
}

function Settings() {
  const { toast, signOut } = useStore(); const [name, setName] = useState('Afi Kossi'); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('+228 90 12 45 67');
  return <main className="page-wrap"><PageIntro eyebrow="Account preferences" title="Settings" subtitle="Keep your Mulapay profile and security details up to date." /><div className="form-layout" style={{ marginTop: 27 }}><div className="card card-pad"><div className="section-title">Profile details</div><p className="section-note" style={{ marginTop: 5, marginBottom: 22 }}>Identity is managed securely by Clerk; payment data stays in the Mulapay ledger.</p><div className="field"><label>Full name</label><input value={name} onChange={e => setName(e.target.value)} data-testid="input-settings-name" /></div><div className="field"><label>Email address</label><input value={email} onChange={e => setEmail(e.target.value)} placeholder="Managed by your sign-in provider" data-testid="input-settings-email" /></div><div className="field"><label>Phone number</label><input value={phone} onChange={e => setPhone(e.target.value)} data-testid="input-settings-phone" /></div><div className="field"><label>Home country</label><select defaultValue="Togo" data-testid="select-settings-country"><option>Togo</option><option>Bénin</option><option>Sénégal</option><option>Côte d’Ivoire</option><option>Burkina Faso</option><option>Mali</option><option>Niger</option></select></div><button className="button button-primary" onClick={() => toast('Profile preferences saved for the next account update.')} data-testid="button-save-settings">Save changes</button></div><div><div className="card card-pad"><div className="section-title">Security</div><div className="activity-row"><div className="activity-main"><div className="activity-icon"><LockKeyhole size={15} /></div><div><div className="activity-name">Authentication</div><div className="activity-meta">Managed by Clerk with secure sessions</div></div></div><Link className="button button-ghost button-sm" href="/sign-in">Manage</Link></div><div className="activity-row"><div className="activity-main"><div className="activity-icon"><Bell size={15} /></div><div><div className="activity-name">Transaction alerts</div><div className="activity-meta">Email and in-app notifications</div></div></div><button className="button button-primary button-sm" onClick={() => toast('Transaction alerts are enabled.')} data-testid="button-toggle-alerts">On</button></div></div><div className="card card-pad" style={{ marginTop: 14 }}><div className="eyebrow">Account</div><button className="button button-danger button-wide" style={{ marginTop: 17 }} onClick={signOut} data-testid="button-sign-out"><LogOut size={14} /> Sign out</button></div></div></div></main>;
}

function AdminOverview() {
  const { exchanges, transactions } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Tuesday, 28 May 2024 · live demo" title="Operations overview" subtitle="A focused view of the movements and reviews that need attention across Mulapay." action={<Link href="/admin/exchanges" className="button button-primary" data-testid="button-admin-review"><Eye size={15} /> Review queue</Link>} /><div className="admin-grid"><div className="card admin-stat"><div className="metric-label">KYC awaiting review <FileCheck2 size={15} /></div><div className="metric-value">07</div><div className="activity-meta" style={{ color: 'hsl(34 68% 39%)' }}>+2 since yesterday</div></div><div className="card admin-stat"><div className="metric-label">Exchange queue <RefreshCw size={15} /></div><div className="metric-value">{String(exchanges.filter(e => e.status === 'Pending review').length).padStart(2, '0')}</div><div className="activity-meta">Needs a decision</div></div><div className="card admin-stat"><div className="metric-label">Today’s volume <ArrowUpRight size={15} /></div><div className="metric-value">1.24m<small>XOF</small></div><div className="activity-meta">Across 34 movements</div></div><div className="card admin-stat"><div className="metric-label">Success rate <Activity size={15} /></div><div className="metric-value">98.6<small>%</small></div><div className="activity-meta">Last 30 days</div></div></div><div className="dashboard-grid"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Needs your attention</h2><p className="section-note">Prioritized operational work</p></div></div><Link href="/admin/exchanges" className="case-row" data-testid="link-admin-exchange-case"><div className="case-person"><div className="person-initial"><RefreshCw size={15} /></div><div><div className="case-name">Exchange request · EX-2F8P</div><div className="case-meta">Côte d’Ivoire → Togo · 48,000 XOF · 08:15</div></div></div><ChevronRight size={16} color="hsl(203 18% 46%)" /></Link><Link href="/admin/kyc" className="case-row" style={{ marginTop: 10 }} data-testid="link-admin-kyc-case"><div className="case-person"><div className="person-initial"><FileCheck2 size={15} /></div><div><div className="case-name">7 KYC cases waiting</div><div className="case-meta">Oldest submitted 2 hours ago</div></div></div><ChevronRight size={16} color="hsl(203 18% 46%)" /></Link></div><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">System pulse</h2><p className="section-note">Today, so far</p></div><span className="pill pill-success">Healthy</span></div><div className="summary-box"><div className="summary-line"><span>Transfers</span><strong>28</strong></div><div className="summary-line"><span>Exchanges</span><strong>06</strong></div><div className="summary-line"><span>Payment links</span><strong>19</strong></div><div className="summary-line"><span>Failed actions</span><strong style={{ color: 'hsl(160 42% 38%)' }}>0</strong></div></div><div className="activity-meta" style={{ marginTop: 15 }}><Activity size={12} style={{ verticalAlign: 'middle', marginRight: 5 }} /> Last refreshed just now</div></div></div><div className="card card-pad" style={{ marginTop: 17 }}><div className="section-head"><div><h2 className="section-title">Latest movements</h2><p className="section-note">Across all country wallets</p></div><Link href="/admin/transactions" className="eyebrow" data-testid="link-admin-all-transactions">View ledger</Link></div>{transactions.slice(0, 3).map(t => <TransactionRow transaction={t} key={t.id} />)}</div></main>;
}

function AdminKyc() {
  const { adminKyc, adminSummary, decideKyc, toast } = useStore();
  const pending = adminKyc.filter(item => item.status === 'EN_ATTENTE');
  const decide = (id: string, accepted: boolean) => { decideKyc(id, accepted); toast(accepted ? 'KYC case approved.' : 'KYC case rejected.'); };
  return <main className="page-wrap"><PageIntro eyebrow="Trust & safety" title="KYC review" subtitle="Review the identity cases that keep the Mulapay network safe. Documents remain in the Mulapay review workflow." action={<span className="pill pill-pending"><Clock3 size={13} style={{ marginRight: 5 }} /> {adminSummary?.kycAwaiting ?? pending.length} awaiting review</span>} /><div className="card card-pad" style={{ marginTop: 28 }}><div className="section-head"><div><h2 className="section-title">Review queue</h2><p className="section-note">Oldest first · every decision is persisted and notifies the account owner.</p></div><div className="filter-set"><button className="filter-button active" data-testid="button-kyc-filter-pending">Pending</button><button className="filter-button" onClick={() => toast('Approved cases are available through the audit history.')} data-testid="button-kyc-filter-approved">Approved</button></div></div><div className="case-list">{pending.map(item => <div className="case-row" key={item.id} data-testid={`row-kyc-${item.id}`}><div className="case-person"><div className="person-initial">{item.name.split(' ').map(n => n[0]).join('')}</div><div><div className="case-name">{item.name}</div><div className="case-meta">{item.country} · {item.documents.join(' · ')} · submitted {new Date(item.submittedAt).toLocaleString('fr-FR')}</div></div></div><div className="case-actions"><button className="button button-ghost button-sm" onClick={() => toast(`Opening ${item.name}'s documents.`)} data-testid={`button-view-kyc-${item.id}`}><Eye size={13} /> View</button><button className="button button-primary button-sm" onClick={() => decide(item.id, true)} data-testid={`button-approve-kyc-${item.id}`}><Check size={13} /> Approve</button><button className="button button-danger button-sm" onClick={() => decide(item.id, false)} data-testid={`button-reject-kyc-${item.id}`}><X size={13} /></button></div></div>)}{pending.length === 0 && <div className="empty-state"><CheckCircle2 size={25} /><strong>Queue is clear</strong><p>New identity cases will appear here.</p></div>}</div></div></main>;
}

function AdminExchanges() {
  const { exchanges, setExchangeStatus, toast } = useStore();
  const pending = exchanges.filter(e => e.status === 'Pending review');
  return <main className="page-wrap"><PageIntro eyebrow="Operations / liquidity" title="Exchange queue" subtitle="Approve or reject inter-wallet requests. A decision updates the user’s local demo timeline instantly." /><div className="notice"><Info size={15} /><span>Approvals are simulated. In production, this is where limits, source balance and compliance checks would be enforced.</span></div><div className="card card-pad" style={{ marginTop: 22 }}><div className="section-head"><div><h2 className="section-title">Pending review</h2><p className="section-note">{pending.length} request ready for a decision</p></div><span className="pill pill-pending"><Clock3 size={12} style={{ marginRight: 5 }} /> Manual review</span></div>{pending.map(ex => <div className="case-row" key={ex.id} data-testid={`row-admin-exchange-${ex.id}`}><div className="case-person"><div className="person-initial"><ArrowRightLeft size={15} /></div><div><div className="case-name">{ex.source} <ChevronRight size={12} style={{ verticalAlign: 'middle' }} /> {ex.destination}</div><div className="case-meta">{ex.requestedAt} · requested amount {money(ex.amount)} · rate {ex.rate.toFixed(4)}</div></div></div><div className="case-actions"><button className="button button-primary button-sm" onClick={() => { setExchangeStatus(ex.id, 'Completed'); toast('Exchange approved and marked completed.'); }} data-testid={`button-approve-exchange-${ex.id}`}><Check size={13} /> Approve</button><button className="button button-danger button-sm" onClick={() => { setExchangeStatus(ex.id, 'Rejected'); toast('Exchange rejected and user notified.'); }} data-testid={`button-reject-exchange-${ex.id}`}><X size={13} /> Reject</button></div></div>)}{pending.length === 0 && <div className="empty-state"><CheckCircle2 size={25} /><strong>No exchanges waiting</strong><p>The queue is caught up.</p></div>}</div><div className="card table-card"><div className="table-toolbar"><div><h2 className="section-title">Decision history</h2></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Route</th><th>Requested</th><th>Received</th><th>Requested at</th><th>Status</th></tr></thead><tbody>{exchanges.map(ex => <tr key={ex.id}><td>{ex.source} <ChevronRight size={11} style={{ verticalAlign: 'middle' }} /> {ex.destination}</td><td>{money(ex.amount)}</td><td>{money(ex.receivedAmount)}</td><td>{ex.requestedAt}</td><td><span className={`pill ${ex.status === 'Completed' ? 'pill-success' : ex.status === 'Rejected' ? 'pill-danger' : 'pill-pending'}`}>{ex.status}</span></td></tr>)}</tbody></table></div></div></main>;
}

function AdminTransactions() {
  const { adminTransactions: transactions, toast } = useStore(); const [query, setQuery] = useState('');
  const filtered = transactions.filter(t => `${t.reference} ${t.counterparty} ${t.country}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="page-wrap"><PageIntro eyebrow="Operations / ledger" title="All transactions" subtitle="A network-level view of simulated movements across every active market." action={<button className="button button-ghost" onClick={() => toast('Ledger export prepared in demo mode.')} data-testid="button-admin-export"><Download size={15} /> Export ledger</button>} /><div className="card table-card"><div className="table-toolbar"><div className="eyebrow"><ListFilter size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> {filtered.length} visible movements</div><div className="input-prefix" style={{ width: 220 }}><Search size={14} style={{ position: 'absolute', left: 12, top: 11, color: 'hsl(203 18% 46%)' }} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ledger" style={{ width: '100%', border: '1px solid hsl(38 28% 85%)', background: 'hsl(42 44% 99%)', borderRadius: 9, padding: '9px 10px 9px 32px', fontSize: 11, outline: 0 }} data-testid="input-admin-search" /></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Reference</th><th>Counterparty</th><th>Market</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead><tbody>{filtered.map(t => <tr key={t.id} data-testid={`row-admin-transaction-${t.id}`}><td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{t.reference}</td><td style={{ fontWeight: 700 }}>{t.counterparty}</td><td>{t.country} · {t.currency}</td><td>{t.type}</td><td style={{ fontFamily: 'var(--font-mono)' }}>{money(t.amount, t.currency)}</td><td><span className={`pill ${t.status === 'Completed' ? 'pill-success' : 'pill-pending'}`}>{t.status}</span></td></tr>)}</tbody></table></div></div></main>;
}

function Notifications() {
  const { notifications, markRead } = useStore();
  return <div style={{ position: 'fixed', right: 20, top: 74, width: 320, zIndex: 10 }} className="card card-pad"><div className="section-head"><div><h2 className="section-title">Notifications</h2><p className="section-note">Keep your account in view</p></div><Bell size={16} /></div>{notifications.map(item => <button key={item.id} onClick={() => markRead(item.id)} style={{ display: 'block', width: '100%', border: 0, textAlign: 'left', background: item.read ? 'transparent' : 'hsl(39 78% 89% / .35)', borderRadius: 8, padding: 10, cursor: 'pointer', marginTop: 4 }} data-testid={`button-notification-${item.id}`}><div style={{ fontWeight: 700, fontSize: 11 }}>{item.title}</div><div className="activity-meta">{item.body}</div>{!item.read && <div className="eyebrow" style={{ marginTop: 6 }}>Mark read</div>}</button>)}</div>;
}

function RoutedApp() {
  const [location, setLocation] = useLocation();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [toastText, setToastText] = useState('');
  const toast = (message: string) => { setToastText(message); window.setTimeout(() => setToastText(''), 2600); };
  const { isLoaded, isSignedIn } = useAuth();
  const demoSession = hasDemoSession();
  const { signOut } = useClerk();
  const bootstrapQuery = useGetBootstrap({ query: { queryKey: getGetBootstrapQueryKey(), enabled: isLoaded && (isSignedIn || demoSession), retry: false } });
  const data = bootstrapQuery.data;
  const adminSummaryQuery = useGetAdminSummary({ query: { queryKey: getGetAdminSummaryQueryKey(), enabled: Boolean(data?.profile.role === 'ADMIN'), retry: false } });
  const adminKycQuery = useListAdminKyc({ query: { queryKey: getListAdminKycQueryKey(), enabled: Boolean(data?.profile.role === 'ADMIN'), retry: false } });
  const adminTransactionsQuery = useListAdminTransactions({ query: { queryKey: getListAdminTransactionsQueryKey(), enabled: Boolean(data?.profile.role === 'ADMIN'), retry: false } });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getGetBootstrapQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetAdminSummaryQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListAdminKycQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListAdminTransactionsQueryKey() });
  };
  const transferMutation = useCreateTransfer();
  const exchangeMutation = useCreateExchange();
  const exchangeDecisionMutation = useDecideExchange();
  const paymentLinkMutation = useCreatePaymentLink();
  const notificationMutation = useMarkNotificationRead();
  const kycMutation = useSubmitKyc();
  const kycDecisionMutation = useDecideKyc();
  const store: Store = {
    wallets: data?.wallets ?? [], transactions: data?.transactions ?? [], exchanges: data?.exchanges ?? [], links: data?.links ?? [], notifications: data?.notifications ?? [],
    adminKyc: (adminKycQuery.data ?? []) as AdminKycCase[], adminTransactions: (adminTransactionsQuery.data ?? []) as Transaction[], adminSummary: adminSummaryQuery.data as AdminSummary | undefined,
    transfer: ({ amount, currency, counterparty, note }) => { transferMutation.mutate({ data: { amount, currency, counterparty, note } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('Transfer failed. Check the available balance.') }); },
    exchange: ({ source, destination, amount }) => { exchangeMutation.mutate({ data: { source, destination, amount } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('Exchange request could not be created.') }); },
    setExchangeStatus: (id, status) => { exchangeDecisionMutation.mutate({ id, data: { decision: status === 'Completed' ? 'APPROVED' : 'REJECTED' } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('Exchange decision could not be saved.') }); },
    addLink: ({ amount, currency, description, expiresAt }) => { paymentLinkMutation.mutate({ data: { amount, currency, description, expiresAt } }, { onSuccess: response => { invalidate(); toast(`Payment link ${response.slug} created.`); }, onError: () => toast('Payment link could not be created.') }); },
    markRead: id => { notificationMutation.mutate({ id }, { onSuccess: () => { invalidate(); } }); },
    submitKyc: documents => { kycMutation.mutate({ data: { country: data?.profile.country ?? 'Togo', documents } }, { onSuccess: () => { invalidate(); toast('KYC documents submitted for review.'); }, onError: () => toast('KYC submission could not be saved.') }); },
    decideKyc: (id, accepted) => { kycDecisionMutation.mutate({ id, data: { decision: accepted ? 'VERIFIED' : 'REFUSED' } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('KYC decision could not be saved.') }); },
    signOut: () => { if (demoSession) { sessionStorage.removeItem('mulapay-demo-role'); setLocation('/'); return; } void signOut({ redirectUrl: basePath || '/' }); },
    toast,
  };
  if (!isLoaded || bootstrapQuery.isLoading) return <div className="loading-screen">Loading your Mulapay workspace…</div>;
  if (!isSignedIn && !demoSession) return <Redirect to="/" />;
  const admin = location.startsWith('/admin') && (data?.profile.role === 'ADMIN' || demoSession);
  if (location.startsWith('/admin') && !admin) return <Redirect to="/app" />;
  return <StoreContext.Provider value={store}><Shell admin={admin} onNotifications={() => setNotificationsOpen(v => !v)}>{admin ? <Switch><Route path="/admin" component={AdminOverview} /><Route path="/admin/kyc" component={AdminKyc} /><Route path="/admin/exchanges" component={AdminExchanges} /><Route path="/admin/transactions" component={AdminTransactions} /><Route component={NotFound} /></Switch> : <Switch><Route path="/app" component={Overview} /><Route path="/app/wallets" component={Wallets} /><Route path="/app/transactions" component={Transactions} /><Route path="/app/transfer" component={Transfer} /><Route path="/app/exchange" component={Exchange} /><Route path="/app/payment-links" component={PaymentLinks} /><Route path="/app/kyc" component={Kyc} /><Route path="/app/settings" component={Settings} /><Route component={NotFound} /></Switch>}</Shell>{notificationsOpen && <Notifications />}{toastText && <div className="toast" data-testid="status-toast">{toastText}</div>}</StoreContext.Provider>;
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: 'hsl(160 42% 38%)',
    colorForeground: 'hsl(204 43% 17%)',
    colorMutedForeground: 'hsl(203 18% 46%)',
    colorDanger: 'hsl(5 59% 49%)',
    colorBackground: 'hsl(42 44% 98%)',
    colorInput: 'hsl(42 42% 96%)',
    colorInputForeground: 'hsl(204 43% 17%)',
    colorNeutral: 'hsl(38 28% 85%)',
    fontFamily: 'DM Sans, sans-serif',
    borderRadius: '0.9rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fbfaf5] rounded-2xl w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#1a2d38]',
    headerSubtitle: 'text-[#52646d]',
    socialButtonsBlockButtonText: 'text-[#1a2d38]',
    formFieldLabel: 'text-[#1a2d38]',
    footerActionLink: 'text-[#176b52]',
    footerActionText: 'text-[#52646d]',
    dividerText: 'text-[#52646d]',
    identityPreviewEditButton: 'text-[#176b52]',
    formFieldSuccessText: 'text-[#176b52]',
    alertText: 'text-[#1a2d38]',
    logoBox: 'px-1',
    logoImage: 'max-h-10',
    socialButtonsBlockButton: 'border-[#d9d1bf] bg-[#fffdf7]',
    formButtonPrimary: 'bg-[#176b52] hover:bg-[#115640]',
    formFieldInput: 'border-[#d9d1bf] bg-[#fffdf7] text-[#1a2d38]',
    footerAction: 'border-[#d9d1bf]',
    dividerLine: 'bg-[#d9d1bf]',
    alert: 'bg-[#fff4e8] border-[#f1c78e]',
    otpCodeFieldInput: 'border-[#d9d1bf] bg-[#fffdf7]',
    formFieldRow: 'gap-2',
    main: 'px-2',
  },
};

function SignInPage() {
  return <div className="auth-clerk-page"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}

function SignUpPage() {
  return <div className="auth-clerk-page"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="loading-screen">Loading Mulapay…</div>;
  if (hasDemoSession()) return <Redirect to="/admin" />;
  return isSignedIn ? <Redirect to="/app" /> : <Landing />;
}

function Router() {
  return <Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/connexion" component={Login} /><Route path="/app" component={RoutedApp} /><Route path="/app/:rest*" component={RoutedApp} /><Route path="/admin" component={RoutedApp} /><Route path="/admin/:rest*" component={RoutedApp} /><Route component={NotFound} /></Switch>;
}

function App() {
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={basePath}><ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access your Mulapay account' } }, signUp: { start: { title: 'Create your Mulapay account', subtitle: 'Move money with clarity across West Africa' } } }}><Router /></ClerkProvider></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;