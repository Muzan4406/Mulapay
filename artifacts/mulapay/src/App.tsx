import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useState } from 'react';
import {
  Activity, ArrowDownLeft, ArrowLeft, ArrowRightLeft, ArrowRight, ArrowUpRight, Banknote, Bell, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleAlert, Clock3, Copy, Download, Eye, FileCheck2, Globe2, Info, LayoutDashboard,
  Link2, ListFilter, LockKeyhole, LogOut, Menu, MoreHorizontal, Plus, QrCode, RefreshCw, Search,
  Send, Settings2, ShieldCheck, WalletCards, X
} from 'lucide-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, useAuth, useClerk, useSignIn, useSignUp, useUser } from '@clerk/react';
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
  profile: { id: string; firstName: string; lastName: string; email: string; role: string; country: string; kycStatus: string };
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

function counterpartyLabel(counterparty: string) {
  return ({ 'Togo wallet': 'Wallet Togo' } as Record<string, string>)[counterparty] ?? counterparty;
}

function dateLabel(value: string) {
  return value.replace(/^Today/, "Aujourd’hui").replace(/^Yesterday/, 'Hier');
}

function notificationCopy(item: Notification) {
  const copy: Record<string, { title: string; body: string }> = {
    'Exchange request received': { title: 'Demande d’échange reçue', body: 'Votre échange de Côte d’Ivoire vers le Togo est en attente d’examen.' },
    'Transfer completed': { title: 'Transfert effectué', body: 'Votre transfert a été confirmé par le serveur.' },
    'KYC approved': { title: 'KYC approuvé', body: 'Votre vérification d’identité est terminée. Votre compte est vérifié.' },
  };
  return copy[item.title] ?? item;
}

function Logo({ light = false }: { light?: boolean }) {
  return <div className="brand" data-testid="brand-mulapay">
    <img className={`brand-image ${light ? 'brand-image-light' : ''}`} src={`${import.meta.env.BASE_URL}mulapay-logo.png`} alt="Mulapay — Votre argent, partout." />
  </div>;
}

const mobileMoneyProviders = [
  { name: 'Airtel Money', country: 'Régional', src: 'airtel-money_no_bg.png' },
  { name: 'Wave', country: 'Régional', src: 'wave_no_bg.png' },
  { name: 'MTN MoMo', country: 'Régional', src: 'mtn-momo_no_bg.png' },
  { name: 'Mixx by Yas', country: 'Togo', src: 'mixx_no_bg.png' },
  { name: 'Orange Money', country: 'Régional', src: 'orange-money_no_bg.png' },
  { name: 'Moov Money', country: 'Régional', src: 'moov-money_no_bg.png' },
];

const landingCountries = [
  { code: 'TG', name: 'Togo', detail: 'Wallet XOF' },
  { code: 'BJ', name: 'Bénin', detail: 'Wallet XOF' },
  { code: 'CI', name: 'Côte d’Ivoire', detail: 'Wallet XOF' },
  { code: 'BF', name: 'Burkina Faso', detail: 'Wallet XOF' },
  { code: 'SN', name: 'Sénégal', detail: 'Wallet XOF' },
  { code: 'ML', name: 'Mali', detail: 'Wallet XOF' },
  { code: 'NE', name: 'Niger', detail: 'Wallet XOF' },
];

const mobileMoneyCountryOptions = [
  { country: 'Togo', flagSrc: 'togo.png', dialCode: '+228', operators: [{ name: 'Mixx by Yas', src: 'mixx_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }] },
  { country: 'Bénin', flagSrc: 'benin.png', dialCode: '+229', operators: [{ name: 'MTN MoMo', src: 'mtn-momo_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }] },
  { country: 'Côte d’Ivoire', flagSrc: 'cote-divoire.png', dialCode: '+225', operators: [{ name: 'Orange Money', src: 'orange-money_no_bg.png' }, { name: 'MTN MoMo', src: 'mtn-momo_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }, { name: 'Wave', src: 'wave_no_bg.png' }] },
  { country: 'Burkina Faso', flagSrc: 'burkina-faso.png', dialCode: '+226', operators: [{ name: 'Orange Money', src: 'orange-money_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }, { name: 'Airtel Money', src: 'airtel-money_no_bg.png' }] },
  { country: 'Sénégal', flagSrc: 'senegal.png', dialCode: '+221', operators: [{ name: 'Wave', src: 'wave_no_bg.png' }, { name: 'Orange Money', src: 'orange-money_no_bg.png' }] },
  { country: 'Mali', flagSrc: 'mali.png', dialCode: '+223', operators: [{ name: 'Orange Money', src: 'orange-money_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }, { name: 'Airtel Money', src: 'airtel-money_no_bg.png' }] },
  { country: 'Niger', flagSrc: 'niger.png', dialCode: '+227', operators: [{ name: 'Airtel Money', src: 'airtel-money_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }, { name: 'Orange Money', src: 'orange-money_no_bg.png' }] },
];

const landingFeatures = [
  { icon: ArrowDownLeft, eyebrow: '01', title: 'Dépôt', copy: 'Ajoutez de l’argent facilement avec les moyens de paiement disponibles.' },
  { icon: ArrowUpRight, eyebrow: '02', title: 'Retrait', copy: 'Retirez vos fonds simplement et rapidement, quand vous en avez besoin.' },
  { icon: Send, eyebrow: '03', title: 'Transfert', copy: 'Envoyez de l’argent à un autre utilisateur Mulapay en quelques étapes.' },
  { icon: RefreshCw, eyebrow: '04', title: 'Échange', copy: 'Gérez vos wallets et demandez des conversions entre les pays.' },
  { icon: Link2, eyebrow: '05', title: 'Payment Links', copy: 'Créez un lien simple pour recevoir des paiements à distance.' },
  { icon: QrCode, eyebrow: '06', title: 'QR Code', copy: 'Recevez des paiements en présentiel avec votre QR code Mulapay.' },
];

const landingSecurityItems = [
  { icon: LockKeyhole, title: 'Authentification sécurisée', copy: 'Un accès protégé pour chaque compte.' },
  { icon: FileCheck2, title: 'Vérification d’identité', copy: 'Un parcours KYC clair et progressif.' },
  { icon: ShieldCheck, title: 'Protection des données', copy: 'Vos informations sont traitées avec attention.' },
  { icon: Activity, title: 'Surveillance des transactions', copy: 'Les opérations sensibles sont contrôlées.' },
  { icon: Bell, title: 'Notifications d’activité', copy: 'Vous restez informé des mouvements importants.' },
  { icon: ListFilter, title: 'Journalisation des opérations', copy: 'Un historique pour garder le contexte.' },
];

const dashboardIcon = (name: string) => `${import.meta.env.BASE_URL}dashboard-icons/${name}`;
type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; image?: string };

const backgroundLogoPositions = [
  ['3%', '5%'], ['16%', '8%'], ['32%', '4%'], ['51%', '7%'], ['73%', '5%'], ['91%', '10%'],
  ['8%', '18%'], ['23%', '22%'], ['42%', '17%'], ['66%', '20%'], ['84%', '24%'], ['97%', '18%'],
  ['2%', '34%'], ['18%', '31%'], ['36%', '37%'], ['57%', '33%'], ['77%', '36%'], ['94%', '31%'],
  ['10%', '48%'], ['28%', '44%'], ['48%', '51%'], ['69%', '46%'], ['88%', '49%'], ['100%', '43%'],
  ['4%', '63%'], ['21%', '67%'], ['40%', '61%'], ['61%', '65%'], ['81%', '60%'], ['96%', '69%'],
  ['13%', '79%'], ['31%', '75%'], ['52%', '82%'], ['73%', '77%'], ['90%', '84%'], ['1%', '91%'],
  ['19%', '94%'], ['43%', '91%'], ['64%', '96%'], ['84%', '92%'],
] as const;

function Landing() {
  const assetUrl = (file: string) => `${import.meta.env.BASE_URL}mobile-money/${file}`;
  return <div className="landing landing-rich">
    <div className="landing-background-marquee" aria-hidden="true">
      {mobileMoneyProviders.concat(mobileMoneyProviders, mobileMoneyProviders, mobileMoneyProviders, mobileMoneyProviders, mobileMoneyProviders).map((provider, index) => {
        const position = backgroundLogoPositions[index % backgroundLogoPositions.length];
        return <span className="landing-background-logo" key={`background-logo-${provider.name}-${index}`} style={{ left: position[0], top: position[1], animationDelay: `${(index % 9) * -1.1}s` }}><img src={assetUrl(provider.src)} alt="" /></span>;
      })}
    </div>
    <nav className="landing-nav">
      <Logo />
      <div className="landing-nav-links"><a href="#pays">Pays</a><a href="#fonctionnalites">Fonctionnalités</a><a href="#securite">Sécurité</a></div>
      <div className="landing-actions"><Link href="/sign-in" data-testid="link-landing-login">Se connecter</Link><Link href="/sign-up" className="button button-primary button-sm" data-testid="link-landing-signup">Créer mon compte <ChevronRight size={14} /></Link></div>
    </nav>
    <main>
      <section className="landing-hero landing-hero-rich">
        <div className="landing-hero-copy">
          <div className="landing-kicker"><span className="kicker-line" /> la finance régionale, simplifiée</div>
          <h1 className="landing-title">Simplifiez vos<span className="hero-mobile-break"><br /></span> paiements<br /><em>en Afrique de l’Ouest.</em></h1>
          <p className="landing-copy">Envoyez, recevez, payez et gérez votre argent simplement à travers l’Afrique de l’Ouest.</p>
          <div className="landing-cta"><Link href="/sign-up" className="button button-primary" data-testid="link-landing-open-app">Créer mon compte <ArrowRightLeft size={15} /></Link><Link href="/sign-in" className="button button-ghost" data-testid="link-landing-admin">Se connecter <Activity size={15} /></Link></div>
          <div className="landing-proof"><span><LockKeyhole size={13} /> Sécurisé</span><span><Activity size={13} /> Rapide</span><span><Globe2 size={13} /> Afrique de l’Ouest</span></div>
        </div>
        <div className="hero-phone-stage" aria-label="Aperçu du dashboard Mulapay">
          <div className="hero-orbit hero-orbit-one" /><div className="hero-orbit hero-orbit-two" />
          <div className="hero-float-card hero-float-card-top"><span className="float-icon"><ArrowRightLeft size={14} /></span><span><small>échange disponible</small><strong>Togo → Bénin</strong></span></div>
          <div className="hero-phone">
            <div className="phone-side-button phone-side-button-one" /><div className="phone-side-button phone-side-button-two" />
            <div className="phone-frame"><div className="phone-notch" /><div className="phone-screen">
              <div className="phone-status"><span>09:41</span><span>Mulapay · sécurisé</span></div>
              <div className="phone-brandline"><span className="phone-mini-logo">M</span><span>Bonjour, votre espace.</span><span className="phone-avatar">M</span></div>
              <div className="phone-balance-card"><span>Votre solde consolidé</span><strong>•••••• <small>XOF</small></strong><em>7 wallets actifs</em></div>
              <div className="phone-section-head"><span>Vos wallets</span><span>Voir tout</span></div>
              <div className="phone-wallet-row"><span className="phone-country-code">TG</span><span><strong>Togo</strong><small>Solde disponible</small></span><b>•••• XOF</b></div>
              <div className="phone-wallet-row"><span className="phone-country-code blue">BJ</span><span><strong>Bénin</strong><small>Solde disponible</small></span><b>•••• XOF</b></div>
              <div className="phone-section-head phone-section-head-activity"><span>Activité récente</span><span>Cette semaine</span></div>
              <div className="phone-activity"><span className="phone-activity-icon"><ArrowUpRight size={12} /></span><span><strong>Transfert</strong><small>Il y a quelques instants</small></span><b>••••</b></div>
              <div className="phone-bottom-nav"><span className="active"><LayoutDashboard size={14} />Accueil</span><span><WalletCards size={14} />Wallets</span><span><QrCode size={14} />Payer</span><span><Menu size={14} />Plus</span></div>
            </div></div>
          </div>
          <div className="hero-money-marquee" aria-label="Réseaux Mobile Money">
            <div className="hero-money-track">{mobileMoneyProviders.concat(mobileMoneyProviders).map((provider, index) => <span className="hero-money-item" key={`hero-money-${provider.name}-${index}`}><span className="hero-money-logo"><img src={assetUrl(provider.src)} alt={provider.name} /></span><small>{provider.name}</small></span>)}</div>
          </div>
          <div className="hero-float-card hero-float-card-bottom"><span className="float-check"><Check size={14} /></span><span><small>opération vérifiée</small><strong>Historique à jour</strong></span></div>
        </div>
      </section>
      <section className="landing-section landing-countries" id="pays">
        <div className="landing-section-heading"><div><div className="eyebrow">une présence régionale</div><h2>MULAPAY en Afrique de l’Ouest</h2></div><p>Une expérience financière pensée pour les réalités de notre région.</p></div>
        <div className="country-grid">{landingCountries.map((country, index) => <div className={`country-card ${index === 0 ? 'featured' : ''}`} key={country.code}><span className="country-code-large">{country.code}</span><span><strong>{country.name}</strong><small>{country.detail}</small></span><ChevronRight size={15} /></div>)}</div>
      </section>
      <section className="landing-wallet-section">
        <div className="landing-wallet-copy"><div className="eyebrow">la différence Mulapay</div><h2>Tous vos wallets.<br /><em>Un seul compte.</em></h2><p>Visualisez vos soldes par pays, gardez le contrôle de vos mouvements et préparez vos échanges depuis une seule interface.</p><Link href="/sign-up" className="text-link">Découvrir Mulapay <ChevronRight size={15} /></Link></div>
        <div className="wallet-showcase">
          <div className="wallet-showcase-head"><div><span className="showcase-label">votre solde</span><strong>242 500 <small>FCFA</small></strong></div><span className="wallet-showcase-menu"><MoreHorizontal size={17} /></span></div>
          <div className="showcase-wallet-list"><div><span className="showcase-country tg">TG</span><span><strong>Togo</strong><small>Wallet principal</small></span><b>125 000 <small>FCFA</small></b></div><div><span className="showcase-country bj">BJ</span><span><strong>Bénin</strong><small>Wallet actif</small></span><b>75 500 <small>FCFA</small></b></div><div><span className="showcase-country ci">CI</span><span><strong>Côte d’Ivoire</strong><small>Wallet actif</small></span><b>42 000 <small>FCFA</small></b></div></div>
          <div className="exchange-showcase"><div><span className="exchange-label">échange</span><strong>Togo <ArrowRightLeft size={13} /> Bénin</strong></div><span className="exchange-action">Échanger <ChevronRight size={14} /></span></div>
        </div>
      </section>
      <section className="landing-section landing-features" id="fonctionnalites">
        <div className="landing-section-heading centered"><div><div className="eyebrow">tout ce qu’il vous faut</div><h2>Une plateforme qui suit votre rythme.</h2></div><p>Des outils simples pour gérer vos opérations quotidiennes, au même endroit.</p></div>
        <div className="feature-grid rich-feature-grid">{landingFeatures.map(({ icon: Icon, eyebrow, title, copy }, index) => <div className={`rich-feature-card ${index === 2 ? 'feature-accent' : ''}`} key={title}><div className="feature-card-top"><span>{eyebrow}</span><Icon size={19} /></div><h3>{title}</h3><p>{copy}</p><span className="feature-arrow"><ChevronRight size={15} /></span></div>)}</div>
      </section>
      <section className="landing-process-section">
        <div className="landing-section-heading centered"><div><div className="eyebrow">simple comme bonjour</div><h2>Comment ça marche ?</h2></div><p>Quatre étapes pour commencer à gérer votre argent autrement.</p></div>
        <div className="process-grid">{[['01', 'Créez votre compte', 'Inscrivez-vous en quelques minutes.'], ['02', 'Vérifiez votre identité', 'Effectuez votre vérification KYC.'], ['03', 'Activez vos wallets', 'Choisissez les pays dont vous avez besoin.'], ['04', 'Commencez à utiliser Mulapay', 'Déposez, envoyez, recevez et gérez votre argent.']].map(([number, title, copy]) => <div className="process-step" key={number}><span className="process-number">{number}</span><span className="process-line" /><h3>{title}</h3><p>{copy}</p></div>)}</div>
      </section>
      <section className="landing-why-section">
        <div className="why-heading"><div className="eyebrow">pourquoi Mulapay ?</div><h2>Une nouvelle façon de gérer votre argent.</h2><p>Pensée pour les personnes et les entreprises qui avancent dans une région connectée.</p></div>
        <div className="why-grid"><div className="why-card"><Activity size={19} /><h3>Rapide</h3><p>Des opérations conçues pour être simples et efficaces.</p></div><div className="why-card"><ShieldCheck size={19} /><h3>Sécurisé</h3><p>Protection des comptes et opérations sensibles.</p></div><div className="why-card"><Globe2 size={19} /><h3>Pensé pour l’Afrique</h3><p>Une plateforme construite autour des usages régionaux.</p></div><div className="why-card"><LayoutDashboard size={19} /><h3>Tout au même endroit</h3><p>Wallets, transferts, paiements et historique réunis.</p></div></div>
      </section>
      <section className="landing-payments-section">
        <div className="payments-visual"><div className="payments-window"><div className="payments-window-top"><span><i /><i /><i /></span><small>mulapay / paiements</small><span className="window-shield"><ShieldCheck size={13} /></span></div><div className="payments-window-body"><span className="eyebrow">pour les particuliers et les entreprises</span><h3>Recevez des paiements partout où vos clients sont.</h3><div className="payment-tool-list"><span><Link2 size={14} /> Payment Link</span><span><QrCode size={14} /> QR Code</span><span><Settings2 size={14} /> API Mulapay</span><span><Activity size={14} /> Webhooks</span><span><ListFilter size={14} /> Historique des transactions</span></div></div></div></div>
        <div className="payments-copy"><div className="eyebrow">un espace pour vos paiements</div><h2>Plus qu’un wallet.<br /><em>Un outil pour avancer.</em></h2><p>Créez une expérience de paiement fluide pour vos clients et gardez une vue claire sur chaque transaction.</p><Link href="/sign-up" className="button button-primary">Lancer mon espace <ChevronRight size={15} /></Link></div>
      </section>
      <section className="landing-security-section" id="securite">
        <div className="security-heading"><div className="security-badge"><ShieldCheck size={19} /></div><div><div className="eyebrow">la confiance par conception</div><h2>Votre sécurité est notre priorité.</h2><p>Nous privilégions des parcours clairs, des contrôles adaptés et une information précise — sans promesse excessive.</p></div></div>
        <div className="security-grid">{landingSecurityItems.map(({ icon: Icon, title, copy }) => <div className="security-item" key={title}><Icon size={17} /><span><strong>{title}</strong><small>{copy}</small></span></div>)}</div>
      </section>
      <section className="landing-final-cta"><Logo /><div><div className="eyebrow">prêt à commencer ?</div><h2>Prêt à simplifier vos paiements ?</h2><p>Créez votre compte Mulapay gratuitement.</p></div><Link href="/sign-up" className="button button-primary">Commencer maintenant <ChevronRight size={15} /></Link></section>
    </main>
    <footer className="landing-footer"><Logo /><span>© 2026 Mulapay · Plateforme financière</span><span>Pour des marchés connectés</span></footer>
  </div>;
}

const userNav: NavItem[] = [
  { href: '/app', label: 'Vue d’ensemble', icon: LayoutDashboard },
  { href: '/app/wallets', label: 'Wallets', icon: WalletCards, image: 'wallet.png' },
  { href: '/app/deposit', label: 'Dépôt', icon: ArrowDownLeft, image: 'deposit.png' },
  { href: '/app/withdrawal', label: 'Retrait', icon: ArrowUpRight, image: 'wallet.png' },
  { href: '/app/transactions', label: 'Transactions', icon: ListFilter, image: 'transactions.png' },
  { href: '/app/transfer', label: 'Envoyer de l’argent', icon: Send, image: 'transfer.png' },
  { href: '/app/exchange', label: 'Échanger', icon: RefreshCw, image: 'exchange.png' },
  { href: '/app/payments', label: 'Paiements', icon: Banknote, image: 'wallet.png' },
  { href: '/app/payment-links', label: 'Liens de paiement', icon: Link2, image: 'payment-links.png' },
  { href: '/app/qr', label: 'QR Code', icon: QrCode },
];
const adminNav: NavItem[] = [
  { href: '/admin', label: 'Opérations', icon: LayoutDashboard },
  { href: '/admin/kyc', label: 'Revue KYC', icon: FileCheck2, image: 'kyc.png' },
  { href: '/admin/exchanges', label: 'File des échanges', icon: RefreshCw },
  { href: '/admin/transactions', label: 'Transactions', icon: ListFilter, image: 'transactions.png' },
];

function Shell({ children, admin = false, onNotifications }: { children: ReactNode; admin?: boolean; onNotifications: () => void }) {
  const [location, setLocation] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const nav = admin ? adminNav : userNav;
  const unread = useStore().notifications.filter(n => !n.read).length;
  const current = nav.find(item => item.href === location)?.label || (location === '/app/kyc' ? 'Vérification KYC' : location === '/app/settings' ? 'Profil' : admin ? 'Opérations' : 'Vue d’ensemble');
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location, admin]);
  const goBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setLocation(admin ? '/admin' : '/app');
    }
  };
  return <div className="app-shell">
    <aside id="mobile-navigation" className={`side-rail ${mobileMenuOpen ? 'mobile-open' : ''}`} onClick={event => {
      if ((event.target as HTMLElement).closest('a')) setMobileMenuOpen(false);
    }}>
      <Link href={admin ? '/admin' : '/app'}><Logo light /></Link>
      <div className="side-label">{admin ? 'Bureau des opérations' : 'Votre Mulapay'}</div>
      <nav className="nav-list">{nav.map(item => { const Icon = item.icon; return <Link key={item.href} href={item.href} className={`nav-link ${location === item.href ? 'active' : ''}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}>{item.image ? <img className="nav-image" src={dashboardIcon(item.image)} alt="" /> : <Icon className="nav-icon" />}<span>{item.label}</span></Link>; })}</nav>
      {!admin && <><div className="side-label" style={{ marginTop: 30 }}>Compte</div><nav className="nav-list"><Link href="/app/api" className={`nav-link ${location === '/app/api' ? 'active' : ''}`} data-testid="link-nav-api"><img className="nav-image" src={dashboardIcon('api.png')} alt="" /><span>API partenaire</span></Link><Link href="/app/api-docs" className={`nav-link ${location === '/app/api-docs' ? 'active' : ''}`} data-testid="link-nav-api-docs"><img className="nav-image" src={dashboardIcon('documents.png')} alt="" /><span>Documentation API Payin</span></Link><Link href="/app/notifications" className={`nav-link ${location === '/app/notifications' ? 'active' : ''}`} data-testid="link-nav-notifications"><img className="nav-image" src={dashboardIcon('notifications.png')} alt="" /><span>Notifications</span></Link><Link href="/app/kyc" className={`nav-link ${location === '/app/kyc' ? 'active' : ''}`} data-testid="link-nav-verification"><img className="nav-image" src={dashboardIcon('kyc.png')} alt="" /><span>Vérification KYC</span></Link><Link href="/app/security" className={`nav-link ${location === '/app/security' ? 'active' : ''}`} data-testid="link-nav-security"><img className="nav-image" src={dashboardIcon('security.png')} alt="" /><span>Sécurité</span></Link><Link href="/app/settings" className={`nav-link ${location === '/app/settings' ? 'active' : ''}`} data-testid="link-nav-settings"><img className="nav-image" src={dashboardIcon('profile.png')} alt="" /><span>Profil</span></Link><Link href="/app/support" className={`nav-link ${location === '/app/support' ? 'active' : ''}`} data-testid="link-nav-support"><img className="nav-image" src={dashboardIcon('support.png')} alt="" /><span>Support</span></Link></nav></>}
      <div className="side-footer"><div className="demo-chip"><span className="demo-dot" /><span><strong style={{ color: 'hsl(160 42% 64%)' }}>Compte sécurisé</strong><br />Vos opérations sont persistées et auditées.</span></div></div>
    </aside>
    {mobileMenuOpen && <button className="mobile-menu-backdrop" aria-label="Fermer le menu" onClick={() => setMobileMenuOpen(false)} />}
    <div className="main-pane">
      <div className={`mobile-top ${admin ? 'admin-mobile-top' : 'user-mobile-top'}`}><button className="icon-button mobile-menu-toggle" aria-label={mobileMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu'} aria-expanded={mobileMenuOpen} aria-controls="mobile-navigation" onClick={() => setMobileMenuOpen(open => !open)} data-testid="button-mobile-menu"><Menu size={19} /></button><div className="mobile-menu-actions"><button className="icon-button" onClick={() => setLocation(admin ? '/app' : '/admin')} data-testid="button-switch-area"><ArrowRightLeft size={16} /></button></div></div>
       {admin && <div className="admin-bar"><span><CircleAlert size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />Vue opérations · chaque action sensible est journalisée.</span><Link href="/app">Retour à l’espace utilisateur</Link></div>}
       <header className="topbar"><div className="topbar-leading"><button className="back-button" onClick={goBack} title="Retour à la page précédente" aria-label="Retour à la page précédente" data-testid="button-back"><ArrowLeft size={16} /><span>Retour</span></button><div className="crumb">{admin ? 'Opérations / ' : 'Espace / '}{current}</div></div><div className="top-actions"><button className="icon-button" title="Notifications" onClick={onNotifications} data-testid="button-notifications"><Bell size={16} />{unread > 0 && <span className="notification-dot" />}</button><div className="avatar" data-testid="text-user-avatar">{useStore().profile.firstName.slice(0, 1)}{useStore().profile.lastName.slice(0, 1)}</div></div></header>
      {children}
    </div>
  </div>;
}

function PageIntro({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="section-head"><div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1>{subtitle && <p className="page-subtitle">{subtitle}</p>}</div>{action}</div>;
}

function Overview() {
  const { wallets, transactions, profile } = useStore();
  const total = wallets.reduce((sum, item) => sum + (item.status === 'Active' ? item.balance : 0), 0);
  return <main className="page-wrap"><PageIntro eyebrow="Espace financier sécurisé" title={`Bonjour, ${profile.firstName}.`} />
    <div className="dashboard-grid"><div><div className="card balance-hero card-pad"><div className="eyebrow" style={{ color: 'hsl(160 42% 64%)' }}>total des wallets actifs</div><div className="hero-balance">{money(total).replace('XOF', '')}<small>XOF</small></div><div className="hero-caption">Solde confirmé sur vos wallets actifs</div><div className="hero-footer"><Link href="/app/wallets" className="button button-amber" data-testid="button-view-wallets"><img className="dashboard-action-icon" src={dashboardIcon('wallet.png')} alt="" /> Voir les wallets</Link><Link href="/app/deposit" className="button button-ghost" data-testid="button-overview-deposit"><img className="dashboard-action-icon" src={dashboardIcon('deposit.png')} alt="" /> Déposer</Link><Link href="/app/withdrawal" className="button button-ghost" data-testid="button-overview-withdrawal"><img className="dashboard-action-icon" src={dashboardIcon('wallet.png')} alt="" /> Retirer</Link></div></div></div>
      <div className="card card-pad"><div className="section-head" style={{ marginBottom: 4 }}><div><h2 className="section-title">Activité récente</h2><p className="section-note">Vos derniers mouvements</p></div><Link href="/app/transactions" className="eyebrow" data-testid="link-overview-transactions">Tout voir</Link></div>{transactions.slice(0, 4).map(t => <TransactionRow key={t.id} transaction={t} />)}</div>
    </div>
  </main>;
}

function TransactionRow({ transaction }: { transaction: Transaction }) {
  const Icon = transaction.type === 'Received' ? ArrowDownLeft : transaction.type === 'Sent' ? ArrowUpRight : transaction.type === 'Exchange' ? ArrowRightLeft : Banknote;
  const transactionImage = transaction.type === 'Deposit' ? 'deposit.png' : transaction.type === 'Withdrawal' ? 'wallet.png' : transaction.type === 'Payment' ? 'payment-links.png' : undefined;
  const positive = transaction.type === 'Received' || transaction.type === 'Deposit';
  return <div className="activity-row" data-testid={`row-transaction-${transaction.id}`}><div className="activity-main"><div className="activity-icon">{transactionImage ? <img className="activity-image" src={dashboardIcon(transactionImage)} alt="" /> : <Icon size={15} />}</div><div><div className="activity-name">{counterpartyLabel(transaction.counterparty)}</div><div className="activity-meta">{movementLabel(transaction.type)} · {dateLabel(transaction.createdAt)}</div></div></div><div style={{ textAlign: 'right' }}><div className={`amount ${positive ? 'positive' : 'negative'}`}>{positive ? '+' : '-'}{new Intl.NumberFormat('fr-FR').format(transaction.amount)} {transaction.currency}</div><div style={{ marginTop: 5 }}><span className={`pill ${transaction.status === 'Completed' ? 'pill-success' : 'pill-pending'}`}>{statusLabel(transaction.status)}</span></div></div></div>;
}

function Wallets() {
  const { wallets } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Votre argent, marché par marché" title="Wallets par pays" subtitle="Des soldes locaux séparés, réunis sous un même compte Mulapay. Leur disponibilité reste toujours explicite." action={<Link href="/app/exchange" className="button button-primary" data-testid="button-wallets-exchange"><ArrowRightLeft size={15} /> Demander un échange</Link>} /><div className="notice"><ShieldCheck size={15} /><span>Les wallets actifs sont enregistrés séparément pour le Togo, le Bénin, la Côte d’Ivoire, le Burkina Faso, le Sénégal, le Mali et le Niger.</span></div><div className="wallet-grid">{wallets.map(wallet => <div className={`card wallet-card ${wallet.status !== 'Active' ? 'coming-soon' : ''}`} key={wallet.code} data-testid={`card-wallet-${wallet.code}`}><div className="wallet-top"><div><div className="wallet-name">{countryLabel(wallet.country)}</div><div className="wallet-currency">Wallet {wallet.currency}</div></div><span className={`pill ${wallet.status === 'Active' ? 'pill-success' : 'pill-neutral'}`}>{statusLabel(wallet.status)}</span></div><div className="wallet-total">{new Intl.NumberFormat('fr-FR').format(wallet.balance)} <span>{wallet.currency}</span></div><div className="wallet-stats"><div><div className="wallet-stat-label">Disponible</div><div className="wallet-stat-value">{new Intl.NumberFormat('fr-FR').format(wallet.balance - wallet.pending)}</div></div><div><div className="wallet-stat-label">En attente</div><div className="wallet-stat-value">{new Intl.NumberFormat('fr-FR').format(wallet.pending)}</div></div></div></div>)}</div><div className="card card-pad" style={{ marginTop: 28 }}><div className="section-head"><div><h2 className="section-title">Fonctionnement des wallets</h2><p className="section-note">Pensé pour la clarté, pas pour vous perdre.</p></div></div><div className="feature-grid" style={{ marginTop: 0, gridTemplateColumns: 'repeat(3, 1fr)' }}><div><div className="eyebrow">01 · Disponible</div><p className="section-note" style={{ marginTop: 10 }}>Fonds prêts pour les transferts internes ou les échanges.</p></div><div><div className="eyebrow">02 · En attente</div><p className="section-note" style={{ marginTop: 10 }}>Fonds soumis à une validation ou une action manuelle.</p></div><div><div className="eyebrow">03 · Contexte local</div><p className="section-note" style={{ marginTop: 10 }}>Chaque mouvement conserve son wallet, sa devise et sa référence.</p></div></div></div></main>;
}

function ProviderOperationForm({ kind }: { kind: 'deposit' | 'withdrawal' }) {
  const { wallets, toast } = useStore();
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? '');
  const [country, setCountry] = useState(wallets[0]?.country ?? mobileMoneyCountryOptions[0].country);
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [operator, setOperator] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isDeposit = kind === 'deposit';
  const selectedCountry = mobileMoneyCountryOptions.find(option => option.country === country) ?? mobileMoneyCountryOptions[0];

  useEffect(() => {
    const selectedWallet = wallets.find(wallet => wallet.country === country) ?? wallets[0];
    if (selectedWallet && selectedWallet.id !== walletId) setWalletId(selectedWallet.id);
    const nextOperator = selectedCountry.operators[0]?.name ?? '';
    if (operator !== nextOperator) setOperator(nextOperator);
  }, [country, operator, selectedCountry, walletId, wallets]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await fetch(`/api/v1/${isDeposit ? 'deposits' : 'withdrawals'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          walletId,
          amount: Number(amount),
          method: 'mobile_money',
          country,
          operator,
          phone: `${selectedCountry.dialCode}${phone.replace(/\D/g, '')}`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Opération impossible.');
      toast(payload.message ?? 'Opération créée.');
      setAmount('');
      setPhone('');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Opération impossible.');
    } finally {
      setSubmitting(false);
    }
  };
  if (isDeposit) {
    return <main className="page-wrap deposit-page">
      <PageIntro eyebrow="Mobile Money" title="Dépôt" />
      <form className="card card-pad deposit-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="deposit-country">Pays</label>
          <div className="country-select">
            <img src={`${import.meta.env.BASE_URL}countries/${selectedCountry.flagSrc}`} alt="" />
            <select id="deposit-country" value={country} onChange={event => setCountry(event.target.value)} required>
              {mobileMoneyCountryOptions.map(option => <option key={option.country} value={option.country}>{option.country} · {option.dialCode}</option>)}
            </select>
            <ChevronDown className="country-select-chevron" size={16} aria-hidden="true" />
          </div>
        </div>
        <div className="field">
          <label>Opérateur Mobile Money</label>
          <div className="mobile-money-options" role="radiogroup" aria-label="Choisir un opérateur Mobile Money">
            {selectedCountry.operators.map(option => <label className={`mobile-money-option ${operator === option.name ? 'selected' : ''}`} key={option.name}>
              <input type="radio" name="deposit-operator" value={option.name} checked={operator === option.name} onChange={event => setOperator(event.target.value)} required />
              <img src={`${import.meta.env.BASE_URL}mobile-money/${option.src}`} alt="" />
              <span>{option.name}</span>
            </label>)}
          </div>
        </div>
        <div className="field">
          <label htmlFor="deposit-phone">Numéro de téléphone</label>
          <div className="phone-input">
            <span className="phone-prefix" aria-label={`Indicatif ${selectedCountry.dialCode}`}>{selectedCountry.dialCode}</span>
            <input id="deposit-phone" type="tel" inputMode="numeric" value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, ''))} placeholder="90 00 00 00" autoComplete="tel-national" required />
          </div>
        </div>
        <div className="field">
          <label htmlFor="deposit-amount">Montant</label>
          <div className="input-prefix">
            <span>XOF</span>
            <input id="deposit-amount" type="number" min="1" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0" required />
          </div>
        </div>
        <button className="button button-primary button-wide" type="submit" disabled={submitting}>
          {submitting ? 'Traitement…' : 'Déposer maintenant'} <ChevronRight size={15} />
        </button>
      </form>
    </main>;
  }

  return <main className="page-wrap deposit-page">
    <PageIntro eyebrow="Mobile Money" title="Retrait" />
    <form className="card card-pad deposit-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="withdrawal-country">Pays</label>
        <div className="country-select">
          <img src={`${import.meta.env.BASE_URL}countries/${selectedCountry.flagSrc}`} alt="" />
          <select id="withdrawal-country" value={country} onChange={event => setCountry(event.target.value)} required>
            {mobileMoneyCountryOptions.map(option => <option key={option.country} value={option.country}>{option.country} · {option.dialCode}</option>)}
          </select>
          <ChevronDown className="country-select-chevron" size={16} aria-hidden="true" />
        </div>
      </div>
      <div className="field">
        <label>Opérateur Mobile Money</label>
        <div className="mobile-money-options" role="radiogroup" aria-label="Choisir un opérateur Mobile Money">
          {selectedCountry.operators.map(option => <label className={`mobile-money-option ${operator === option.name ? 'selected' : ''}`} key={option.name}>
            <input type="radio" name="withdrawal-operator" value={option.name} checked={operator === option.name} onChange={event => setOperator(event.target.value)} required />
            <img src={`${import.meta.env.BASE_URL}mobile-money/${option.src}`} alt="" />
            <span>{option.name}</span>
          </label>)}
        </div>
      </div>
      <div className="field">
        <label htmlFor="withdrawal-phone">Numéro de téléphone</label>
        <div className="phone-input">
          <span className="phone-prefix" aria-label={`Indicatif ${selectedCountry.dialCode}`}>{selectedCountry.dialCode}</span>
          <input id="withdrawal-phone" type="tel" inputMode="numeric" value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, ''))} placeholder="90 00 00 00" autoComplete="tel-national" required />
        </div>
      </div>
      <div className="field">
        <label htmlFor="withdrawal-amount">Montant</label>
        <div className="input-prefix">
          <span>XOF</span>
          <input id="withdrawal-amount" type="number" min="1" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0" required />
        </div>
      </div>
      <button className="button button-primary button-wide" type="submit" disabled={submitting}>
        {submitting ? 'Traitement…' : 'Retirer maintenant'} <ChevronRight size={15} />
      </button>
    </form>
  </main>;
}

function Deposit() { return <ProviderOperationForm kind="deposit" />; }
function Withdrawal() { return <ProviderOperationForm kind="withdrawal" />; }

function Receive() {
  const { links } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Recevoir de l’argent" title="Recevoir" subtitle="Partagez un lien de paiement ou affichez votre identifiant de réception." action={<Link href="/app/payment-links" className="button button-primary"><Plus size={15} /> Créer un lien</Link>} /><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Vos moyens de réception</h2><p className="section-note">Les paiements confirmés apparaîtront dans vos transactions.</p></div><QrCode size={18} /></div>{links.length === 0 ? <div className="empty-state"><Link2 size={25} /><strong>Aucun lien actif</strong><p>Créez un lien de paiement pour recevoir des fonds.</p></div> : links.map(link => <div className="activity-row" key={link.id}><div><div className="activity-name">{link.description}</div><div className="activity-meta">{link.slug} · {statusLabel(link.status)}</div></div><strong>{money(link.amount, link.currency)}</strong></div>)}</div></main>;
}

function Payments() {
  const { transactions } = useStore();
  const payments = transactions.filter(item => item.type === 'Payment');
  return <main className="page-wrap"><PageIntro eyebrow="Encaisser et payer" title="Paiements" subtitle="Suivez les paiements confirmés, les frais et les reçus associés." /><div className="card table-card"><div className="table-scroll"><table className="data-table"><thead><tr><th>Référence</th><th>Contrepartie</th><th>Montant</th><th>Statut</th></tr></thead><tbody>{payments.map(payment => <tr key={payment.id}><td>{payment.reference}</td><td>{counterpartyLabel(payment.counterparty)}</td><td>{money(payment.amount, payment.currency)}</td><td><span className="pill pill-success">{statusLabel(payment.status)}</span></td></tr>)}</tbody></table>{payments.length === 0 && <div className="empty-state"><Banknote size={25} /><strong>Aucun paiement</strong><p>Les paiements confirmés seront affichés ici.</p></div>}</div></div></main>;
}

function QrPage() {
  const { links } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Réception rapide" title="QR Code" subtitle="Un QR code ne contient aucun secret. Il pointe vers une page de paiement sécurisée." /><div className="card card-pad qr-wrap"><div className="qr-box">{Array.from({ length: 81 }, (_, index) => <i key={index} />)}</div><div className="qr-caption">{links[0]?.slug ?? 'Créez un lien de paiement pour générer votre QR code.'}</div></div></main>;
}

function ApiAccess() {
  return <main className="page-wrap"><PageIntro eyebrow="Pour les partenaires" title="API Mulapay" subtitle="Connectez vos sites et applications à vos wallets avec une API REST versionnée." action={<button className="button button-primary" onClick={() => alert('La création de clés API sera disponible après configuration des scopes.')}><Plus size={15} /> Créer une clé API</button>} /><div className="grid-2"><div className="card card-pad"><div className="section-title">Accès API</div><p className="section-note" style={{ marginTop: 8 }}>Les clés sont limitées par scopes, révocables et ne sont affichées qu’une seule fois.</p><div className="summary-box" style={{ marginTop: 18 }}><div className="summary-line"><span>Base URL</span><strong>/api/v1</strong></div><div className="summary-line"><span>Idempotence</span><strong>Idempotency-Key</strong></div><div className="summary-line"><span>Webhooks</span><strong>Signés et rejouables</strong></div></div></div><div className="card card-pad"><div className="section-title">Ressources</div><div className="step-list" style={{ marginTop: 12 }}><div className="step"><div className="step-number">01</div><div><div className="step-title">Paiements</div><div className="step-copy">Créer et consulter un paiement.</div></div></div><div className="step"><div className="step-number">02</div><div><div className="step-title">Wallets et transactions</div><div className="step-copy">Lire uniquement les ressources autorisées.</div></div></div><div className="step"><div className="step-number">03</div><div><div className="step-title">Liens et remboursements</div><div className="step-copy">Utiliser les opérations prévues par vos scopes.</div></div></div></div></div></div></main>;
}

function ApiPayinDocs() {
  return <main className="page-wrap"><PageIntro eyebrow="Documentation partenaire" title="Documentation API Payin" subtitle="Intégrez l’encaissement Mobile Money dans vos sites et applications avec l’API Mulapay." action={<Link href="/app/api" className="button button-primary"><Settings2 size={15} /> Gérer l’accès API</Link>} /><div className="api-docs-grid"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Démarrer un Payin</h2><p className="section-note">Initialisez une demande de dépôt auprès d’un opérateur Mobile Money.</p></div><img className="api-docs-icon" src={dashboardIcon('documents.png')} alt="" /></div><div className="api-endpoint"><span className="api-method">POST</span><code>/api/v1/deposits</code></div><pre className="api-code">{`{\n  "walletId": "wallet_togo",\n  "amount": 10000,\n  "method": "mobile_money",\n  "country": "Togo",\n  "operator": "Mixx by Yas",\n  "phone": "+22890000000"\n}`}</pre></div><div className="card card-pad"><h2 className="section-title">En-têtes requis</h2><div className="step-list" style={{ marginTop: 14 }}><div className="step"><div className="step-number">01</div><div><div className="step-title">Authentification</div><div className="step-copy">Utilisez une clé API partenaire avec les scopes autorisés.</div></div></div><div className="step"><div className="step-number">02</div><div><div className="step-title">Idempotence</div><div className="step-copy">Envoyez une valeur unique dans <code>Idempotency-Key</code> pour chaque tentative.</div></div></div><div className="step"><div className="step-number">03</div><div><div className="step-title">Confirmation</div><div className="step-copy">Le résultat final est confirmé par le prestataire et un webhook signé.</div></div></div></div></div></div><div className="card card-pad api-docs-endpoints"><div className="section-head"><div><h2 className="section-title">Endpoints disponibles</h2><p className="section-note">Les opérations financières restent bloquées tant que le prestataire Drimpay n’est pas configuré.</p></div><Link href="/app/transactions" className="button button-ghost button-sm">Voir l’historique</Link></div><div className="api-endpoint-list"><div><span className="api-method">POST</span><code>/api/v1/deposits</code><span>Créer un Payin</span></div><div><span className="api-method api-method-muted">POST</span><code>/api/v1/withdrawals</code><span>Créer un retrait</span></div><div><span className="api-method api-method-muted">POST</span><code>/api/v1/payment-links</code><span>Créer un lien de paiement</span></div></div></div></main>;
}

function NotificationsPage() {
  const { notifications, markRead } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Centre d’activité" title="Notifications" subtitle="Dépôts, retraits, paiements, sécurité et décisions KYC." /><div className="card card-pad">{notifications.length === 0 ? <div className="empty-state"><Bell size={25} /><strong>Aucune notification</strong><p>Les événements de votre compte apparaîtront ici.</p></div> : notifications.map(item => { const copy = notificationCopy(item); return <button key={item.id} onClick={() => markRead(item.id)} className="activity-row" style={{ width: '100%', border: 0, textAlign: 'left', background: item.read ? 'transparent' : 'hsl(39 78% 89% / .35)', cursor: 'pointer' }}><div><div className="activity-name">{copy.title}</div><div className="activity-meta">{copy.body}</div></div><span className={`pill ${item.read ? '' : 'pill-pending'}`}>{item.read ? 'Lue' : 'À lire'}</span></button>; })}</div></main>;
}

function Security() {
  const { signOut } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Protection du compte" title="Sécurité" subtitle="Clerk gère l’authentification, les sessions et les facteurs de sécurité." /><div className="card card-pad"><div className="activity-row"><div className="activity-main"><div className="activity-icon"><ShieldCheck size={15} /></div><div><div className="activity-name">Authentification sécurisée</div><div className="activity-meta">Connexion, OTP, récupération et sessions sont gérés par Clerk.</div></div></div><Link href="/sign-in" className="button button-ghost button-sm">Gérer</Link></div><div className="activity-row"><div className="activity-main"><div className="activity-icon"><LogOut size={15} /></div><div><div className="activity-name">Déconnexion globale</div><div className="activity-meta">Révoquer la session actuelle et revenir à l’accueil.</div></div></div><button className="button button-danger button-sm" onClick={signOut}>Se déconnecter</button></div></div></main>;
}

function Support() {
  return <main className="page-wrap"><PageIntro eyebrow="Assistance" title="Support" subtitle="Décrivez votre problème avec une référence de transaction pour accélérer le traitement." /><div className="card card-pad"><div className="field"><label>Sujet</label><input placeholder="Ex. dépôt en attente" /></div><div className="field"><label>Référence de transaction</label><input placeholder="MP-..." /></div><div className="field"><label>Message</label><textarea rows={5} placeholder="Décrivez votre demande" /></div><button className="button button-primary" onClick={() => alert('Votre demande sera envoyée au support après activation du canal de support.')}>Envoyer la demande</button></div></main>;
}

function Transactions() {
  const { transactions, toast } = useStore();
  const [filter, setFilter] = useState('All');
  const [query, setQuery] = useState('');
  const filtered = transactions.filter(t => (filter === 'All' || t.type === filter) && `${t.counterparty} ${t.reference}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="page-wrap"><PageIntro eyebrow="Une trace claire" title="Transactions" subtitle="Chaque mouvement confirmé par le serveur, avec sa référence et son statut." action={<button className="button button-ghost" onClick={() => toast('L’export sera disponible après activation des permissions de téléchargement.')} data-testid="button-export-transactions"><Download size={15} /> Exporter en CSV</button>} /><div className="card table-card"><div className="table-toolbar"><div className="filter-set">{[['All', 'Toutes'], ['Received', 'Reçues'], ['Sent', 'Envoyées'], ['Exchange', 'Échanges'], ['Deposit', 'Dépôts']].map(([value, label]) => <button key={value} onClick={() => setFilter(value)} className={`filter-button ${filter === value ? 'active' : ''}`} data-testid={`button-filter-${value.toLowerCase()}`}>{label}</button>)}</div><div className="input-prefix" style={{ width: 190 }}><Search size={14} style={{ position: 'absolute', left: 12, top: 11, color: 'hsl(203 18% 46%)' }} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Rechercher une référence" style={{ width: '100%', border: '1px solid hsl(38 28% 85%)', background: 'hsl(42 44% 99%)', borderRadius: 9, padding: '9px 10px 9px 32px', fontSize: 11, outline: 0 }} data-testid="input-search-transactions" /></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Mouvement</th><th>Wallet</th><th>Référence</th><th>Date</th><th style={{ textAlign: 'right' }}>Montant</th><th>Statut</th></tr></thead><tbody>{filtered.map(t => <tr key={t.id} data-testid={`row-table-transaction-${t.id}`}><td><div style={{ fontWeight: 700 }}>{counterpartyLabel(t.counterparty)}</div><div className="activity-meta">{movementLabel(t.type)}</div></td><td>{countryLabel(t.country)} · {t.currency}</td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(203 18% 46%)' }}>{t.reference}</td><td>{dateLabel(t.createdAt)}</td><td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: t.type === 'Received' || t.type === 'Deposit' ? 'hsl(160 42% 38%)' : 'inherit' }}>{t.type === 'Received' || t.type === 'Deposit' ? '+' : '-'}{new Intl.NumberFormat('fr-FR').format(t.amount)} {t.currency}</td><td><span className={`pill ${t.status === 'Completed' ? 'pill-success' : 'pill-pending'}`}>{statusLabel(t.status)}</span></td></tr>)}</tbody></table>{filtered.length === 0 && <div className="empty-state"><ListFilter size={25} /><strong>Aucun mouvement trouvé</strong><p>Essayez un autre filtre ou une autre référence.</p></div>}</div></div></main>;
}

function Transfer() {
  const { wallets, transfer } = useStore();
  const [amount, setAmount] = useState(''); const [currency, setCurrency] = useState('XOF'); const [recipient, setRecipient] = useState(''); const [note, setNote] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (!amount || !recipient) return; transfer({ amount: Number(amount), currency, counterparty: recipient, note }); setAmount(''); setRecipient(''); setNote(''); };
  return <main className="page-wrap"><PageIntro eyebrow="Déplacer de l’argent en interne" title="Envoyer de l’argent" subtitle="Envoyez de l’argent à un autre utilisateur Mulapay avec son téléphone ou son identifiant. Rapide, clair et toujours traçable." /><div className="form-layout"><form className="card card-pad" onSubmit={submit}><div className="field"><label htmlFor="recipient">Destinataire</label><input id="recipient" value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="Numéro de téléphone ou @identifiant" data-testid="input-transfer-recipient" /><div className="field-hint">Le destinataire doit disposer d’un compte Mulapay actif.</div></div><div className="field"><label htmlFor="amount">Montant</label><div className="input-prefix"><span>{currency}</span><input id="amount" type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" data-testid="input-transfer-amount" /></div></div><div className="field"><label htmlFor="currency">Depuis le wallet</label><select id="currency" value={currency} onChange={e => setCurrency(e.target.value)} data-testid="select-transfer-wallet">{wallets.filter(w => w.status === 'Active').map(w => <option key={w.code} value={w.currency}>{countryLabel(w.country)} · {w.currency} · {new Intl.NumberFormat('fr-FR').format(w.balance)} disponibles</option>)}</select></div><div className="field"><label htmlFor="note">Note <span style={{ color: 'hsl(203 18% 46%)', fontWeight: 400 }}>(facultative)</span></label><textarea id="note" value={note} onChange={e => setNote(e.target.value)} placeholder="À quoi sert ce transfert ?" data-testid="input-transfer-note" /></div><button className="button button-primary button-wide" type="submit" disabled={!amount || !recipient} data-testid="button-submit-transfer"><Send size={15} /> Vérifier et envoyer</button></form><div className="card card-pad"><div className="eyebrow">Avant d’envoyer</div><div className="step-list" style={{ marginTop: 12 }}><div className="step done"><div className="step-number">1</div><div><div className="step-title">Choisir le wallet</div><div className="step-copy">Les fonds sortent du wallet actif du pays sélectionné.</div></div></div><div className="step"><div className="step-number">2</div><div><div className="step-title">Confirmer la personne</div><div className="step-copy">Le destinataire est vérifié côté serveur avant le débit.</div></div></div><div className="step"><div className="step-number">3</div><div><div className="step-title">Conserver le reçu</div><div className="step-copy">Une référence est créée pour chaque mouvement confirmé.</div></div></div></div></div></div></main>;
}

function Exchange() {
  const { wallets, exchanges, exchange } = useStore();
  const active = wallets.filter(w => w.status === 'Active'); const [source, setSource] = useState('Togo'); const [destination, setDestination] = useState('Benin'); const [amount, setAmount] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (!amount || source === destination) return; exchange({ source, destination, amount: Number(amount) }); setAmount(''); };
  return <main className="page-wrap"><PageIntro eyebrow="Rééquilibrer comme vous le souhaitez" title="Échange entre wallets" subtitle="Demandez un mouvement entre vos wallets par pays. Chaque échange est examiné par les opérations avant d’être crédité." /><div className="form-layout"><form className="card card-pad" onSubmit={submit}><div className="field"><label htmlFor="exchange-source">Depuis</label><select id="exchange-source" value={source} onChange={e => setSource(e.target.value)} data-testid="select-exchange-source">{active.map(w => <option key={w.code} value={w.country}>{countryLabel(w.country)}</option>)}</select></div><div style={{ display: 'grid', placeItems: 'center', margin: '-5px 0 10px' }}><div style={{ width: 31, height: 31, borderRadius: 10, background: 'hsl(39 78% 89%)', color: 'hsl(160 42% 38%)', display: 'grid', placeItems: 'center' }}><ArrowDownLeft size={15} /></div></div><div className="field"><label htmlFor="exchange-destination">Vers</label><select id="exchange-destination" value={destination} onChange={e => setDestination(e.target.value)} data-testid="select-exchange-destination">{active.map(w => <option key={w.code} value={w.country}>{countryLabel(w.country)}</option>)}</select></div><div className="field"><label htmlFor="exchange-amount">Montant à échanger</label><div className="input-prefix"><span>XOF</span><input id="exchange-amount" type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" data-testid="input-exchange-amount" /></div></div><div className="summary-box"><div className="summary-line"><span>Taux indicatif</span><strong>1,0000</strong></div><div className="summary-line"><span>Frais de service</span><strong>0 XOF</strong></div><div className="summary-line total"><span>Arrivée estimée</span><strong>{amount ? money(Number(amount)) : '—'}</strong></div></div><button className="button button-primary button-wide" style={{ marginTop: 16 }} type="submit" disabled={!amount || source === destination} data-testid="button-submit-exchange"><RefreshCw size={15} /> Demander une vérification</button></form><div><div className="notice"><Clock3 size={15} /><span>Le délai habituel d’examen est inférieur à un jour ouvré. Votre solde source reste disponible jusqu’à l’approbation.</span></div><div className="card card-pad" style={{ marginTop: 14 }}><div className="section-head"><div><h2 className="section-title">Demandes récentes</h2><p className="section-note">L’historique de vos échanges</p></div></div>{exchanges.map(ex => <div className="activity-row" key={ex.id} data-testid={`row-exchange-${ex.id}`}><div><div className="activity-name">{ex.source} <ChevronRight size={12} style={{ verticalAlign: 'middle' }} /> {ex.destination}</div><div className="activity-meta">{ex.requestedAt} · {new Intl.NumberFormat('fr-FR').format(ex.amount)} XOF</div></div><span className={`pill ${ex.status === 'Completed' ? 'pill-success' : ex.status === 'Rejected' ? 'pill-danger' : 'pill-pending'}`}>{statusLabel(ex.status)}</span></div>)}</div></div></div></main>;
}

function PaymentLinks() {
  const { links, addLink, toast } = useStore(); const [amount, setAmount] = useState(''); const [description, setDescription] = useState(''); const [expiresAt, setExpiresAt] = useState('30 Jun 2024'); const [showForm, setShowForm] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); if (!amount || !description) return; addLink({ amount: Number(amount), currency: 'XOF', description, expiresAt }); setAmount(''); setDescription(''); setShowForm(false); };
  return <main className="page-wrap"><PageIntro eyebrow="Être payé, simplement" title="Liens de paiement" subtitle="Créez une demande à partager avec un client ou un proche. Chaque lien est enregistré dans votre compte et peut être suivi." action={<button className="button button-primary" onClick={() => setShowForm(v => !v)} data-testid="button-new-payment-link"><Plus size={15} /> Nouveau lien de paiement</button>} /><div className="notice"><QrCode size={15} /><span>Les liens actifs sont enregistrés côté serveur. Les paiements ne sont comptabilisés qu’après confirmation du prestataire.</span></div>{showForm && <form className="card card-pad" style={{ marginTop: 18, maxWidth: 700 }} onSubmit={submit}><div className="section-title" style={{ marginBottom: 17 }}>Créer un lien de paiement</div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}><div className="field"><label>Montant</label><div className="input-prefix"><span>XOF</span><input type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" data-testid="input-link-amount" /></div></div><div className="field"><label>Expiration</label><select value={expiresAt} onChange={e => setExpiresAt(e.target.value)} data-testid="select-link-expiry"><option>30 Jun 2024</option><option>15 Jul 2024</option><option>Jamais</option></select></div></div><div className="field"><label>Description</label><input value={description} onChange={e => setDescription(e.target.value)} placeholder="À quoi correspond ce paiement ?" data-testid="input-link-description" /></div><div style={{ display: 'flex', gap: 8 }}><button type="submit" className="button button-primary" disabled={!amount || !description} data-testid="button-submit-link">Créer le lien</button><button type="button" className="button button-ghost" onClick={() => setShowForm(false)} data-testid="button-cancel-link">Annuler</button></div></form>}<div className="section-head" style={{ marginTop: 29 }}><div><h2 className="section-title">Vos liens</h2><p className="section-note">{links.length} liens actifs · à partager partout</p></div></div><div className="link-list">{links.map(link => <div className="card link-card" key={link.id} data-testid={`card-payment-link-${link.id}`}><div><span className={`pill ${link.status === 'Active' ? 'pill-success' : 'pill-neutral'}`}>{statusLabel(link.status)}</span><div className="section-title" style={{ marginTop: 10 }}>{link.description}</div><div className="link-slug">{link.slug}</div><div className="activity-meta" style={{ marginTop: 8 }}>{money(link.amount, link.currency)} · expire le {link.expiresAt} · {link.payments} paiement(s)</div></div><div style={{ display: 'flex', gap: 7 }}><button className="icon-button" title="Copier le lien" onClick={() => toast('Lien copié dans le presse-papiers.')} data-testid={`button-copy-link-${link.id}`}><Copy size={15} /></button><button className="icon-button" title="Afficher le QR code" onClick={() => toast('Ouvrez la page QR Code pour afficher votre code.')} data-testid={`button-qr-link-${link.id}`}><QrCode size={15} /></button><button className="icon-button" title="Plus d’options" onClick={() => toast('Les options du lien seront disponibles prochainement.')} data-testid={`button-more-link-${link.id}`}><MoreHorizontal size={15} /></button></div></div>)}</div></main>;
}

function Kyc() {
  const [uploaded, setUploaded] = useState(false); const { toast, submitKyc } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Vérification du compte" title="Votre vérification" subtitle="Un compte vérifié rend les mouvements transfrontaliers plus sûrs pour tous. Les nouveaux documents sont enregistrés dans la file conformité." action={<span className="pill pill-success" style={{ padding: '8px 12px' }}><CheckCircle2 size={13} style={{ marginRight: 5 }} /> Vérifié</span>} /><div className="dashboard-grid" style={{ marginTop: 27 }}><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">État de la vérification</h2><p className="section-note">L’état actuel est enregistré sur votre profil Mulapay.</p></div><ShieldCheck size={24} color="hsl(160 42% 38%)" /></div><div style={{ height: 7, borderRadius: 5, background: 'hsl(160 42% 38% / .12)', overflow: 'hidden', margin: '23px 0 25px' }}><div style={{ width: uploaded ? '100%' : '66%', height: '100%', background: 'hsl(160 42% 38%)', borderRadius: 5 }} /></div><div className="step-list"><div className="step done"><div className="step-number"><Check size={13} /></div><div><div className="step-title">Informations du profil</div><div className="step-copy">Nom, email et numéro de téléphone confirmés.</div></div></div><div className="step done"><div className="step-number"><Check size={13} /></div><div><div className="step-title">Pièce d’identité</div><div className="step-copy">Carte nationale · examinée et approuvée.</div></div></div><div className={`step ${uploaded ? 'done' : ''}`}><div className="step-number">{uploaded ? <Check size={13} /> : '3'}</div><div><div className="step-title">Confirmation de l’adresse <span className="pill pill-neutral" style={{ marginLeft: 6 }}>{uploaded ? 'Envoyée' : 'Facultatif'}</span></div><div className="step-copy">{uploaded ? 'Justificatif de domicile envoyé pour examen.' : 'Ajoutez un justificatif de domicile pour augmenter vos limites.'}</div></div></div></div></div><div className="card card-pad"><div className="eyebrow">Liste des documents</div><div className="step-list" style={{ marginTop: 10 }}><div className="step done"><div className="step-number"><Check size={13} /></div><div><div className="step-title">Carte nationale</div><div className="step-copy">Approuvée et conservée dans le dossier de vérification.</div></div></div><div className={`step ${uploaded ? 'done' : ''}`}><div className="step-number">{uploaded ? <Check size={13} /> : '+'}</div><div style={{ flex: 1 }}><div className="step-title">Justificatif de domicile</div><div className="step-copy">{uploaded ? 'Document envoyé avec succès.' : 'Facture ou relevé bancaire des 3 derniers mois.'}</div>{!uploaded && <button className="button button-ghost button-sm" style={{ marginTop: 11 }} onClick={() => { setUploaded(true); submitKyc(['National ID', 'Selfie', 'Proof of address']); toast('Justificatif de domicile envoyé pour examen.'); }} data-testid="button-upload-kyc">Envoyer le document</button>}</div></div></div><div className="notice" style={{ marginTop: 20 }}><LockKeyhole size={14} /><span>Les documents sont transmis au circuit conformité Mulapay ; aucun prestataire de paiement n’intervient.</span></div></div></div></main>;
}

function Settings() {
  const { toast, signOut } = useStore(); const [name, setName] = useState('Afi Kossi'); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('+228 90 12 45 67');
  return <main className="page-wrap"><PageIntro eyebrow="Préférences du compte" title="Paramètres" subtitle="Gardez votre profil Mulapay et vos informations de sécurité à jour." /><div className="form-layout" style={{ marginTop: 27 }}><div className="card card-pad"><div className="section-title">Informations du profil</div><p className="section-note" style={{ marginTop: 5, marginBottom: 22 }}>Votre identité est gérée de façon sécurisée par Clerk ; les données de paiement restent dans le ledger Mulapay.</p><div className="field"><label>Nom complet</label><input value={name} onChange={e => setName(e.target.value)} data-testid="input-settings-name" /></div><div className="field"><label>Adresse email</label><input value={email} onChange={e => setEmail(e.target.value)} placeholder="Gérée par votre fournisseur de connexion" data-testid="input-settings-email" /></div><div className="field"><label>Numéro de téléphone</label><input value={phone} onChange={e => setPhone(e.target.value)} data-testid="input-settings-phone" /></div><div className="field"><label>Pays de résidence</label><select defaultValue="Togo" data-testid="select-settings-country"><option>Togo</option><option>Bénin</option><option>Sénégal</option><option>Côte d’Ivoire</option><option>Burkina Faso</option><option>Mali</option><option>Niger</option></select></div><button className="button button-primary" onClick={() => toast('Préférences du profil enregistrées pour la prochaine mise à jour.')} data-testid="button-save-settings">Enregistrer les changements</button></div><div><div className="card card-pad"><div className="section-title">Sécurité</div><div className="activity-row"><div className="activity-main"><div className="activity-icon"><LockKeyhole size={15} /></div><div><div className="activity-name">Authentification</div><div className="activity-meta">Gérée par Clerk avec des sessions sécurisées</div></div></div><Link className="button button-ghost button-sm" href="/sign-in">Gérer</Link></div><div className="activity-row"><div className="activity-main"><div className="activity-icon"><Bell size={15} /></div><div><div className="activity-name">Alertes de transaction</div><div className="activity-meta">Notifications email et dans l’application</div></div></div><button className="button button-primary button-sm" onClick={() => toast('Les alertes de transaction sont activées.')} data-testid="button-toggle-alerts">Activées</button></div></div><div className="card card-pad" style={{ marginTop: 14 }}><div className="eyebrow">Compte</div><button className="button button-danger button-wide" style={{ marginTop: 17 }} onClick={signOut} data-testid="button-sign-out"><LogOut size={14} /> Se déconnecter</button></div></div></div></main>;
}

function AdminOverview() {
  const { exchanges, transactions, adminSummary } = useStore();
  const pendingExchanges = exchanges.filter(exchange => exchange.status === 'Pending review').length;
  return <main className="page-wrap"><PageIntro eyebrow="Opérations sécurisées" title="Vue d’ensemble des opérations" subtitle="Une vue des contrôles et mouvements réellement enregistrés dans Mulapay." action={<Link href="/admin/exchanges" className="button button-primary" data-testid="button-admin-review"><Eye size={15} /> Ouvrir la file</Link>} /><div className="admin-grid"><div className="card admin-stat"><div className="metric-label">KYC à examiner <FileCheck2 size={15} /></div><div className="metric-value">{adminSummary?.kycAwaiting ?? 0}</div><div className="activity-meta">Dossiers persistés</div></div><div className="card admin-stat"><div className="metric-label">File des échanges <RefreshCw size={15} /></div><div className="metric-value">{pendingExchanges}</div><div className="activity-meta">Décision requise</div></div><div className="card admin-stat"><div className="metric-label">Volume enregistré <ArrowUpRight size={15} /></div><div className="metric-value">{money(adminSummary?.volume ?? 0).replace(' XOF', '')}<small>XOF</small></div><div className="activity-meta">Ledger Mulapay</div></div><div className="card admin-stat"><div className="metric-label">Taux de réussite <Activity size={15} /></div><div className="metric-value">{String(adminSummary?.successRate ?? 0).replace('.', ',')}<small>%</small></div><div className="activity-meta">Calculé par le serveur</div></div></div><div className="dashboard-grid"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Files de contrôle</h2><p className="section-note">Les dossiers et opérations nécessitant une décision.</p></div></div><Link href="/admin/exchanges" className="case-row" data-testid="link-admin-exchange-case"><div className="case-person"><div className="person-initial"><RefreshCw size={15} /></div><div><div className="case-name">Demandes d’échange</div><div className="case-meta">{pendingExchanges} demande(s) en attente</div></div></div><ChevronRight size={16} color="hsl(203 18% 46%)" /></Link><Link href="/admin/kyc" className="case-row" style={{ marginTop: 10 }} data-testid="link-admin-kyc-case"><div className="case-person"><div className="person-initial"><FileCheck2 size={15} /></div><div><div className="case-name">Dossiers KYC</div><div className="case-meta">{adminSummary?.kycAwaiting ?? 0} dossier(s) en attente</div></div></div><ChevronRight size={16} color="hsl(203 18% 46%)" /></Link></div><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">État du système</h2><p className="section-note">Données courantes du serveur</p></div><span className="pill pill-success">Opérationnel</span></div><div className="summary-box"><div className="summary-line"><span>Transactions chargées</span><strong>{transactions.length}</strong></div><div className="summary-line"><span>Échanges en attente</span><strong>{pendingExchanges}</strong></div><div className="summary-line"><span>Actions échouées</span><strong>—</strong></div></div><div className="activity-meta" style={{ marginTop: 15 }}><Activity size={12} style={{ verticalAlign: 'middle', marginRight: 5 }} /> Actualisé depuis l’API</div></div></div><div className="card card-pad" style={{ marginTop: 17 }}><div className="section-head"><div><h2 className="section-title">Derniers mouvements</h2><p className="section-note">Sur tous les wallets par pays</p></div><Link href="/admin/transactions" className="eyebrow" data-testid="link-admin-all-transactions">Voir le ledger</Link></div>{transactions.slice(0, 3).map(t => <TransactionRow transaction={t} key={t.id} />)}</div></main>;
}

function AdminKyc() {
  const { adminKyc, adminSummary, decideKyc, toast } = useStore();
  const pending = adminKyc.filter(item => item.status === 'EN_ATTENTE');
  const decide = (id: string, accepted: boolean) => { decideKyc(id, accepted); toast(accepted ? 'Dossier KYC approuvé.' : 'Dossier KYC refusé.'); };
  return <main className="page-wrap"><PageIntro eyebrow="Confiance et sécurité" title="Revue KYC" subtitle="Examinez les dossiers d’identité qui protègent le réseau Mulapay. Les documents restent dans le circuit de revue conformité." action={<span className="pill pill-pending"><Clock3 size={13} style={{ marginRight: 5 }} /> {adminSummary?.kycAwaiting ?? pending.length} à examiner</span>} /><div className="card card-pad" style={{ marginTop: 28 }}><div className="section-head"><div><h2 className="section-title">File de revue</h2><p className="section-note">Du plus ancien au plus récent · chaque décision est enregistrée et notifie le titulaire.</p></div><div className="filter-set"><button className="filter-button active" data-testid="button-kyc-filter-pending">En attente</button><button className="filter-button" onClick={() => toast('Les dossiers approuvés sont disponibles dans l’historique d’audit.')} data-testid="button-kyc-filter-approved">Approuvés</button></div></div><div className="case-list">{pending.map(item => <div className="case-row" key={item.id} data-testid={`row-kyc-${item.id}`}><div className="case-person"><div className="person-initial">{item.name.split(' ').map(n => n[0]).join('')}</div><div><div className="case-name">{item.name}</div><div className="case-meta">{countryLabel(item.country)} · {item.documents.join(' · ')} · envoyé le {new Date(item.submittedAt).toLocaleString('fr-FR')}</div></div></div><div className="case-actions"><button className="button button-ghost button-sm" onClick={() => toast(`Ouverture des documents de ${item.name}.`)} data-testid={`button-view-kyc-${item.id}`}><Eye size={13} /> Voir</button><button className="button button-primary button-sm" onClick={() => decide(item.id, true)} data-testid={`button-approve-kyc-${item.id}`}><Check size={13} /> Approuver</button><button className="button button-danger button-sm" onClick={() => decide(item.id, false)} data-testid={`button-reject-kyc-${item.id}`}><X size={13} /></button></div></div>)}{pending.length === 0 && <div className="empty-state"><CheckCircle2 size={25} /><strong>La file est vide</strong><p>Les nouveaux dossiers d’identité apparaîtront ici.</p></div>}</div></div></main>;
}

function AdminExchanges() {
  const { exchanges, setExchangeStatus, toast } = useStore();
  const pending = exchanges.filter(e => e.status === 'Pending review');
  return <main className="page-wrap"><PageIntro eyebrow="Opérations / liquidité" title="File des échanges" subtitle="Approuvez ou refusez les demandes entre wallets. Une décision met à jour la timeline du client." /><div className="notice"><Info size={15} /><span>Les validations admin appliquent les limites, le solde source et les contrôles conformité côté serveur.</span></div><div className="card card-pad" style={{ marginTop: 22 }}><div className="section-head"><div><h2 className="section-title">À examiner</h2><p className="section-note">{pending.length} demande(s) prête(s) pour décision</p></div><span className="pill pill-pending"><Clock3 size={12} style={{ marginRight: 5 }} /> Revue manuelle</span></div>{pending.map(ex => <div className="case-row" key={ex.id} data-testid={`row-admin-exchange-${ex.id}`}><div className="case-person"><div className="person-initial"><ArrowRightLeft size={15} /></div><div><div className="case-name">{ex.source} <ChevronRight size={12} style={{ verticalAlign: 'middle' }} /> {ex.destination}</div><div className="case-meta">{ex.requestedAt} · montant demandé {money(ex.amount)} · taux {ex.rate.toFixed(4)}</div></div></div><div className="case-actions"><button className="button button-primary button-sm" onClick={() => { setExchangeStatus(ex.id, 'Completed'); toast('Échange approuvé et marqué comme effectué.'); }} data-testid={`button-approve-exchange-${ex.id}`}><Check size={13} /> Approuver</button><button className="button button-danger button-sm" onClick={() => { setExchangeStatus(ex.id, 'Rejected'); toast('Échange refusé et client notifié.'); }} data-testid={`button-reject-exchange-${ex.id}`}><X size={13} /> Refuser</button></div></div>)}{pending.length === 0 && <div className="empty-state"><CheckCircle2 size={25} /><strong>Aucun échange en attente</strong><p>La file est à jour.</p></div>}</div><div className="card table-card"><div className="table-toolbar"><div><h2 className="section-title">Historique des décisions</h2></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Parcours</th><th>Demandé</th><th>Reçu</th><th>Demandé le</th><th>Statut</th></tr></thead><tbody>{exchanges.map(ex => <tr key={ex.id}><td>{ex.source} <ChevronRight size={11} style={{ verticalAlign: 'middle' }} /> {ex.destination}</td><td>{money(ex.amount)}</td><td>{money(ex.receivedAmount)}</td><td>{ex.requestedAt}</td><td><span className={`pill ${ex.status === 'Completed' ? 'pill-success' : ex.status === 'Rejected' ? 'pill-danger' : 'pill-pending'}`}>{statusLabel(ex.status)}</span></td></tr>)}</tbody></table></div></div></main>;
}

function AdminTransactions() {
  const { adminTransactions: transactions, toast } = useStore(); const [query, setQuery] = useState('');
  const filtered = transactions.filter(t => `${t.reference} ${t.counterparty} ${t.country}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="page-wrap"><PageIntro eyebrow="Opérations / ledger" title="Toutes les transactions" subtitle="Une vue réseau des mouvements enregistrés sur chaque marché actif." action={<button className="button button-ghost" onClick={() => toast('L’export sera disponible après activation des permissions de téléchargement.')} data-testid="button-admin-export"><Download size={15} /> Exporter le ledger</button>} /><div className="card table-card"><div className="table-toolbar"><div className="eyebrow"><ListFilter size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> {filtered.length} mouvement(s) visible(s)</div><div className="input-prefix" style={{ width: 220 }}><Search size={14} style={{ position: 'absolute', left: 12, top: 11, color: 'hsl(203 18% 46%)' }} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Rechercher dans le ledger" style={{ width: '100%', border: '1px solid hsl(38 28% 85%)', background: 'hsl(42 44% 99%)', borderRadius: 9, padding: '9px 10px 9px 32px', fontSize: 11, outline: 0 }} data-testid="input-admin-search" /></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Référence</th><th>Contrepartie</th><th>Marché</th><th>Type</th><th>Montant</th><th>Statut</th></tr></thead><tbody>{filtered.map(t => <tr key={t.id} data-testid={`row-admin-transaction-${t.id}`}><td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{t.reference}</td><td style={{ fontWeight: 700 }}>{t.counterparty}</td><td>{countryLabel(t.country)} · {t.currency}</td><td>{movementLabel(t.type)}</td><td style={{ fontFamily: 'var(--font-mono)' }}>{money(t.amount, t.currency)}</td><td><span className={`pill ${t.status === 'Completed' ? 'pill-success' : 'pill-pending'}`}>{statusLabel(t.status)}</span></td></tr>)}</tbody></table></div></div></main>;
}

function Notifications({ onClose }: { onClose: () => void }) {
  const { notifications, markRead } = useStore();
  return <div className="notification-popover card card-pad"><div className="notification-popover-header"><div><h2 className="section-title">Notifications</h2><p className="section-note">Gardez votre compte sous contrôle</p></div><button className="notification-close" onClick={onClose} aria-label="Fermer les notifications" data-testid="button-close-notifications"><X size={15} /></button></div>{notifications.map(item => { const copy = notificationCopy(item); return <button key={item.id} onClick={() => markRead(item.id)} style={{ display: 'block', width: '100%', border: 0, textAlign: 'left', background: item.read ? 'transparent' : 'hsl(39 78% 89% / .35)', borderRadius: 8, padding: 10, cursor: 'pointer', marginTop: 4 }} data-testid={`button-notification-${item.id}`}><div style={{ fontWeight: 700, fontSize: 11 }}>{copy.title}</div><div className="activity-meta">{copy.body}</div>{!item.read && <div className="eyebrow" style={{ marginTop: 6 }}>Marquer comme lue</div>}</button>; })}</div>;
}

function RoutedApp() {
  const [location, setLocation] = useLocation();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [toastText, setToastText] = useState('');
  const toast = (message: string) => { setToastText(message); window.setTimeout(() => setToastText(''), 2600); };
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const bootstrapQuery = useGetBootstrap({ query: { queryKey: getGetBootstrapQueryKey(), enabled: isLoaded && isSignedIn, retry: false } });
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
    profile: { ...(data?.profile ?? { id: '', firstName: 'Utilisateur', lastName: 'Mulapay', email: '', role: 'USER', country: 'Togo', kycStatus: 'NON_VERIFIE' }), firstName: user?.firstName ?? data?.profile.firstName ?? 'Utilisateur', lastName: user?.lastName ?? data?.profile.lastName ?? 'Mulapay', email: user?.primaryEmailAddress?.emailAddress ?? data?.profile.email ?? '' },
    wallets: data?.wallets ?? [], transactions: data?.transactions ?? [], exchanges: data?.exchanges ?? [], links: data?.links ?? [], notifications: data?.notifications ?? [],
    adminKyc: (adminKycQuery.data ?? []) as AdminKycCase[], adminTransactions: (adminTransactionsQuery.data ?? []) as Transaction[], adminSummary: adminSummaryQuery.data as AdminSummary | undefined,
    transfer: ({ amount, currency, counterparty, note }) => { transferMutation.mutate({ data: { amount, currency, counterparty, note } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('Transfert impossible. Vérifiez le solde disponible.') }); },
    exchange: ({ source, destination, amount }) => { exchangeMutation.mutate({ data: { source, destination, amount } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('La demande d’échange n’a pas pu être créée.') }); },
    setExchangeStatus: (id, status) => { exchangeDecisionMutation.mutate({ id, data: { decision: status === 'Completed' ? 'APPROVED' : 'REJECTED' } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('La décision d’échange n’a pas pu être enregistrée.') }); },
    addLink: ({ amount, currency, description, expiresAt }) => { paymentLinkMutation.mutate({ data: { amount, currency, description, expiresAt } }, { onSuccess: response => { invalidate(); toast(`Lien de paiement ${response.slug} créé.`); }, onError: () => toast('Le lien de paiement n’a pas pu être créé.') }); },
    markRead: id => { notificationMutation.mutate({ id }, { onSuccess: () => { invalidate(); } }); },
    submitKyc: documents => { kycMutation.mutate({ data: { country: data?.profile.country ?? 'Togo', documents } }, { onSuccess: () => { invalidate(); toast('Documents KYC envoyés pour examen.'); }, onError: () => toast('Le dossier KYC n’a pas pu être enregistré.') }); },
    decideKyc: (id, accepted) => { kycDecisionMutation.mutate({ id, data: { decision: accepted ? 'VERIFIED' : 'REFUSED' } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('La décision KYC n’a pas pu être enregistrée.') }); },
    signOut: () => { void signOut({ redirectUrl: basePath || '/' }); },
    toast,
  };
  if (!isLoaded || bootstrapQuery.isLoading) return <div className="loading-screen">Chargement de votre espace Mulapay…</div>;
  if (!isSignedIn) return <Redirect to="/" />;
  const admin = location.startsWith('/admin') && data?.profile.role === 'ADMIN';
  if (location.startsWith('/admin') && !admin) return <Redirect to="/app" />;
  return <StoreContext.Provider value={store}><Shell admin={admin} onNotifications={() => setNotificationsOpen(v => !v)}>{admin ? <Switch><Route path="/admin" component={AdminOverview} /><Route path="/admin/kyc" component={AdminKyc} /><Route path="/admin/exchanges" component={AdminExchanges} /><Route path="/admin/transactions" component={AdminTransactions} /><Route component={NotFound} /></Switch> : <Switch><Route path="/app" component={Overview} /><Route path="/app/wallets" component={Wallets} /><Route path="/app/deposit" component={Deposit} /><Route path="/app/withdrawal" component={Withdrawal} /><Route path="/app/transactions" component={Transactions} /><Route path="/app/transfer" component={Transfer} /><Route path="/app/receive" component={Receive} /><Route path="/app/exchange" component={Exchange} /><Route path="/app/payments" component={Payments} /><Route path="/app/payment-links" component={PaymentLinks} /><Route path="/app/qr" component={QrPage} /><Route path="/app/api" component={ApiAccess} /><Route path="/app/api-docs" component={ApiPayinDocs} /><Route path="/app/documents" component={ApiPayinDocs} /><Route path="/app/notifications" component={NotificationsPage} /><Route path="/app/kyc" component={Kyc} /><Route path="/app/security" component={Security} /><Route path="/app/support" component={Support} /><Route path="/app/settings" component={Settings} /><Route component={NotFound} /></Switch>}</Shell>{notificationsOpen && <Notifications onClose={() => setNotificationsOpen(false)} />}{toastText && <div className="toast" data-testid="status-toast">{toastText}</div>}</StoreContext.Provider>;
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
     logoImageUrl: `${window.location.origin}${basePath}/logo.png`,
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

const COUNTRY_OPTIONS = ['Togo', 'Bénin', 'Côte d’Ivoire', 'Burkina Faso', 'Sénégal', 'Mali', 'Niger'];

function authErrorMessage(error: unknown) {
  const value = error as { errors?: Array<{ longMessage?: string; message?: string }>; message?: string };
  const issue = value?.errors?.[0];
  return issue?.longMessage ?? issue?.message ?? value?.message ?? 'La demande n’a pas pu être traitée. Vérifiez les informations saisies.';
}

function AuthFrame({ eyebrow, title, subtitle, children, footer }: { eyebrow: string; title: string; subtitle: string; children: ReactNode; footer?: ReactNode }) {
  return <div className="auth-page"><div className="auth-orbit auth-orbit-one" /><div className="auth-orbit auth-orbit-two" /><div className="auth-card"><div className="auth-brand"><Logo /><span className="auth-mode">Accès sécurisé</span></div><div className="auth-heading"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{children}{footer && <div className="auth-footer">{footer}</div>}<div className="auth-notice"><ShieldCheck size={14} /><span>Votre identité est gérée par Clerk. Les données financières Mulapay restent protégées côté serveur.</span></div></div></div>;
}

function PasswordInput({ value, onChange, placeholder, autoComplete, show, onToggle }: { value: string; onChange: (value: string) => void; placeholder: string; autoComplete: string; show: boolean; onToggle: () => void }) {
  return <div className="auth-password-wrap"><input type={show ? 'text' : 'password'} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} autoComplete={autoComplete} required /><button type="button" className="auth-eye" onClick={onToggle} aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>{show ? 'Masquer' : 'Afficher'}</button></div>;
}

function SignInPage() {
  const { signIn } = useSignIn();
  const [, setLocation] = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const created = await (signIn as any).create({ identifier });
      if (created.error) throw created.error;
      const completed = await (signIn as any).password({ password });
      if (completed.error) throw completed.error;
      if ((signIn as any).status !== 'complete') {
        setError('Une étape supplémentaire de vérification est requise. Recommencez depuis votre e-mail.');
        return;
      }
      const finalized = await (signIn as any).finalize();
      if (finalized.error) throw finalized.error;
      setLocation('/app');
    } catch (authError) {
      setError(authErrorMessage(authError));
    } finally {
      setSubmitting(false);
    }
  };
  return <AuthFrame eyebrow="Espace membre" title="Se connecter" subtitle="Accédez à vos wallets, vos opérations et votre historique Mulapay." footer={<><span>Pas encore de compte ?</span><Link href="/sign-up">Créer un compte</Link></>}><form className="auth-form" onSubmit={submit}>{error && <div className="auth-error">{error}</div>}<label>Adresse e-mail ou numéro de téléphone<input value={identifier} onChange={event => setIdentifier(event.target.value)} placeholder="vous@exemple.com ou +228…" autoComplete="username" required /></label><label>Mot de passe<PasswordInput value={password} onChange={setPassword} placeholder="Votre mot de passe" autoComplete="current-password" show={showPassword} onToggle={() => setShowPassword(value => !value)} /></label><Link href="/forgot-password" className="auth-forgot">Mot de passe oublié ?</Link><button className="button button-primary auth-submit" type="submit" disabled={submitting}>{submitting ? 'Connexion…' : 'Se connecter'} <ChevronRight size={15} /></button></form></AuthFrame>;
}

function SignUpPage() {
  const { signUp } = useSignUp();
  const [, setLocation] = useLocation();
  const [step, setStep] = useState<'form' | 'verification'>('form');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('Togo');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  const [terms, setTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) { setError('Les deux mots de passe doivent être identiques.'); return; }
    if (!terms) { setError('Veuillez accepter les Conditions d’utilisation et la Politique de confidentialité.'); return; }
    setError('');
    setSubmitting(true);
    try {
      const created = await (signUp as any).create({ firstName, lastName, emailAddress: email, legalAccepted: true, unsafeMetadata: { phone, country, acceptedTermsAt: new Date().toISOString() } });
      if (created.error) throw created.error;
      const passwordSet = await (signUp as any).password({ password });
      if (passwordSet.error) throw passwordSet.error;
      const verification = await (signUp as any).verifications.sendEmailCode();
      if (verification.error) throw verification.error;
      setStep('verification');
    } catch (authError) {
      setError(authErrorMessage(authError));
    } finally {
      setSubmitting(false);
    }
  };
  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const verification = await (signUp as any).verifications.verifyEmailCode({ code });
      if (verification.error) throw verification.error;
      if ((signUp as any).status !== 'complete') { setError('Le code n’a pas encore terminé l’inscription.'); return; }
      const finalized = await (signUp as any).finalize();
      if (finalized.error) throw finalized.error;
      setLocation('/app/kyc');
    } catch (authError) {
      setError(authErrorMessage(authError));
    } finally {
      setSubmitting(false);
    }
  };
  if (step === 'verification') return <AuthFrame eyebrow="Vérification obligatoire" title="Confirmez votre adresse" subtitle={`Saisissez le code reçu à ${email} pour terminer votre inscription.`} footer={<><span>Vous avez déjà un compte ?</span><Link href="/sign-in">Se connecter</Link></>}><form className="auth-form" onSubmit={verify}>{error && <div className="auth-error">{error}</div>}<label>Code de vérification OTP<input value={code} onChange={event => setCode(event.target.value)} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" required /></label><button className="button button-primary auth-submit" type="submit" disabled={submitting}>{submitting ? 'Vérification…' : 'Vérifier et continuer'} <ChevronRight size={15} /></button><button type="button" className="button button-ghost auth-submit" onClick={() => setStep('form')}>Modifier mes informations</button></form></AuthFrame>;
  return <AuthFrame eyebrow="Nouveau membre" title="Créer votre compte" subtitle="Un compte unique pour gérer vos wallets dans toute l’Afrique de l’Ouest." footer={<><span>Déjà un compte ?</span><Link href="/sign-in">Se connecter</Link></>}><form className="auth-form" onSubmit={submit}>{error && <div className="auth-error">{error}</div>}<div className="auth-field-grid"><label>Prénom<input value={firstName} onChange={event => setFirstName(event.target.value)} placeholder="Votre prénom" autoComplete="given-name" required /></label><label>Nom<input value={lastName} onChange={event => setLastName(event.target.value)} placeholder="Votre nom" autoComplete="family-name" required /></label></div><label>Adresse e-mail<input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="vous@exemple.com" autoComplete="email" required /></label><label>Numéro de téléphone<input type="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="+228…" autoComplete="tel" required /></label><label>Pays de résidence<select value={country} onChange={event => setCountry(event.target.value)}>{COUNTRY_OPTIONS.map(option => <option key={option}>{option}</option>)}</select></label><label>Mot de passe<PasswordInput value={password} onChange={setPassword} placeholder="Créer un mot de passe" autoComplete="new-password" show={showPassword} onToggle={() => setShowPassword(value => !value)} /></label><label>Confirmation du mot de passe<PasswordInput value={confirmation} onChange={setConfirmation} placeholder="Confirmer le mot de passe" autoComplete="new-password" show={showPassword} onToggle={() => setShowPassword(value => !value)} /></label><label className="auth-checkbox"><input type="checkbox" checked={terms} onChange={event => setTerms(event.target.checked)} required /><span>J’accepte les <Link href="/terms">Conditions d’utilisation</Link> et la <Link href="/privacy">Politique de confidentialité</Link>.</span></label><button className="button button-primary auth-submit" type="submit" disabled={submitting}>{submitting ? 'Création…' : 'Créer mon compte'} <ChevronRight size={15} /></button></form></AuthFrame>;
}

function ForgotPasswordPage() {
  const { signIn } = useSignIn();
  const [, setLocation] = useLocation();
  const [step, setStep] = useState<'identify' | 'code' | 'password'>('identify');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const requestCode = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const created = await (signIn as any).create({ identifier });
      if (created.error) throw created.error;
      const sent = await (signIn as any).resetPasswordEmailCode.sendCode();
      if (sent.error) throw sent.error;
      setStep('code');
    } catch (authError) { setError(authErrorMessage(authError)); } finally { setSubmitting(false); }
  };
  const verifyCode = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const verification = await (signIn as any).resetPasswordEmailCode.verifyCode({ code });
      if (verification.error) throw verification.error;
      setStep('password');
    } catch (authError) { setError(authErrorMessage(authError)); } finally { setSubmitting(false); }
  };
  const reset = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await (signIn as any).resetPasswordEmailCode.submitPassword({ password });
      if (result.error) throw result.error;
      if ((signIn as any).status === 'complete') {
        const finalized = await (signIn as any).finalize();
        if (finalized.error) throw finalized.error;
        setLocation('/app');
      } else setLocation('/sign-in');
    } catch (authError) { setError(authErrorMessage(authError)); } finally { setSubmitting(false); }
  };
  const title = step === 'identify' ? 'Réinitialiser le mot de passe' : step === 'code' ? 'Vérifier votre adresse' : 'Créer un nouveau mot de passe';
  const subtitle = step === 'identify' ? 'Recevez un code sécurisé pour récupérer votre accès.' : step === 'code' ? `Saisissez le code reçu à ${identifier}.` : 'Choisissez un nouveau mot de passe pour votre compte.';
  return <AuthFrame eyebrow="Récupération du compte" title={title} subtitle={subtitle}>{error && <div className="auth-error">{error}</div>}{step === 'identify' && <form className="auth-form" onSubmit={requestCode}><label>Adresse e-mail<input type="email" value={identifier} onChange={event => setIdentifier(event.target.value)} placeholder="vous@exemple.com" autoComplete="email" required /></label><button className="button button-primary auth-submit" type="submit" disabled={submitting}>{submitting ? 'Envoi…' : 'Recevoir le code'} <ChevronRight size={15} /></button></form>}{step === 'code' && <form className="auth-form" onSubmit={verifyCode}><label>Code OTP<input value={code} onChange={event => setCode(event.target.value)} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" required /></label><button className="button button-primary auth-submit" type="submit" disabled={submitting}>{submitting ? 'Vérification…' : 'Vérifier le code'} <ChevronRight size={15} /></button></form>}{step === 'password' && <form className="auth-form" onSubmit={reset}><label>Nouveau mot de passe<input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Nouveau mot de passe" autoComplete="new-password" required /></label><button className="button button-primary auth-submit" type="submit" disabled={submitting}>{submitting ? 'Enregistrement…' : 'Enregistrer le mot de passe'} <ChevronRight size={15} /></button></form>}<div className="auth-back"><Link href="/sign-in">Retour à la connexion</Link></div></AuthFrame>;
}

function LegalPage({ kind }: { kind: 'terms' | 'privacy' }) {
  const isTerms = kind === 'terms';
  return <main className="page-wrap legal-page"><Link href="/sign-up" className="eyebrow">← Retour à l’inscription</Link><h1 className="page-title">{isTerms ? 'Conditions d’utilisation' : 'Politique de confidentialité'}</h1><p className="page-subtitle">{isTerms ? 'Les règles qui encadrent l’utilisation responsable de Mulapay.' : 'Les principes appliqués pour protéger vos données personnelles et financières.'}</p><div className="card card-pad legal-card"><h2>{isTerms ? 'Utilisation du service' : 'Données collectées'}</h2><p>{isTerms ? 'Mulapay fournit une interface de gestion de wallets et d’opérations financières soumises aux contrôles de compte, KYC, limites et prestataires autorisés.' : 'Mulapay traite les informations nécessaires à l’authentification, à la vérification KYC, à la sécurité et à l’exécution des opérations demandées.'}</p><h2>{isTerms ? 'Responsabilités' : 'Vos droits'}</h2><p>{isTerms ? 'Vous devez protéger vos moyens d’accès et fournir des informations exactes. Les opérations peuvent être suspendues pour des raisons de sécurité ou de conformité.' : 'Vous pouvez demander l’accès, la rectification ou la suppression des données selon les obligations légales applicables.'}</p></div></main>;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="loading-screen">Chargement de Mulapay…</div>;
  return isSignedIn ? <Redirect to="/app" /> : <Landing />;
}

function Router() {
  return <Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/forgot-password" component={ForgotPasswordPage} /><Route path="/terms" component={() => <LegalPage kind="terms" />} /><Route path="/privacy" component={() => <LegalPage kind="privacy" />} /><Route path="/app" component={RoutedApp} /><Route path="/app/:rest*" component={RoutedApp} /><Route path="/admin" component={RoutedApp} /><Route path="/admin/:rest*" component={RoutedApp} /><Route component={NotFound} /></Switch>;
}

function App() {
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={basePath}><ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={frFR}><Router /></ClerkProvider></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;