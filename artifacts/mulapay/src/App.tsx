import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useState } from 'react';
import {
  Activity, ArrowDown, ArrowDownLeft, ArrowLeft, ArrowRightLeft, ArrowRight, ArrowUpRight, Banknote, Bell, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleAlert, Clock3, Copy, Download, Eye, FileCheck2, Globe2, Info, LayoutDashboard,
  Link2, ListFilter, LockKeyhole, LogOut, Menu, MoreHorizontal, Pencil, Plus, QrCode, RefreshCw, Search,
  Send, Settings2, ShieldCheck, Trash2, WalletCards, X
} from 'lucide-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, useAuth, useClerk, useSignIn, useSignUp, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { frFR } from '@clerk/localizations';
import { QRCodeSVG } from 'qrcode.react';
import {
  getGetBootstrapQueryKey,
  getGetAdminSummaryQueryKey,
  getGetAdminSettingsQueryKey,
  getListAdminKycQueryKey,
  getListAdminTransactionsQueryKey,
  useCreateExchange,
  useCreatePaymentLink,
  useCreateTransfer,
  useDeletePaymentLink,
  useUpdatePaymentLink,
  useDecideExchange,
  useDecideKyc,
  useGetAdminSummary,
  useGetAdminSettings,
  useGetBootstrap,
  useListAdminKyc,
  useListAdminTransactions,
  useMarkNotificationRead,
  useSubmitKyc,
  useUpdateAdminSettings,
} from '@workspace/api-client-react';
import type { PaymentLink as ApiPaymentLink, PaymentLinkInput } from '@workspace/api-client-react';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

type Wallet = { id: string; country: string; code: string; currency: string; balance: number; pending: number; status: string };
type Transaction = { id: string; type: string; status: string; amount: number; currency: string; country: string; counterparty: string; createdAt: string; reference: string };
type Exchange = { id: string; source: string; destination: string; amount: number; rate: number; receivedAmount: number; status: string; requestedAt: string };
type PaymentLink = ApiPaymentLink;
type PublicPaymentLink = Omit<PaymentLink, 'id' | 'walletId' | 'notifyApp' | 'notifyEmail' | 'notifyWebhook'>;
type Notification = { id: string; title: string; body: string; read: boolean };
type ApiKey = { id: string; name: string; keyPrefix: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };
type AdminKycCase = { id: string; userId: string; name: string; country: string; status: string; documents: string[]; submittedAt: string };
type AdminSummary = { kycAwaiting: number; exchangeQueue: number; volume: number; successRate: number };
type Store = {
  profile: { id: string; firstName: string; lastName: string; email: string; role: string; country: string; kycStatus: string };
  wallets: Wallet[]; transactions: Transaction[]; exchanges: Exchange[]; links: PaymentLink[]; notifications: Notification[];
  adminKyc: AdminKycCase[]; adminTransactions: Transaction[]; adminSummary?: AdminSummary; feePercentage: number;
  transfer: (data: { amount: number; currency: string; country: string; counterparty: string; note: string; feePayer: 'sender' | 'recipient' }) => void;
  exchange: (data: { source: string; destination: string; amount: number }) => void;
  setExchangeStatus: (id: string, status: string) => void;
  addLink: (data: PaymentLinkInput) => void;
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

function calculateFee(amount: number, percentage: number) {
  return Math.round(amount * percentage / 100);
}

function statusLabel(status: string) {
  return ({ Active: 'Actif', Pending: 'En attente', Processing: 'En traitement', Completed: 'Effectué', Failed: 'Échoué', Expired: 'Expiré', Cancelled: 'Annulé', Reversed: 'Remboursé', 'Pending review': 'À examiner', Rejected: 'Refusé', EN_ATTENTE: 'En attente', VERIFIED: 'Vérifié', REFUSED: 'Refusé' } as Record<string, string>)[status] ?? status;
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

function transactionOperator(counterparty: string) {
  if (!counterparty.toLowerCase().includes('mobile money')) return undefined;
  const match = counterparty.match(/·\s*(.+)$/);
  return match?.[1];
}

function countryFlagUrl(country: string) {
  const option = mobileMoneyCountryOptions.find(item => item.country === country || item.code === country);
  return `${import.meta.env.BASE_URL}countries/${option?.flagSrc ?? `${country.toLowerCase()}.png`}`;
}

function operatorLogoUrl(operator?: string) {
  if (!operator) return undefined;
  const normalized = operator.toLowerCase();
  const provider = mobileMoneyProviders.find(item => normalized.includes(item.name.toLowerCase()));
  return provider ? `${import.meta.env.BASE_URL}mobile-money/${provider.src}` : undefined;
}

function transactionIsIncoming(transaction: Pick<Transaction, 'type' | 'counterparty'>) {
  if (transaction.type === 'Received' || transaction.type === 'Deposit' || transaction.type === 'Exchange') return true;
  if (transaction.type !== 'Payment') return false;
  const counterparty = transaction.counterparty.toLowerCase();
  return counterparty.includes('paiement par lien') || counterparty.includes('paiement api') || counterparty.includes('paiement reçu') || counterparty.includes('payment link') || counterparty.includes('payin');
}

function transactionServiceLogo(counterparty: string) {
  const normalized = counterparty.toLowerCase();
  if (normalized.includes('lien')) return dashboardIcon('payment-links.png');
  if (normalized.includes('api')) return dashboardIcon('api.png');
  if (normalized.includes('envoi')) return dashboardIcon('transfer.png');
  return dashboardIcon('transactions.png');
}

function transactionDateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? dateLabel(value) : date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
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
  { code: 'TG', country: 'Togo', flagSrc: 'togo.png', dialCode: '+228', operators: [{ name: 'Mixx by Yas', src: 'mixx_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }] },
  { code: 'BJ', country: 'Bénin', flagSrc: 'benin.png', dialCode: '+229', operators: [{ name: 'MTN MoMo', src: 'mtn-momo_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }] },
  { code: 'CI', country: 'Côte d’Ivoire', flagSrc: 'cote-divoire.png', dialCode: '+225', operators: [{ name: 'Orange Money', src: 'orange-money_no_bg.png' }, { name: 'MTN MoMo', src: 'mtn-momo_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }, { name: 'Wave', src: 'wave_no_bg.png' }] },
  { code: 'BF', country: 'Burkina Faso', flagSrc: 'burkina-faso.png', dialCode: '+226', operators: [{ name: 'Orange Money', src: 'orange-money_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }, { name: 'Airtel Money', src: 'airtel-money_no_bg.png' }] },
  { code: 'SN', country: 'Sénégal', flagSrc: 'senegal.png', dialCode: '+221', operators: [{ name: 'Wave', src: 'wave_no_bg.png' }, { name: 'Orange Money', src: 'orange-money_no_bg.png' }] },
  { code: 'ML', country: 'Mali', flagSrc: 'mali.png', dialCode: '+223', operators: [{ name: 'Orange Money', src: 'orange-money_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }, { name: 'Airtel Money', src: 'airtel-money_no_bg.png' }] },
  { code: 'NE', country: 'Niger', flagSrc: 'niger.png', dialCode: '+227', operators: [{ name: 'Airtel Money', src: 'airtel-money_no_bg.png' }, { name: 'Moov Money', src: 'moov-money_no_bg.png' }, { name: 'Orange Money', src: 'orange-money_no_bg.png' }] },
];

const landingFeatures = [
  { icon: ArrowDownLeft, eyebrow: '01', title: 'Dépôt', copy: 'Ajoutez de l’argent facilement avec les moyens de paiement disponibles.' },
  { icon: ArrowUpRight, eyebrow: '02', title: 'Retrait', copy: 'Le retrait sera ouvert dès que le service de règlement réel sera disponible.' },
  { icon: Send, eyebrow: '03', title: 'Transfert', copy: 'Le transfert sera ouvert après raccordement à un service de règlement réel.' },
  { icon: RefreshCw, eyebrow: '04', title: 'Échange', copy: 'Les conversions entre pays seront disponibles après activation du règlement réel.' },
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
          <div className="hero-float-card hero-float-card-top"><span className="float-icon"><ShieldCheck size={14} /></span><span><small>confirmation serveur</small><strong>Paiement sécurisé</strong></span></div>
          <div className="hero-phone">
            <div className="phone-side-button phone-side-button-one" /><div className="phone-side-button phone-side-button-two" />
            <div className="phone-frame"><div className="phone-notch" /><div className="phone-screen">
              <div className="phone-status"><span>09:41</span><span>Mulapay · sécurisé</span></div>
              <div className="phone-brandline"><span className="phone-mini-logo">M</span><span>Bonjour, votre espace.</span><span className="phone-avatar">M</span></div>
              <div className="phone-balance-card"><span>Votre solde consolidé</span><strong>•••••• <small>XOF</small></strong><em>Données de votre compte</em></div>
              <div className="phone-section-head"><span>Vos wallets</span><span>Voir tout</span></div>
              <div className="phone-wallet-row"><span className="phone-country-code">TG</span><span><strong>Togo</strong><small>Wallet disponible</small></span><b>•••• XOF</b></div>
              <div className="phone-wallet-row"><span className="phone-country-code blue">BJ</span><span><strong>Bénin</strong><small>Wallet disponible</small></span><b>•••• XOF</b></div>
              <div className="phone-section-head phone-section-head-activity"><span>Activité récente</span><span>Après confirmation</span></div>
              <div className="phone-activity"><span className="phone-activity-icon"><ShieldCheck size={12} /></span><span><strong>Aucune opération</strong><small>Votre historique apparaîtra ici</small></span><b>—</b></div>
              <div className="phone-bottom-nav"><span className="active"><LayoutDashboard size={14} />Accueil</span><span><WalletCards size={14} />Wallets</span><span><QrCode size={14} />Payer</span><span><Menu size={14} />Plus</span></div>
            </div></div>
          </div>
          <div className="hero-money-marquee" aria-label="Réseaux Mobile Money">
            <div className="hero-money-track">{mobileMoneyProviders.concat(mobileMoneyProviders).map((provider, index) => <span className="hero-money-item" key={`hero-money-${provider.name}-${index}`}><span className="hero-money-logo"><img src={assetUrl(provider.src)} alt={provider.name} /></span><small>{provider.name}</small></span>)}</div>
          </div>
          <div className="hero-float-card hero-float-card-bottom"><span className="float-check"><Check size={14} /></span><span><small>après confirmation</small><strong>Historique réel</strong></span></div>
        </div>
      </section>
      <section className="landing-section landing-countries" id="pays">
        <div className="landing-section-heading"><div><div className="eyebrow">une présence régionale</div><h2>MULAPAY en Afrique de l’Ouest</h2></div><p>Une expérience financière pensée pour les réalités de notre région.</p></div>
        <div className="country-grid">{landingCountries.map((country, index) => <div className={`country-card ${index === 0 ? 'featured' : ''}`} key={country.code}><span className="country-code-large">{country.code}</span><span><strong>{country.name}</strong><small>{country.detail}</small></span><ChevronRight size={15} /></div>)}</div>
      </section>
      <section className="landing-wallet-section">
        <div className="landing-wallet-copy"><div className="eyebrow">la différence Mulapay</div><h2>Tous vos wallets.<br /><em>Un seul compte.</em></h2><p>Visualisez vos soldes par pays, gardez le contrôle de vos mouvements et préparez vos échanges depuis une seule interface.</p><Link href="/sign-up" className="text-link">Découvrir Mulapay <ChevronRight size={15} /></Link></div>
        <div className="wallet-showcase">
          <div className="wallet-showcase-head"><div><span className="showcase-label">votre solde</span><strong>— <small>FCFA</small></strong></div><span className="wallet-showcase-menu"><MoreHorizontal size={17} /></span></div>
          <div className="showcase-wallet-list"><div><span className="showcase-country tg">TG</span><span><strong>Togo</strong><small>Wallet disponible</small></span><b>— <small>FCFA</small></b></div><div><span className="showcase-country bj">BJ</span><span><strong>Bénin</strong><small>Wallet disponible</small></span><b>— <small>FCFA</small></b></div><div><span className="showcase-country ci">CI</span><span><strong>Côte d’Ivoire</strong><small>Wallet disponible</small></span><b>— <small>FCFA</small></b></div></div>
          <div className="exchange-showcase"><div><span className="exchange-label">échange</span><strong>Disponible après activation</strong></div><span className="exchange-action">Bientôt <ChevronRight size={14} /></span></div>
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
  { href: '/app/payment-links', label: 'Liens de paiement', icon: Link2, image: 'payment-links.png' },
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
  const positive = transactionIsIncoming(transaction);
  return <div className="activity-row" data-testid={`row-transaction-${transaction.id}`}><div className="activity-main"><div className="activity-icon">{transactionImage ? <img className="activity-image" src={dashboardIcon(transactionImage)} alt="" /> : <Icon size={15} />}</div><div><div className="activity-name">{counterpartyLabel(transaction.counterparty)}</div><div className="activity-meta">{movementLabel(transaction.type)} · {dateLabel(transaction.createdAt)}</div></div></div><div style={{ textAlign: 'right' }}><div className={`amount ${positive ? 'positive' : 'negative'}`}>{positive ? '+' : '-'}{new Intl.NumberFormat('fr-FR').format(transaction.amount)} {transaction.currency}</div><div style={{ marginTop: 5 }}><span className={`pill ${transaction.status === 'Completed' ? 'pill-success' : 'pill-pending'}`}>{statusLabel(transaction.status)}</span></div></div></div>;
}

function Wallets() {
  const { wallets, transactions } = useStore();
  const number = new Intl.NumberFormat('fr-FR');
  return <main className="page-wrap"><PageIntro eyebrow="Votre argent, marché par marché" title="Wallets par pays" subtitle="Des soldes locaux séparés, réunis sous un même compte Mulapay." action={<Link href="/app/exchange" className="button button-primary" data-testid="button-wallets-exchange"><ArrowRightLeft size={15} /> Demander un échange</Link>} /><div className="wallet-grid">{wallets.map(wallet => {
    const country = mobileMoneyCountryOptions.find(option => option.code === wallet.code);
    const completedTransactions = transactions.filter(transaction => transaction.country === wallet.country && transaction.status === 'Completed' && transaction.type !== 'Exchange');
    const totalIn = completedTransactions.filter(transactionIsIncoming).reduce((sum, transaction) => sum + transaction.amount, 0);
    const totalOut = completedTransactions.filter(transaction => !transactionIsIncoming(transaction)).reduce((sum, transaction) => sum + transaction.amount, 0);
    return <div className={`card wallet-card ${wallet.status !== 'Active' ? 'coming-soon' : ''}`} key={wallet.code} data-testid={`card-wallet-${wallet.code}`}><div className="wallet-top"><div className="wallet-identity"><img className="wallet-country-flag" src={`${import.meta.env.BASE_URL}countries/${country?.flagSrc ?? `${wallet.code.toLowerCase()}.png`}`} alt={`Drapeau ${wallet.country}`} /><div><div className="wallet-name">{countryLabel(wallet.country)}</div><div className="wallet-currency">Wallet {wallet.currency}</div></div></div><span className={`pill ${wallet.status === 'Active' ? 'pill-success' : 'pill-neutral'}`}>{statusLabel(wallet.status)}</span></div><div className="wallet-total"><span className="wallet-total-label">Montant disponible</span><strong>{number.format(wallet.balance - wallet.pending)} <small>{wallet.currency}</small></strong></div><div className="wallet-stats"><div><div className="wallet-stat-label">Total entrées</div><div className="wallet-stat-value positive">+{number.format(totalIn)} {wallet.currency}</div></div><div><div className="wallet-stat-label">Total retiré</div><div className="wallet-stat-value negative">-{number.format(totalOut)} {wallet.currency}</div></div></div></div>;
  })}</div></main>;
}

function ProviderOperationForm({ kind }: { kind: 'deposit' | 'withdrawal' }) {
  const { wallets, toast, feePercentage } = useStore();
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? '');
  const [country, setCountry] = useState(countryLabel(wallets[0]?.country ?? mobileMoneyCountryOptions[0].country));
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [operator, setOperator] = useState('');
  const [operatorOtp, setOperatorOtp] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isDeposit = kind === 'deposit';
  const selectedCountry = mobileMoneyCountryOptions.find(option => option.country === country) ?? mobileMoneyCountryOptions[0];
  const walletForCountry = (countryName: string) => wallets.find(wallet => wallet.country === countryName || countryLabel(wallet.country) === countryName);
  const selectedWallet = wallets.find(wallet => wallet.id === walletId) ?? walletForCountry(country) ?? wallets[0];
  const availableBalance = selectedWallet ? Math.max(0, selectedWallet.balance - selectedWallet.pending) : 0;
  const operationAmount = Number(amount) || 0;
  const operationFee = calculateFee(operationAmount, feePercentage);
  const operationDebitAmount = operationAmount + operationFee;

  useEffect(() => {
    const nextWallet = walletForCountry(country) ?? wallets[0];
    if (nextWallet && nextWallet.id !== walletId) setWalletId(nextWallet.id);
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
          ...(isDeposit && operatorOtp ? { operatorOtp } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Opération impossible.');
      toast(payload.message ?? 'Opération créée.');
      setPaymentUrl(payload.paymentUrl ?? '');
      setAmount('');
      setPhone('');
      setOperatorOtp('');
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
              {mobileMoneyCountryOptions.map(option => <option key={option.country} value={option.country} disabled={option.code === 'NE'}>{option.country} · {option.dialCode}{option.code === 'NE' ? ' · bientôt disponible' : ''}</option>)}
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
        {selectedCountry.code && ['CI', 'SN', 'BF', 'ML'].includes(selectedCountry.code) && operator === 'Orange Money' && <div className="field">
          <label htmlFor="deposit-operator-otp">Code OTP Orange Money</label>
          <input id="deposit-operator-otp" type="text" inputMode="numeric" value={operatorOtp} onChange={event => setOperatorOtp(event.target.value.replace(/\D/g, ''))} placeholder="Code reçu après le code USSD" required />
          <p className="field-hint">Générez d’abord le code selon les instructions de votre opérateur.</p>
        </div>}
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
      {paymentUrl && <div className="notice" style={{ marginTop: 18 }}><Info size={15} /><span>Votre paiement Wave attend votre confirmation.</span><a className="button button-primary button-sm" href={paymentUrl} target="_blank" rel="noreferrer">Ouvrir Wave <ChevronRight size={14} /></a></div>}
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
            {mobileMoneyCountryOptions.map(option => {
              const wallet = walletForCountry(option.country);
              const balance = wallet ? Math.max(0, wallet.balance - wallet.pending) : 0;
              return <option key={option.country} value={option.country}>{option.country} · Disponible : {money(balance, wallet?.currency ?? 'XOF')}</option>;
            })}
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
      {operationAmount > 0 && <div className="summary-box" style={{ marginBottom: 16 }} data-testid="withdrawal-fee-summary">
        <div className="summary-line"><span>Montant retiré</span><strong>{money(operationAmount, selectedWallet?.currency ?? 'XOF')}</strong></div>
        <div className="summary-line"><span>Frais de retrait ({feePercentage}%)</span><strong>{money(operationFee, selectedWallet?.currency ?? 'XOF')}</strong></div>
        <div className="summary-line"><span>Montant reçu après frais</span><strong>{money(operationAmount, selectedWallet?.currency ?? 'XOF')}</strong></div>
        <div className="summary-line total"><span>Total débité</span><strong>{money(operationDebitAmount, selectedWallet?.currency ?? 'XOF')}</strong></div>
      </div>}
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

function QrPage() {
  const { links } = useStore();
  const link = links.find(item => item.status === 'Active');
  return <main className="page-wrap"><PageIntro eyebrow="Réception rapide" title="QR Code" subtitle="Un QR code ne contient aucun secret. Il pointe vers une page de paiement sécurisée." /><div className="card card-pad qr-wrap">{link ? <><QRCodeSVG value={link.slug} size={220} level="M" includeMargin data-testid="qr-payment-link" /><div className="qr-caption">{link.slug}</div></> : <div className="empty-state"><QrCode size={25} /><strong>Aucun lien actif</strong><p>Créez un lien de paiement pour générer un QR code réel.</p></div>}</div></main>;
}

const Payments = NotFound;

function ApiAccess() {
  const { toast } = useStore();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const loadKeys = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/v1/api-keys', { credentials: 'include' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Impossible de charger les clés API.');
      setKeys(body);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Impossible de charger les clés API.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadKeys(); }, []);

  const createKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Donnez un nom à cette intégration.');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const response = await fetch('/api/v1/api-keys', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'La clé API n’a pas pu être créée.');
      setNewKey(body.key);
      setName('');
      await loadKeys();
      toast('Clé API Mulapay créée. Copiez-la maintenant, elle ne sera plus affichée.');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'La clé API n’a pas pu être créée.');
    } finally {
      setCreating(false);
    }
  };

  const revokeKey = async (id: string) => {
    if (!window.confirm('Supprimer définitivement cette clé API ? Les intégrations qui l’utilisent seront immédiatement bloquées et la clé ne pourra pas être restaurée.')) return;
    const response = await fetch(`/api/v1/api-keys/${id}`, { method: 'DELETE', credentials: 'include' });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'La clé API n’a pas pu être révoquée.');
      return;
    }
    await loadKeys();
    toast('Clé API supprimée définitivement.');
  };

  return <main className="page-wrap">
    <PageIntro eyebrow="Pour les partenaires" title="API partenaire" subtitle="Créez une clé Mulapay et connectez votre backend en quelques minutes." action={<Link href="/app/api-docs" className="button button-ghost"><FileCheck2 size={15} /> Documentation</Link>} />
    {error && <div className="notice notice-error"><CircleAlert size={15} /><span>{error}</span></div>}
    {newKey && <div className="card card-pad api-key-reveal" style={{ marginTop: 18 }}><div className="section-head"><div><div className="section-title">Votre clé est prête</div><p className="section-note" style={{ marginTop: 6 }}>Copiez-la maintenant. Pour votre sécurité, elle ne sera plus affichée après cette page.</p></div><LockKeyhole size={19} /></div><div className="api-key-secret"><code>{newKey}</code><button className="button button-ghost button-sm" onClick={() => { void navigator.clipboard?.writeText(newKey); toast('Clé copiée.'); }}><Copy size={14} /> Copier</button></div><button className="button button-ghost button-sm" style={{ marginTop: 12 }} onClick={() => setNewKey(null)}>J’ai copié la clé</button></div>}
    <div className="card card-pad" style={{ marginTop: 18 }}>
      <div className="section-head"><div><h2 className="section-title">Créer une clé API</h2><p className="section-note">Une clé par application facilite la révocation et le suivi de vos intégrations.</p></div><Plus size={19} /></div>
       <form onSubmit={createKey} className="api-key-create-form" style={{ marginTop: 16 }}><div className="field" style={{ marginBottom: 0 }}><label htmlFor="api-key-name">Nom de l’intégration <span className="required-mark">*</span></label><input id="api-key-name" value={name} onChange={event => setName(event.target.value)} placeholder="Ex. Boutique web" minLength={2} maxLength={80} required /><small className="field-hint">Choisissez un nom reconnaissable, par exemple « Boutique web » ou « Application mobile ».</small></div><button className="button button-primary" type="submit" disabled={creating}>{creating ? 'Création…' : 'Créer une clé API'}</button></form>
    </div>
     <div className="card card-pad api-key-guide" style={{ marginTop: 18 }}>
       <div className="section-head"><div><span className="eyebrow">À savoir avant de commencer</span><h2 className="section-title">Une information suffit</h2><p className="section-note" style={{ marginTop: 8 }}>Cette page crée une clé d’accès Mulapay pour votre serveur. Elle ne demande jamais votre secret DrimPay.</p></div><Info size={19} /></div>
       <div className="api-key-guide-grid">
         <div><span className="api-key-guide-number">01</span><strong>Nom de l’intégration</strong><p>Le seul champ à saisir. Il sert à identifier et révoquer la clé.</p></div>
         <div><span className="api-key-guide-number">02</span><strong>Environnement</strong><p>Les clés créées ici sont des clés de production.</p><span className="pill pill-success">Production</span></div>
         <div><span className="api-key-guide-number">03</span><strong>Permissions</strong><p>Attribuées automatiquement : lecture des wallets, lecture des transactions et création de dépôts.</p></div>
       </div>
       <div className="notice api-key-provider-note"><ShieldCheck size={15} /><span><strong>Clé DrimPay :</strong> elle reste configurée côté serveur Mulapay. Ne la saisissez pas ici et ne la partagez jamais avec un partenaire.</span></div>
       <div className="api-key-payin-note"><span className="eyebrow">Pour chaque dépôt Payin</span><p>Votre backend devra ensuite transmettre la clé Mulapay avec le wallet de réception, le montant, la méthode, la devise, le pays, l’opérateur, le numéro de téléphone, un identifiant de commande et une clé d’idempotence.</p></div>
     </div>
    <div className="card card-pad" style={{ marginTop: 18 }}>
      <div className="section-head"><div><h2 className="section-title">Vos clés API</h2><p className="section-note">Utilisez-les uniquement depuis votre serveur, jamais dans une application cliente.</p></div><span className="pill pill-neutral">{keys.filter(key => !key.revokedAt).length} active(s)</span></div>
      {loading ? <div className="loading-line" style={{ marginTop: 18 }} /> : keys.length === 0 ? <div className="empty-state"><LockKeyhole size={25} /><strong>Aucune clé API</strong><p>Créez votre première clé pour commencer l’intégration.</p></div> : <div className="api-key-list">{keys.map(key => <div className="api-key-row" key={key.id}><div><div className="activity-name">{key.name}</div><div className="activity-meta"><code>{key.keyPrefix}••••••••</code> · créée le {new Date(key.createdAt).toLocaleDateString('fr-FR')}{key.lastUsedAt ? ` · utilisée le ${new Date(key.lastUsedAt).toLocaleDateString('fr-FR')}` : ''}</div></div><button className="button button-danger button-sm" onClick={() => void revokeKey(key.id)}>Supprimer définitivement</button></div>)}</div>}
    </div>
  </main>;
}

function ApiAccessLegacy() {
  return <main className="page-wrap"><PageIntro eyebrow="Pour les partenaires" title="API partenaire" subtitle="Créez une clé Mulapay et connectez votre backend en quelques minutes." action={<Link href="/app/api-docs" className="button button-primary"><FileCheck2 size={15} /> Lire la documentation</Link>} /><div className="notice"><ShieldCheck size={15} /><span>Les clés sont affichées une seule fois et doivent rester dans votre serveur. Révoquez immédiatement une clé compromise.</span></div><div className="card card-pad" style={{ marginTop: 18 }}><div className="section-head"><div><div className="section-title">Accès API Mulapay</div><p className="section-note" style={{ marginTop: 8 }}>Créez une clé distincte pour chaque application ou environnement.</p></div><LockKeyhole size={19} /></div><div className="summary-box" style={{ marginTop: 18 }}><div className="summary-line"><span>Base URL</span><strong>/api/v1</strong></div><div className="summary-line"><span>Authentification</span><strong>Bearer API key</strong></div><div className="summary-line"><span>Opérations</span><strong>Dépôts et statuts</strong></div></div></div></main>;
}

function ApiPayinDocsLegacy() {
  return <main className="page-wrap"><PageIntro eyebrow="Documentation partenaire" title="Documentation API Payin" subtitle="Encaissez du Mobile Money sans redirection : Mulapay transmet la demande à DrimPay et crédite le wallet local après webhook signé." action={<Link href="/app/api" className="button button-primary"><Settings2 size={15} /> Gérer l’accès API</Link>} /><div className="api-docs-grid"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Démarrer un Payin</h2><p className="section-note">Initialisez une collecte sur le wallet correspondant au pays du client.</p></div><img className="api-docs-icon" src={dashboardIcon('documents.png')} alt="" /></div><div className="api-endpoint"><span className="api-method">POST</span><code>/api/v1/deposits</code></div><pre className="api-code">{`{\n  "walletId": "wallet_togo",\n  "amount": 10000,\n  "method": "mobile_money",\n  "country": "Togo",\n  "operator": "Mixx by Yas",\n  "phone": "+22890000000"\n}`}</pre><p className="section-note" style={{ marginTop: 14 }}>Mulapay transmet ensuite <code>country_code</code>, <code>operator</code>, <code>order_id</code> et <code>webhook_url</code> à DrimPay.</p></div><div className="card card-pad"><h2 className="section-title">Sécurité et confirmation</h2><div className="step-list" style={{ marginTop: 14 }}><div className="step"><div className="step-number">01</div><div><div className="step-title">Clé côté serveur</div><div className="step-copy">La clé DrimPay n’est jamais envoyée au navigateur. Mulapay utilise un secret Replit côté API.</div></div></div><div className="step"><div className="step-number">02</div><div><div className="step-title">Idempotence</div><div className="step-copy">Envoyez une valeur unique dans <code>Idempotency-Key</code>. Une nouvelle tentative ne crée pas de double débit.</div></div></div><div className="step"><div className="step-number">03</div><div><div className="step-title">Webhook HMAC</div><div className="step-copy">Mulapay vérifie <code>X-DrimPay-Signature</code> et refuse les signatures de plus de cinq minutes.</div></div></div></div></div></div><div className="card card-pad api-docs-endpoints"><div className="section-head"><div><h2 className="section-title">Flux et opérateurs</h2><p className="section-note">Le statut passe par En attente, En traitement, Effectué, Échoué, Expiré ou Remboursé.</p></div><Link href="/app/transactions" className="button button-ghost button-sm">Voir l’historique</Link></div><div className="api-endpoint-list"><div><span className="api-method">POST</span><code>/api/v1/deposits</code><span>Créer un Payin DrimPay</span></div><div><span className="api-method api-method-muted">POST</span><code>/api/v1/webhooks/drimpay</code><span>Recevoir les statuts signés</span></div><div><span className="api-method api-method-muted">POST</span><code>/api/v1/withdrawals</code><span>Non couvert par l’API Payin actuelle</span></div></div><div className="notice" style={{ marginTop: 18 }}><Info size={15} /><span>Wave renvoie un <code>payment_url</code>. Orange Money peut demander un <code>operatorOtp</code> en Côte d’Ivoire, au Sénégal, au Burkina Faso et au Mali.</span></div></div></main>;
}

function ApiPayinDocsLegacy2() {
  return <main className="page-wrap">
    <PageIntro eyebrow="Documentation partenaire" title="Documentation API Payin" subtitle="Guide complet pour encaisser du Mobile Money en production avec Mulapay." action={<Link href="/app/api" className="button button-primary"><Settings2 size={15} /> Gérer l’accès API</Link>} />
    <div className="notice"><ShieldCheck size={15} /><span>Votre clé Mulapay reste côté serveur. Le navigateur de votre client ne doit jamais la recevoir.</span></div>

    <div className="card card-pad" style={{ marginTop: 18 }}>
      <div className="section-head"><div><h2 className="section-title">1. Vue d’ensemble</h2><p className="section-note">Un Payin est une demande d’encaissement qui crédite le wallet local uniquement après confirmation fournisseur.</p></div><img className="api-docs-icon" src={dashboardIcon('documents.png')} alt="" /></div>
      <div className="feature-grid" style={{ marginTop: 18, gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div><div className="eyebrow">Créer</div><p className="section-note" style={{ marginTop: 8 }}>Votre backend appelle <code>POST /api/v1/deposits</code> avec le pays, l’opérateur, le téléphone et le montant.</p></div>
        <div><div className="eyebrow">Confirmer</div><p className="section-note" style={{ marginTop: 8 }}>Mulapay suit les changements d’état et sécurise la confirmation de chaque opération.</p></div>
        <div><div className="eyebrow">Créditer</div><p className="section-note" style={{ marginTop: 8 }}>Le ledger crédite le wallet du montant net et retire le montant de la file d’attente.</p></div>
      </div>
    </div>

    <div className="api-docs-grid" style={{ marginTop: 18 }}>
      <div className="card card-pad">
        <h2 className="section-title">2. Endpoint Payin</h2>
        <p className="section-note" style={{ marginTop: 8 }}>Base URL : <code>/api</code>. Les appels doivent être effectués depuis votre serveur avec une clé API Mulapay active.</p>
        <div className="api-endpoint" style={{ marginTop: 16 }}><span className="api-method">POST</span><code>/api/v1/deposits</code></div>
        <div className="section-title" style={{ marginTop: 22, fontSize: 12 }}>En-têtes</div>
        <pre className="api-code">{`Content-Type: application/json
Authorization: Bearer mp_live_votre_cle
Idempotency-Key: commande-unique-123`}</pre>
        <div className="section-title" style={{ marginTop: 18, fontSize: 12 }}>Corps de la requête</div>
        <pre className="api-code">{`{
  "walletId": "wallet_togo",
  "amount": 10000,
  "method": "mobile_money",
  "country": "Togo",
  "operator": "Mixx by Yas",
  "phone": "+22890000000",
  "operatorOtp": "123456"
}`}</pre>
      </div>
      <div className="card card-pad">
        <h2 className="section-title">3. Champs acceptés</h2>
        <div className="api-field-list" style={{ marginTop: 14 }}>
          <div><code>walletId</code><span>Identifiant du wallet Mulapay correspondant au pays.</span><strong>requis</strong></div>
          <div><code>amount</code><span>Montant entier strictement positif, dans la devise du wallet.</span><strong>requis</strong></div>
          <div><code>method</code><span>Doit être <code>mobile_money</code>.</span><strong>requis</strong></div>
          <div><code>country</code><span>Togo, Bénin, Côte d’Ivoire, Burkina Faso, Sénégal ou Mali.</span><strong>requis</strong></div>
          <div><code>operator</code><span>Opérateur Mobile Money reconnu pour le pays.</span><strong>requis</strong></div>
          <div><code>phone</code><span>Numéro au format international, par exemple <code>+22890000000</code>.</span><strong>requis</strong></div>
          <div><code>operatorOtp</code><span>Code OTP Orange Money lorsque le pays l’exige.</span><strong>conditionnel</strong></div>
        </div>
      </div>
    </div>

    <div className="card card-pad" style={{ marginTop: 18 }}>
      <div className="section-head"><div><h2 className="section-title">4. Réponse de création</h2><p className="section-note">La réponse accepte la demande, mais ne confirme pas encore le crédit définitif du wallet.</p></div><span className="pill pill-pending">201 Created</span></div>
      <pre className="api-code" style={{ marginTop: 16 }}>{`{
  "ok": true,
  "reference": "DP-XXXXXXXX",
  "status": "pending",
  "paymentUrl": null,
  "expiresAt": "2026-09-05T12:05:00.000Z",
  "fee": 350,
  "netAmount": 9650
}`}</pre>
      <div className="notice" style={{ marginTop: 14 }}><Info size={15} /><span>Pour Wave, <code>paymentUrl</code> contient le lien à ouvrir pour confirmer le paiement. Pour les autres opérateurs, le client confirme généralement sur son téléphone.</span></div>
    </div>

    <div className="api-docs-grid" style={{ marginTop: 18 }}>
      <div className="card card-pad">
        <h2 className="section-title">5. Statuts du Payin</h2>
        <div className="api-status-list" style={{ marginTop: 14 }}>
          <div><span className="pill pill-pending">queued</span><span>Demande reçue par le fournisseur.</span></div>
          <div><span className="pill pill-pending">pending</span><span>Confirmation client attendue.</span></div>
          <div><span className="pill pill-pending">processing</span><span>Traitement Mobile Money en cours.</span></div>
          <div><span className="pill pill-success">success</span><span>Succès : le wallet est crédité du montant net.</span></div>
          <div><span className="pill pill-danger">failed</span><span>Échec : le montant en attente est libéré.</span></div>
          <div><span className="pill pill-danger">expired / cancelled</span><span>Demande terminée sans crédit.</span></div>
          <div><span className="pill pill-danger">reversed</span><span>Remboursement : le montant net précédemment crédité est débité.</span></div>
        </div>
      </div>
      <div className="card card-pad">
        <h2 className="section-title">6. Idempotence</h2>
        <p className="section-note" style={{ marginTop: 8 }}>Envoyez la même valeur <code>Idempotency-Key</code> lors d’une nouvelle tentative réseau. Mulapay l’utilise pour éviter les doubles opérations et renvoie la transaction existante.</p>
        <pre className="api-code" style={{ marginTop: 16 }}>{`Idempotency-Key: checkout-20260905-0001`}</pre>
        <p className="section-note" style={{ marginTop: 12 }}>Ne réutilisez jamais cette clé pour une nouvelle commande ou un autre montant.</p>
      </div>
    </div>

    <div className="card card-pad" style={{ marginTop: 18 }}>
      <div className="section-head"><div><h2 className="section-title">7. Confirmation sécurisée</h2><p className="section-note">Mulapay confirme les opérations côté serveur. Votre application suit le statut avec la référence retournée par l’API.</p></div><LockKeyhole size={19} /></div>
      <div className="api-endpoint" style={{ marginTop: 16 }}><span className="api-method api-method-muted">GET</span><code>/api/v1/deposits/:reference</code></div>
      <div className="api-docs-grid" style={{ marginTop: 16 }}>
        <div><div className="step"><div className="step-number">01</div><div><div className="step-title">Conserver la référence</div><div className="step-copy">Enregistrez la référence retournée par <code>POST /api/v1/deposits</code>.</div></div></div><div className="step"><div className="step-number">02</div><div><div className="step-title">Consulter le statut</div><div className="step-copy">Appelez <code>GET /api/v1/deposits/:reference</code> depuis votre serveur.</div></div></div></div>
        <div><div className="step"><div className="step-number">03</div><div><div className="step-title">Attendre la confirmation</div><div className="step-copy">Ne créditez pas votre propre système avant le statut <code>Completed</code>.</div></div></div><div className="step"><div className="step-number">04</div><div><div className="step-title">Éviter les doubles opérations</div><div className="step-copy">Réutilisez la même <code>Idempotency-Key</code> en cas de nouvelle tentative.</div></div></div></div>
      </div>
      <pre className="api-code" style={{ marginTop: 16 }}>{`{
  "reference": "DP-XXXXXXXX",
  "order_id": "checkout-20260905-0001",
  "status": "success",
  "amount": 10000,
  "fee": 350,
  "net_amount": 9650,
  "currency": "XOF",
  "country_code": "TG",
  "operator": "tmoney"
}`}</pre>
    </div>

    <div className="card card-pad" style={{ marginTop: 18 }}>
      <h2 className="section-title">8. Pays et opérateurs</h2>
        <p className="section-note" style={{ marginTop: 8 }}>Les dépôts Payin disponibles dans Mulapay couvrent les pays et opérateurs activés sur votre compte.</p>
      <div className="api-endpoint-list" style={{ marginTop: 16 }}>
        <div><strong>Togo</strong><span>Mixx by Yas · Moov Money</span></div>
        <div><strong>Bénin</strong><span>MTN MoMo · Moov Money</span></div>
        <div><strong>Côte d’Ivoire</strong><span>Orange Money · MTN MoMo · Wave · Moov Money</span></div>
        <div><strong>Burkina Faso</strong><span>Orange Money · Moov Money · Telecel</span></div>
        <div><strong>Sénégal</strong><span>Orange Money · Wave · Wizall</span></div>
        <div><strong>Mali</strong><span>Orange Money · Moov Money · MTN MoMo</span></div>
      </div>
      <p className="section-note" style={{ marginTop: 14 }}>La disponibilité d’un pays ou d’un opérateur peut dépendre de l’activation de votre compte.</p>
    </div>

    <div className="card card-pad" style={{ marginTop: 18 }}>
      <h2 className="section-title">9. Erreurs et limites actuelles</h2>
      <div className="api-status-list" style={{ marginTop: 14 }}>
        <div><span className="pill pill-danger">400</span><span>Paramètre invalide, wallet/pays incohérent, numéro incorrect ou OTP manquant.</span></div>
        <div><span className="pill pill-danger">401</span><span>Session Clerk absente ou signature webhook invalide/expirée.</span></div>
        <div><span className="pill pill-danger">404</span><span>Référence ou transaction webhook introuvable.</span></div>
        <div><span className="pill pill-danger">501</span><span>Les retraits ne sont pas encore couverts par l’API Payin.</span></div>
        <div><span className="pill pill-danger">503</span><span>Service de paiement temporairement indisponible ou configuration du compte incomplète.</span></div>
      </div>
      <div className="notice" style={{ marginTop: 18 }}><Info size={15} /><span>Ne créditez jamais votre propre base après la réponse de création. Attendez le webhook <code>success</code> et utilisez la référence Mulapay pour rapprocher l’opération.</span></div>
    </div>

    <div className="card card-pad api-docs-endpoints" style={{ marginTop: 18 }}>
      <div className="section-head"><div><h2 className="section-title">10. Ressources API</h2><p className="section-note">Endpoints actuellement exposés par Mulapay.</p></div><Link href="/app/transactions" className="button button-ghost button-sm">Voir l’historique</Link></div>
      <div className="api-endpoint-list"><div><span className="api-method">POST</span><code>/api/v1/deposits</code><span>Créer un dépôt Mobile Money</span></div><div><span className="api-method api-method-muted">GET</span><code>/api/v1/deposits/:reference</code><span>Consulter le statut d’un dépôt</span></div><div><span className="api-method api-method-muted">GET</span><code>/api/v1/bootstrap</code><span>Lire les wallets et transactions du compte</span></div><div><span className="api-method api-method-muted">POST</span><code>/api/v1/withdrawals</code><span>Réservé : non couvert par le Payin actuel</span></div></div>
    </div>
  </main>;
}

function ApiPayinDocsCompact() {
  return <main className="page-wrap">
    <PageIntro eyebrow="Documentation partenaire" title="Documentation API Payin" subtitle="Encaissez du Mobile Money avec l’API Mulapay et suivez chaque opération par sa référence." action={<Link href="/app/api" className="button button-primary"><Settings2 size={15} /> Gérer mes clés</Link>} />
    <div className="api-docs-grid">
      <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Créer un dépôt</h2><p className="section-note">Utilisez une clé API Mulapay créée depuis votre espace partenaire.</p></div><img className="api-docs-icon" src={dashboardIcon('documents.png')} alt="" /></div><div className="api-endpoint" style={{ marginTop: 16 }}><span className="api-method">POST</span><code>/api/v1/deposits</code></div><pre className="api-code">{`Authorization: Bearer mp_live_votre_cle
Content-Type: application/json
Idempotency-Key: commande-unique-123

{
  "walletId": "wallet_togo",
  "amount": 10000,
  "method": "mobile_money",
  "country": "Togo",
  "operator": "Mixx by Yas",
  "phone": "+22890000000"
}`}</pre><p className="section-note" style={{ marginTop: 14 }}>La réponse contient une <code>reference</code>, un <code>status</code>, les frais et le montant net éventuel.</p></div>
      <div className="card card-pad"><h2 className="section-title">Règles essentielles</h2><div className="step-list" style={{ marginTop: 14 }}><div className="step"><div className="step-number">01</div><div><div className="step-title">Clé serveur</div><div className="step-copy">Conservez la clé uniquement dans votre backend. Ne l’utilisez jamais dans le navigateur ou une application distribuée.</div></div></div><div className="step"><div className="step-number">02</div><div><div className="step-title">Idempotence</div><div className="step-copy">Réutilisez la même valeur <code>Idempotency-Key</code> si votre requête doit être rejouée.</div></div></div><div className="step"><div className="step-number">03</div><div><div className="step-title">Suivi</div><div className="step-copy">Consultez <code>GET /api/v1/deposits/:reference</code> jusqu’à la confirmation.</div></div></div></div></div>
    </div>
    <div className="card card-pad api-docs-endpoints" style={{ marginTop: 18 }}><div className="section-head"><div><h2 className="section-title">Endpoints Mulapay</h2><p className="section-note">Toutes les routes publiques utilisent votre clé API dans l’en-tête Authorization.</p></div><Link href="/app/transactions" className="button button-ghost button-sm">Voir l’historique</Link></div><div className="api-endpoint-list"><div><span className="api-method">POST</span><code>/api/v1/deposits</code><span>Créer un dépôt Mobile Money</span></div><div><span className="api-method api-method-muted">GET</span><code>/api/v1/deposits/:reference</code><span>Consulter le statut d’un dépôt</span></div><div><span className="api-method api-method-muted">GET</span><code>/api/v1/bootstrap</code><span>Lire wallets et transactions</span></div><div><span className="api-method api-method-muted">POST</span><code>/api/v1/withdrawals</code><span>Non disponible actuellement</span></div></div><div className="notice" style={{ marginTop: 18 }}><Info size={15} /><span>Les statuts possibles sont En attente, En traitement, Effectué, Échoué, Expiré, Annulé ou Remboursé.</span></div></div>
  </main>;
}

function ApiPayinDocs() {
  const sections = [
    ['overview', 'Vue d’ensemble'],
    ['authentication', 'Authentification'],
    ['quickstart', 'Démarrage rapide'],
    ['create-deposit', 'Créer un dépôt'],
    ['track-deposit', 'Suivre un dépôt'],
    ['statuses', 'Statuts & erreurs'],
    ['coverage', 'Pays & opérateurs'],
  ];
  const fields = [
    ['walletId', 'Identifiant du wallet Mulapay du pays concerné.', 'Requis'],
    ['amount', 'Montant entier strictement positif dans la devise du wallet.', 'Requis'],
    ['method', 'Valeur attendue : mobile_money.', 'Requis'],
    ['country', 'Pays du wallet : Togo, Bénin, Côte d’Ivoire, Burkina Faso, Sénégal ou Mali.', 'Requis'],
    ['operator', 'Opérateur Mobile Money disponible pour le pays sélectionné.', 'Requis'],
    ['phone', 'Numéro au format international, par exemple +22890000000.', 'Requis'],
    ['operatorOtp', 'Code OTP si l’opérateur ou le pays le demande.', 'Conditionnel'],
  ];
  const statuses = [
    ['pending', 'En attente', 'La confirmation du client est attendue.'],
    ['processing', 'En traitement', 'La demande est en cours de traitement.'],
    ['success', 'Effectué', 'Le wallet est crédité du montant net.'],
    ['failed', 'Échoué', 'La demande est terminée sans crédit.'],
    ['expired', 'Expiré', 'La demande a dépassé sa durée de validité.'],
    ['cancelled', 'Annulé', 'La demande a été annulée sans crédit.'],
    ['reversed', 'Remboursé', 'Un crédit précédemment effectué a été compensé.'],
  ];
  return <main className="page-wrap docs-page">
    <div className="docs-layout">
      <aside className="docs-sidebar">
        <div className="docs-sidebar-brand"><img src={dashboardIcon('documents.png')} alt="" /><div><strong>Mulapay API</strong><span>Documentation v1</span></div></div>
        <div className="docs-sidebar-label">Dans cette page</div>
        <nav className="docs-nav">{sections.map(([id, label], index) => <a key={id} href={`#${id}`} className={index === 0 ? 'active' : ''}><span>{String(index + 1).padStart(2, '0')}</span>{label}</a>)}</nav>
        <div className="docs-sidebar-footer"><span className="docs-production-dot" /> Production uniquement</div>
      </aside>
      <div className="docs-content">
        <div className="docs-topline"><span className="eyebrow">Documentation partenaire</span><div className="docs-topline-actions"><span className="pill pill-success">Production</span><button className="button button-ghost button-sm docs-print-button" onClick={() => window.print()} data-testid="button-export-docs-pdf"><Download size={14} /> Exporter en PDF</button><Link href="/app/api" className="button button-ghost button-sm"><Settings2 size={14} /> Gérer mes clés</Link></div></div>
        <header className="docs-header">
          <div><h1 className="page-title">Documentation API Payin</h1><p className="page-subtitle">Tout ce qu’il faut pour accepter des paiements Mobile Money avec Mulapay : créer une demande, suivre son statut et rapprocher le résultat dans votre système.</p></div>
          <div className="docs-version">API <strong>v1</strong><span>•</span> Dernière version</div>
        </header>

        <section id="overview" className="docs-hero card">
          <div className="docs-hero-copy"><span className="docs-kicker">Commencer en quelques minutes</span><h2>Une intégration claire, de la demande à la confirmation.</h2><p>Votre serveur crée un dépôt avec une clé Mulapay. La réponse fournit une référence unique, puis votre application suit l’opération jusqu’à son statut final.</p><div className="docs-hero-actions"><a href="#quickstart" className="button button-primary">Démarrer l’intégration <ArrowRight size={15} /></a><a href="#create-deposit" className="button button-ghost">Voir l’exemple</a></div></div>
          <div className="docs-hero-visual"><div className="docs-hero-orbit" /><img src={dashboardIcon('documents.png')} alt="" className="docs-hero-illustration" /><div className="docs-hero-status"><span className="docs-production-dot" /> API opérationnelle</div></div>
        </section>

        <section className="docs-steps card">
          <div className="docs-section-heading"><div><span className="docs-kicker">Le flux</span><h2>Un parcours prévisible</h2></div><span className="docs-muted-label">3 étapes</span></div>
          <div className="docs-step-grid"><div className="docs-step-card"><span className="docs-step-number">01</span><div><strong>Créer</strong><p>Envoyez le montant, le wallet, le pays, l’opérateur et le numéro du client.</p></div></div><div className="docs-step-card"><span className="docs-step-number">02</span><div><strong>Confirmer</strong><p>Présentez le lien de paiement ou demandez au client de confirmer sur son téléphone.</p></div></div><div className="docs-step-card"><span className="docs-step-number">03</span><div><strong>Rapprocher</strong><p>Conservez la référence et attendez le statut final avant de livrer votre service.</p></div></div></div>
        </section>

        <section id="authentication" className="docs-section">
          <div className="docs-section-heading"><div><span className="docs-kicker">01 · Sécurité</span><h2>Authentification</h2><p>Les appels partenaires sont effectués depuis votre backend avec une clé API active.</p></div><LockKeyhole size={19} /></div>
          <div className="docs-two-column"><div className="card card-pad"><h3>En-têtes obligatoires</h3><pre className="api-code">{`Authorization: Bearer mp_live_votre_cle
Content-Type: application/json
Idempotency-Key: commande-unique-123`}</pre><p className="docs-inline-note"><ShieldCheck size={14} /> Ne placez jamais cette clé dans le navigateur, une application mobile distribuée ou un dépôt public.</p></div><div className="card card-pad docs-callout-card"><span className="docs-callout-icon"><ShieldCheck size={16} /></span><h3>Clés à durée de vie contrôlée</h3><p>Créez une clé distincte par application. Vous pouvez la révoquer depuis l’espace API sans modifier les autres intégrations.</p><Link href="/app/api" className="docs-text-link">Gérer mes clés <ArrowRight size={14} /></Link></div></div>
        </section>

        <section id="quickstart" className="docs-section">
          <div className="docs-section-heading"><div><span className="docs-kicker">02 · Démarrage</span><h2>Démarrage rapide</h2><p>Un premier appel suffit pour initialiser une collecte.</p></div><span className="docs-muted-label">POST</span></div>
          <div className="docs-endpoint-bar"><span className="api-method">POST</span><code>/api/v1/deposits</code><span>Créer un dépôt</span></div>
          <div className="docs-code-grid"><div><div className="docs-code-label">cURL</div><pre className="api-code">{`curl -X POST https://votre-domaine/api/v1/deposits \\
  -H "Authorization: Bearer mp_live_votre_cle" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: commande-unique-123" \\
  -d '{
    "walletId": "wallet_togo",
    "amount": 10000,
    "method": "mobile_money",
    "country": "Togo",
    "operator": "Mixx by Yas",
    "phone": "+22890000000"
  }'`}</pre></div><div><div className="docs-code-label">JavaScript côté serveur</div><pre className="api-code">{`const response = await fetch(
  "https://votre-domaine/api/v1/deposits",
  {
    method: "POST",
    headers: {
      Authorization: "Bearer mp_live_votre_cle",
      "Content-Type": "application/json",
      "Idempotency-Key": "commande-unique-123"
    },
    body: JSON.stringify(payload)
  }
);`}</pre></div></div>
        </section>

        <section id="create-deposit" className="docs-section">
          <div className="docs-section-heading"><div><span className="docs-kicker">03 · Endpoint</span><h2>Créer un dépôt</h2><p>La création accepte la demande et réserve le montant en attente. Elle ne confirme pas encore le crédit définitif.</p></div></div>
          <div className="docs-two-column docs-align-start"><div className="card card-pad"><h3>Corps de la requête</h3><div className="docs-field-list">{fields.map(([name, description, requirement]) => <div key={name}><code>{name}</code><p>{description}</p><span className={requirement === 'Requis' ? 'docs-required' : 'docs-conditional'}>{requirement}</span></div>)}</div></div><div className="card card-pad"><h3>Réponse · 201 Created</h3><pre className="api-code">{`{
  "ok": true,
  "reference": "DP-XXXXXXXX",
  "status": "pending",
  "paymentUrl": null,
  "expiresAt": "2026-09-05T12:05:00.000Z",
  "fee": 350,
  "netAmount": 9650
}`}</pre><p className="docs-inline-note"><Info size={14} /> Si <code>paymentUrl</code> est renseigné, ouvrez-le depuis votre parcours serveur ou transmettez-le à votre interface sécurisée.</p></div></div>
        </section>

        <section id="track-deposit" className="docs-section">
          <div className="docs-section-heading"><div><span className="docs-kicker">04 · Suivi</span><h2>Suivre un dépôt</h2><p>Utilisez la référence retournée à la création pour récupérer l’état le plus récent.</p></div></div>
          <div className="docs-endpoint-bar"><span className="api-method api-method-muted">GET</span><code>/api/v1/deposits/:reference</code><span>Consulter un dépôt</span></div>
          <div className="docs-two-column docs-align-start"><div className="card card-pad"><h3>Réponse de suivi</h3><pre className="api-code">{`{
  "ok": true,
  "reference": "DP-XXXXXXXX",
  "status": "success",
  "amount": 10000,
  "currency": "XOF",
  "fee": 350,
  "netAmount": 9650,
  "paymentUrl": null,
  "expiresAt": null,
  "createdAt": "2026-09-05T11:45:00.000Z"
}`}</pre></div><div className="card card-pad docs-callout-card"><span className="docs-callout-icon"><Activity size={16} /></span><h3>Quand créditer votre service ?</h3><p>Ne livrez jamais votre produit et ne créditez jamais votre propre compte après le seul statut HTTP 201. Attendez <code>success</code> et rapprochez la référence.</p><div className="docs-mini-rule"><span className="docs-production-dot" /> Statut final requis : <strong>success</strong></div></div></div>
        </section>

        <section id="statuses" className="docs-section">
          <div className="docs-section-heading"><div><span className="docs-kicker">05 · Référence</span><h2>Statuts, idempotence & erreurs</h2><p>Les réponses sont conçues pour être rejouées sans créer de double opération.</p></div></div>
          <div className="docs-two-column docs-align-start"><div className="card card-pad"><h3>Statuts métier</h3><div className="docs-status-list">{statuses.map(([value, label, description]) => <div key={value}><span className={`pill ${value === 'success' ? 'pill-success' : value === 'failed' || value === 'expired' || value === 'cancelled' || value === 'reversed' ? 'pill-danger' : 'pill-pending'}`}>{value}</span><div><strong>{label}</strong><p>{description}</p></div></div>)}</div></div><div className="card card-pad"><h3>Idempotence</h3><p className="section-note" style={{ marginTop: 8 }}>Réutilisez la même clé pour une nouvelle tentative réseau de la même commande. Mulapay renvoie la transaction existante.</p><pre className="api-code" style={{ marginTop: 16 }}>{`Idempotency-Key: checkout-20260905-0001`}</pre><p className="section-note" style={{ marginTop: 12 }}>Ne réutilisez jamais cette valeur pour une autre commande, un autre montant ou un autre wallet.</p><div className="docs-error-list"><div><span className="pill pill-danger">400</span><span>Paramètre invalide, wallet incohérent, numéro incorrect ou OTP manquant.</span></div><div><span className="pill pill-danger">401</span><span>Clé absente, invalide ou révoquée.</span></div><div><span className="pill pill-danger">404</span><span>Dépôt ou référence introuvable.</span></div><div><span className="pill pill-danger">503</span><span>Service de paiement temporairement indisponible.</span></div></div></div></div>
        </section>

        <section id="coverage" className="docs-section">
          <div className="docs-section-heading"><div><span className="docs-kicker">06 · Disponibilité</span><h2>Pays & opérateurs</h2><p>La disponibilité effective dépend des pays et opérateurs activés sur votre compte Mulapay.</p></div></div>
          <div className="card card-pad docs-coverage-grid"><div><strong>Togo</strong><span>Mixx by Yas · Moov Money</span></div><div><strong>Bénin</strong><span>MTN MoMo · Moov Money</span></div><div><strong>Côte d’Ivoire</strong><span>Orange Money · MTN MoMo · Wave · Moov Money</span></div><div><strong>Burkina Faso</strong><span>Orange Money · Moov Money · Telecel</span></div><div><strong>Sénégal</strong><span>Orange Money · Wave · Wizall</span></div><div><strong>Mali</strong><span>Orange Money · Moov Money · MTN MoMo</span></div></div>
        </section>

        <section className="docs-resources card">
          <div><span className="docs-kicker">Référence API</span><h2>Endpoints disponibles</h2><p>Les routes publiques actuellement exposées par Mulapay.</p></div>
          <div className="docs-resource-list"><div><span className="api-method">POST</span><code>/api/v1/deposits</code><span>Créer un dépôt Mobile Money</span></div><div><span className="api-method api-method-muted">GET</span><code>/api/v1/deposits/:reference</code><span>Consulter le statut d’un dépôt</span></div><div><span className="api-method api-method-muted">GET</span><code>/api/v1/bootstrap</code><span>Lire les wallets et transactions du compte</span></div><div><span className="api-method api-method-muted">POST</span><code>/api/v1/withdrawals</code><span>Non disponible actuellement</span></div></div>
          <div className="docs-bottom-cta"><div><strong>Prêt à connecter votre backend ?</strong><span>Créez une clé serveur et commencez avec le quickstart.</span></div><Link href="/app/api" className="button button-primary">Créer une clé API <ArrowRight size={15} /></Link></div>
        </section>
      </div>
    </div>
  </main>;
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
  const filtered = transactions.filter(t => (filter === 'All' || t.type === filter) && `${t.counterparty} ${t.reference} ${t.country}`.toLowerCase().includes(query.toLowerCase()));
  const filterOptions = [['All', 'Toutes'], ['Received', 'Reçues'], ['Sent', 'Envoyées'], ['Exchange', 'Échanges'], ['Deposit', 'Dépôts'], ['Withdrawal', 'Retraits'], ['Payment', 'Paiements']];
  return <main className="page-wrap"><PageIntro eyebrow="Une trace claire" title="Transactions" subtitle="Consultez uniquement les mouvements confirmés ou en cours issus des services réels." action={<button className="button button-ghost" onClick={() => toast('L’export sera disponible après activation des permissions de téléchargement.')} data-testid="button-export-transactions"><Download size={15} /> Exporter en CSV</button>} /><div className="card table-card"><div className="table-toolbar"><div><div className="filter-set">{filterOptions.map(([value, label]) => <button key={value} onClick={() => setFilter(value)} className={`filter-button ${filter === value ? 'active' : ''}`} data-testid={`button-filter-${value.toLowerCase()}`}>{label}</button>)}</div></div><div className="input-prefix" style={{ width: 190 }}><Search size={14} style={{ position: 'absolute', left: 12, top: 11, color: 'hsl(203 18% 46%)' }} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Rechercher une référence" style={{ width: '100%', border: '1px solid hsl(38 28% 85%)', background: 'hsl(42 44% 99%)', borderRadius: 9, padding: '9px 10px 9px 32px', fontSize: 11, outline: 0 }} data-testid="input-search-transactions" /></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Mouvement</th><th>Wallet</th><th>Référence</th><th>Date</th><th style={{ textAlign: 'right' }}>Montant</th><th>Statut</th></tr></thead><tbody>{filtered.map(t => { const operator = transactionOperator(t.counterparty); const operatorLogo = operatorLogoUrl(operator); const positive = transactionIsIncoming(t); return <tr key={t.id} data-testid={`row-table-transaction-${t.id}`}><td><div className="transaction-party"><span className="transaction-logo"><img src={operatorLogo ?? transactionServiceLogo(t.counterparty)} alt={operator ?? ''} /></span><span><div className="transaction-party-name">{counterpartyLabel(t.counterparty)}</div><div className="activity-meta">{movementLabel(t.type)}{operator && <span className="transaction-operator">{operator}</span>}</div></span></div></td><td><div className="transaction-wallet"><img className="transaction-country-logo" src={countryFlagUrl(t.country)} alt={`Drapeau ${t.country}`} /><span>{countryLabel(t.country)}<small>{t.currency}</small></span></div></td><td><div className="transaction-reference"><code>{t.reference}</code></div></td><td>{transactionDateLabel(t.createdAt)}</td><td className={`transaction-amount ${positive ? 'positive' : 'negative'}`}>{positive ? '+' : '-'}{new Intl.NumberFormat('fr-FR').format(t.amount)} {t.currency}</td><td><span className={`pill ${t.status === 'Completed' ? 'pill-success' : 'pill-pending'}`}>{statusLabel(t.status)}</span></td></tr>; })}</tbody></table>{filtered.length === 0 && <div className="empty-state"><ListFilter size={25} /><strong>Aucun mouvement réel</strong><p>Les transactions apparaîtront ici après confirmation du service de paiement.</p></div>}</div></div></main>;
}

function Transfer() {
  const { wallets, transfer, feePercentage } = useStore();
  const [amount, setAmount] = useState('');
  const [country, setCountry] = useState(wallets[0]?.country ?? mobileMoneyCountryOptions[0].country);
  const [operator, setOperator] = useState('');
  const [phone, setPhone] = useState('');
  const [feePayer, setFeePayer] = useState<'sender' | 'recipient'>('sender');
  const walletForCountry = (countryName: string) => wallets.find(wallet => wallet.country === countryName || countryLabel(wallet.country) === countryName);
  const selectedCountry = mobileMoneyCountryOptions.find(option => option.country === country) ?? mobileMoneyCountryOptions[0];
  const selectedWallet = walletForCountry(country);
  const availableBalance = selectedWallet ? Math.max(0, selectedWallet.balance - selectedWallet.pending) : 0;
  const transferAmount = Number(amount) || 0;
  const transferFee = calculateFee(transferAmount, feePercentage);
  const recipientAmount = feePayer === 'recipient' ? Math.max(0, transferAmount - transferFee) : transferAmount;
  const debitAmount = feePayer === 'sender' ? transferAmount + transferFee : transferAmount;
  const canSubmit = transferAmount > 0 && phone.length > 0 && Boolean(selectedWallet) && operator.length > 0 && (feePayer === 'sender' || transferAmount > transferFee);
  useEffect(() => {
    const nextOperator = selectedCountry.operators[0]?.name ?? '';
    if (operator !== nextOperator && !selectedCountry.operators.some(item => item.name === operator)) setOperator(nextOperator);
  }, [operator, selectedCountry]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!amount || !phone || !selectedWallet || !operator) return;
    const recipientPhone = `${selectedCountry.dialCode}${phone.replace(/\D/g, '')}`;
    transfer({ amount: transferAmount, currency: selectedWallet.currency, country: selectedWallet.country, counterparty: `${recipientPhone} · ${operator}`, note: `Frais à la charge de ${feePayer === 'sender' ? 'moi' : 'du destinataire'}`, feePayer });
    setAmount('');
    setPhone('');
  };
  return <main className="page-wrap deposit-page">
    <PageIntro eyebrow="Mobile Money" title="Envoyer de l’argent" />
    <form className="card card-pad deposit-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="transfer-country">Pays</label>
        <div className="country-select">
          <img src={`${import.meta.env.BASE_URL}countries/${selectedCountry.flagSrc}`} alt="" />
          <select id="transfer-country" value={country} onChange={event => setCountry(event.target.value)} required data-testid="select-transfer-wallet">
            {mobileMoneyCountryOptions.map(option => {
              const wallet = walletForCountry(option.country);
              const balance = wallet ? Math.max(0, wallet.balance - wallet.pending) : 0;
              return <option key={option.country} value={option.country}>{option.country} · Disponible : {money(balance, wallet?.currency ?? 'XOF')}</option>;
            })}
          </select>
          <ChevronDown className="country-select-chevron" size={16} aria-hidden="true" />
        </div>
        <div className="wallet-availability"><WalletCards size={14} /><span>Disponible sur le wallet {countryLabel(selectedWallet?.country ?? country)}</span><strong>{money(availableBalance, selectedWallet?.currency ?? 'XOF')}</strong></div>
      </div>
      <div className="field">
        <label>Opérateur Mobile Money</label>
        <div className="mobile-money-options" role="radiogroup" aria-label="Choisir un opérateur Mobile Money">
          {selectedCountry.operators.map(option => <label className={`mobile-money-option ${operator === option.name ? 'selected' : ''}`} key={option.name}>
            <input type="radio" name="transfer-operator" value={option.name} checked={operator === option.name} onChange={event => setOperator(event.target.value)} required />
            <img src={`${import.meta.env.BASE_URL}mobile-money/${option.src}`} alt="" />
            <span>{option.name}</span>
          </label>)}
        </div>
      </div>
      <div className="field">
        <label htmlFor="transfer-phone">Numéro de téléphone</label>
        <div className="phone-input">
          <span className="phone-prefix" aria-label={`Indicatif ${selectedCountry.dialCode}`}>{selectedCountry.dialCode}</span>
          <input id="transfer-phone" type="tel" inputMode="numeric" value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, ''))} placeholder="90 00 00 00" autoComplete="tel-national" data-testid="input-transfer-recipient" required />
        </div>
      </div>
      <div className="field">
        <label htmlFor="transfer-amount">Montant</label>
        <div className="input-prefix">
          <span>XOF</span>
          <input id="transfer-amount" type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" data-testid="input-transfer-amount" required />
        </div>
      </div>
      {transferAmount > 0 && <div className="summary-box" style={{ marginBottom: 16 }} data-testid="transfer-fee-summary">
        <div className="summary-line"><span>Montant saisi</span><strong>{money(transferAmount, selectedWallet?.currency ?? 'XOF')}</strong></div>
        <div className="summary-line"><span>Frais de transfert ({feePercentage}%)</span><strong>{money(transferFee, selectedWallet?.currency ?? 'XOF')}</strong></div>
        <div className="summary-line"><span>Montant reçu après frais</span><strong>{money(recipientAmount, selectedWallet?.currency ?? 'XOF')}</strong></div>
        <div className="summary-line total"><span>Total débité</span><strong>{money(debitAmount, selectedWallet?.currency ?? 'XOF')}</strong></div>
      </div>}
      <div className="field">
        <label>Prise en charge des frais</label>
        <div className="fee-options" role="radiogroup" aria-label="Choisir qui prend les frais">
          <label className={`fee-option ${feePayer === 'sender' ? 'selected' : ''}`}>
            <input type="radio" name="transfer-fee-payer" value="sender" checked={feePayer === 'sender'} onChange={() => setFeePayer('sender')} />
            <span><strong>Je prends les frais</strong><small>Le destinataire reçoit le montant demandé.</small></span>
            {feePayer === 'sender' && <CheckCircle2 size={16} />}
          </label>
          <label className={`fee-option ${feePayer === 'recipient' ? 'selected' : ''}`}>
            <input type="radio" name="transfer-fee-payer" value="recipient" checked={feePayer === 'recipient'} onChange={() => setFeePayer('recipient')} />
            <span><strong>À la charge du destinataire</strong><small>Les frais seront déduits du montant reçu.</small></span>
            {feePayer === 'recipient' && <CheckCircle2 size={16} />}
          </label>
        </div>
      </div>
      <button className="button button-primary button-wide" type="submit" disabled={!canSubmit} data-testid="button-submit-transfer"><Send size={15} /> Envoyer maintenant</button>
    </form>
  </main>;
}

function Exchange() {
  const { wallets, exchanges, exchange, feePercentage } = useStore();
  const active = wallets.filter(wallet => wallet.status === 'Active');
  const [source, setSource] = useState('Togo');
  const [destination, setDestination] = useState('Benin');
  const [amount, setAmount] = useState('');
  const sourceWallet = active.find(wallet => wallet.country === source);
  const destinationWallet = active.find(wallet => wallet.country === destination);
  const exchangeAmount = Number(amount) || 0;
  const exchangeFee = calculateFee(exchangeAmount, feePercentage);
  const receivedAmount = Math.max(0, exchangeAmount - exchangeFee);

  useEffect(() => {
    if (!active.some(wallet => wallet.country === source) && active[0]) setSource(active[0].country);
    if (!active.some(wallet => wallet.country === destination) && active[1]) setDestination(active[1].country);
  }, [active, destination, source]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!exchangeAmount || source === destination || !sourceWallet || !destinationWallet) return;
    exchange({ source, destination, amount: exchangeAmount });
    setAmount('');
  };

  return <main className="page-wrap exchange-page">
    <PageIntro eyebrow="Liquidité multi-pays" title="Échange entre wallets" subtitle="Déplacez vos fonds d’un pays à l’autre depuis un seul espace. Le taux de frais appliqué est celui défini par votre administrateur." />
    <div className="exchange-layout">
      <form className="card card-pad exchange-card" onSubmit={submit}>
        <div className="exchange-card-head">
          <div><span className="eyebrow">Nouveau mouvement</span><h2 className="section-title">Choisissez votre parcours</h2></div>
          <div className="exchange-card-icon"><ArrowRightLeft size={18} /></div>
        </div>
        <div className="exchange-route">
          <div className="exchange-wallet-field">
            <div className="exchange-field-label"><span>Depuis</span><small>Wallet source</small></div>
            <div className="exchange-select-wrap">
              <img className="exchange-country-flag" src={countryFlagUrl(source)} alt={`Drapeau ${countryLabel(source)}`} />
              <select id="exchange-source" value={source} onChange={event => setSource(event.target.value)} data-testid="select-exchange-source">
                {active.map(wallet => <option key={wallet.code} value={wallet.country}>{countryLabel(wallet.country)} · {wallet.currency}</option>)}
              </select>
              <ChevronDown size={15} />
            </div>
            <div className="exchange-balance">Disponible <strong>{money(sourceWallet?.balance ?? 0, sourceWallet?.currency ?? 'XOF')}</strong></div>
          </div>
          <div className="exchange-route-divider"><span><ArrowDown size={16} /></span></div>
          <div className="exchange-wallet-field">
            <div className="exchange-field-label"><span>Vers</span><small>Wallet destination</small></div>
            <div className="exchange-select-wrap">
              <img className="exchange-country-flag destination" src={countryFlagUrl(destination)} alt={`Drapeau ${countryLabel(destination)}`} />
              <select id="exchange-destination" value={destination} onChange={event => setDestination(event.target.value)} data-testid="select-exchange-destination">
                {active.map(wallet => <option key={wallet.code} value={wallet.country}>{countryLabel(wallet.country)} · {wallet.currency}</option>)}
              </select>
              <ChevronDown size={15} />
            </div>
            <div className="exchange-balance">Après échange <strong>{money(receivedAmount, destinationWallet?.currency ?? 'XOF')}</strong></div>
          </div>
        </div>
        <div className="exchange-amount-field">
          <div className="exchange-field-label"><span>Montant à échanger</span><small>Le montant sera débité du wallet source</small></div>
          <div className="exchange-amount-input"><input id="exchange-amount" type="number" min="1" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0" data-testid="input-exchange-amount" /><span>{sourceWallet?.currency ?? 'XOF'}</span></div>
        </div>
        <div className="exchange-summary" data-testid="exchange-fee-summary">
          <div className="exchange-summary-head"><span>Récapitulatif</span><span className="exchange-rate">Taux 1,0000</span></div>
          <div className="exchange-summary-row"><span>Montant débité</span><strong>{exchangeAmount ? money(exchangeAmount, sourceWallet?.currency ?? 'XOF') : '—'}</strong></div>
          <div className="exchange-summary-row"><span>Frais de service ({feePercentage}%)</span><strong>{exchangeAmount ? money(exchangeFee, sourceWallet?.currency ?? 'XOF') : '—'}</strong></div>
          <div className="exchange-summary-row exchange-summary-total"><span>Montant reçu après frais</span><strong>{exchangeAmount ? money(receivedAmount, destinationWallet?.currency ?? 'XOF') : '—'}</strong></div>
        </div>
        <button className="button button-primary button-wide" style={{ marginTop: 18 }} type="submit" disabled={!exchangeAmount || source === destination || !sourceWallet || !destinationWallet || exchangeAmount > (sourceWallet?.balance ?? 0)} data-testid="button-submit-exchange"><RefreshCw size={15} /> Demander l’échange</button>
      </form>
      <section className="exchange-history-card">
        <div className="exchange-history-hero"><div><span className="eyebrow">Suivi</span><h2>Vos échanges</h2><p>Les demandes validées apparaissent ici dès leur traitement.</p></div><div className="exchange-history-count">{exchanges.length}<small>demande(s)</small></div></div>
        <div className="exchange-history-list">
          {exchanges.map(ex => <div className="exchange-history-item" key={ex.id} data-testid={`row-exchange-${ex.id}`}>
            <div className="exchange-history-route"><span>{ex.source.split(' · ')[0].slice(0, 2).toUpperCase()}</span><div><strong>{ex.source}</strong><small><ArrowRight size={12} /> {ex.destination}</small></div></div>
            <div className="exchange-history-meta"><strong className="positive">+{money(ex.receivedAmount)}</strong><span>{ex.requestedAt}</span></div>
            <span className={`pill ${ex.status === 'Completed' ? 'pill-success' : ex.status === 'Rejected' ? 'pill-danger' : 'pill-pending'}`}>{statusLabel(ex.status)}</span>
          </div>)}
          {exchanges.length === 0 && <div className="empty-state exchange-empty"><ArrowRightLeft size={24} /><strong>Aucun échange pour le moment</strong><p>Votre historique apparaîtra ici.</p></div>}
        </div>
      </section>
    </div>
  </main>;
}

function PaymentLinks() {
  const { links, wallets, toast } = useStore();
  const createPaymentLink = useCreatePaymentLink();
  const deletePaymentLink = useDeletePaymentLink();
  const updatePaymentLink = useUpdatePaymentLink();
  const [productName, setProductName] = useState('');
  const [description, setDescription] = useState('');
  const [walletId, setWalletId] = useState('all');
  const [amountType, setAmountType] = useState<'FIXED' | 'CUSTOMER_CHOOSES'>('FIXED');
  const [amount, setAmount] = useState('');
  const [validity, setValidity] = useState('30d');
  const [customDate, setCustomDate] = useState('');
  const [paymentLimit, setPaymentLimit] = useState<'unlimited' | 'limited'>('unlimited');
  const [maxPayments, setMaxPayments] = useState('');
  const [afterPaymentAction, setAfterPaymentAction] = useState<'CONFIRMATION' | 'REDIRECT'>('CONFIRMATION');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [notifyApp, setNotifyApp] = useState(true);
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [notifyWebhook, setNotifyWebhook] = useState(false);
  const [createdLink, setCreatedLink] = useState<PaymentLink | null>(null);
  const [editingLink, setEditingLink] = useState<PaymentLink | null>(null);
  const [formError, setFormError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [qrLink, setQrLink] = useState<PaymentLink | null>(null);

  const expiryValue = () => {
    if (validity === 'never') return '';
    if (validity === 'custom') return customDate ? new Date(`${customDate}T23:59:59`).toISOString() : '';
    const hours = validity === '24h' ? 24 : validity === '7d' ? 24 * 7 : 24 * 30;
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  };
  const expiryLabel = (value: string) => {
    if (!value) return 'Sans expiration';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : `Le ${date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  };
  const copyLink = async (link: PaymentLink) => {
    try {
      await navigator.clipboard.writeText(link.slug);
      setCopiedId(link.id);
      window.setTimeout(() => setCopiedId(current => current === link.id ? '' : current), 2200);
    } catch {
      toast('La copie automatique n’est pas disponible sur cet appareil.');
    }
  };
  const shareLink = async (link: PaymentLink) => {
    if (navigator.share) {
      try {
        await navigator.share({ title: link.productName, text: link.description || link.productName, url: link.slug });
        return;
      } catch { /* Le partage peut être annulé sans message d’erreur. */ }
    }
    await copyLink(link);
    toast('Lien copié, prêt à être partagé.');
  };
  const removeLink = (link: PaymentLink) => {
    if (!window.confirm(`Supprimer définitivement le lien « ${link.productName || link.description || 'ce paiement'} » ? Cette action est irréversible.`)) return;
    deletePaymentLink.mutate({ id: link.id }, {
      onSuccess: () => {
        if (createdLink?.id === link.id) setCreatedLink(null);
        if (qrLink?.id === link.id) setQrLink(null);
        if (editingLink?.id === link.id) {
          setEditingLink(null);
          resetForm();
        }
        void queryClient.invalidateQueries({ queryKey: getGetBootstrapQueryKey() });
        toast('Lien de paiement supprimé définitivement.');
      },
      onError: () => toast('Le lien de paiement n’a pas pu être supprimé.'),
    });
  };
  const resetForm = () => {
    setProductName('');
    setDescription('');
    setWalletId('all');
    setAmountType('FIXED');
    setAmount('');
    setValidity('30d');
    setCustomDate('');
    setPaymentLimit('unlimited');
    setMaxPayments('');
    setAfterPaymentAction('CONFIRMATION');
    setRedirectUrl('');
    setNotifyApp(true);
    setNotifyEmail(true);
    setNotifyWebhook(false);
    setFormError('');
  };
  const beginEdit = (link: PaymentLink) => {
    setEditingLink(link);
    setCreatedLink(null);
    setProductName(link.productName ?? '');
    setDescription(link.description ?? '');
    setWalletId(link.walletId ?? 'all');
    setAmountType(link.amountType);
    setAmount(link.amountType === 'FIXED' ? String(link.amount || '') : '');
    if (!link.expiresAt) {
      setValidity('never');
      setCustomDate('');
    } else {
      setValidity('custom');
      setCustomDate(new Date(link.expiresAt).toISOString().slice(0, 10));
    }
    setPaymentLimit(link.maxPayments === null ? 'unlimited' : 'limited');
    setMaxPayments(link.maxPayments === null ? '' : String(link.maxPayments));
    setAfterPaymentAction(link.afterPaymentAction);
    setRedirectUrl(link.redirectUrl ?? '');
    setNotifyApp(link.notifyApp);
    setNotifyEmail(link.notifyEmail);
    setNotifyWebhook(link.notifyWebhook);
    setFormError('');
    window.requestAnimationFrame(() => document.getElementById('link-product-name')?.focus());
  };
  const cancelEdit = () => {
    setEditingLink(null);
    resetForm();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError('');
    const cleanName = productName.trim();
    const cleanDescription = description.trim();
    if (cleanName.length < 2) { setFormError('Indiquez le nom du produit ou du service.'); return; }
    if (amountType === 'FIXED' && (!amount || Number(amount) <= 0)) { setFormError('Indiquez un montant fixe supérieur à zéro.'); return; }
    if (validity === 'custom' && !expiryValue()) { setFormError('Choisissez une date de fin de validité.'); return; }
    if (paymentLimit === 'limited' && (!maxPayments || !Number.isInteger(Number(maxPayments)) || Number(maxPayments) < 1)) { setFormError('La limite doit être un nombre entier positif.'); return; }
    if (afterPaymentAction === 'REDIRECT') {
      try {
        const url = new URL(redirectUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
      } catch { setFormError('Saisissez une URL de redirection valide en HTTP ou HTTPS.'); return; }
    }
    const selectedWallet = wallets.find(wallet => wallet.id === walletId);
    const data: PaymentLinkInput = {
      amount: amountType === 'FIXED' ? Number(amount) : null,
      currency: selectedWallet?.currency ?? wallets[0]?.currency ?? 'XOF',
      productName: cleanName,
      description: cleanDescription,
      walletId: walletId === 'all' ? null : walletId,
      amountType,
      customerFields: ['full_name', 'country', 'operator', 'phone', 'email'] as PaymentLinkInput['customerFields'],
      expiresAt: expiryValue(),
      maxPayments: paymentLimit === 'limited' ? Number(maxPayments) : null,
      afterPaymentAction,
      redirectUrl: afterPaymentAction === 'REDIRECT' ? redirectUrl.trim() : null,
      notifyApp,
      notifyEmail,
      notifyWebhook,
    };
    const onSuccess = (link: PaymentLink) => {
      setCreatedLink(link);
      setEditingLink(null);
      resetForm();
      void queryClient.invalidateQueries({ queryKey: getGetBootstrapQueryKey() });
      toast(editingLink ? 'Votre lien de paiement a été mis à jour.' : 'Votre lien de paiement est prêt à être partagé.');
    };
    const onError = () => setFormError(editingLink ? 'Le lien n’a pas pu être mis à jour. Vérifiez les informations saisies et réessayez.' : 'Le lien n’a pas pu être créé. Vérifiez les informations saisies et réessayez.');
    if (editingLink) {
      updatePaymentLink.mutate({ id: editingLink.id, data }, { onSuccess, onError });
    } else {
      createPaymentLink.mutate({ data }, { onSuccess, onError });
    }
  };
  const renderLinkAmount = (link: PaymentLink) => link.amountType === 'CUSTOMER_CHOOSES' ? 'Montant libre' : money(link.amount, link.currency);
  const renderLinkExpiry = (link: PaymentLink) => expiryLabel(link.expiresAt);
  const today = new Date().toISOString().slice(0, 10);

  return <main className="page-wrap payment-links-page">
    <PageIntro eyebrow="Recevoir à distance" title="Créez un lien de paiement" subtitle="Un parcours clair pour encaisser en quelques secondes. Configurez ce que votre client voit, puis partagez le lien où vous voulez." action={<span className="payment-trust-badge"><ShieldCheck size={15} /> Paiements protégés par Mulapay</span>} />
    {createdLink && <section className="payment-success card" aria-live="polite">
      <div className="payment-success-icon"><CheckCircle2 size={22} /></div>
      <div className="payment-success-copy"><span className="eyebrow">Lien créé avec succès</span><h2>{createdLink.productName}</h2><p>Votre lien est actif. Copiez-le ou partagez-le directement avec votre client.</p>
        <div className="generated-link"><Link2 size={15} /><code>{createdLink.slug}</code><button className="button button-primary button-sm" onClick={() => copyLink(createdLink)} data-testid="button-copy-created-link">{copiedId === createdLink.id ? <><Check size={13} /> Lien copié !</> : <><Copy size={13} /> Copier</>}</button></div>
        <div className="success-actions"><a className="button button-ghost button-sm" href={createdLink.slug} target="_blank" rel="noreferrer"><Eye size={13} /> Aperçu du lien</a><button className="button button-ghost button-sm" onClick={() => shareLink(createdLink)}><Send size={13} /> Partager</button><button className="button button-ghost button-sm" onClick={() => setQrLink(createdLink)}><QrCode size={13} /> QR Code</button><button className="button button-danger button-sm" onClick={() => removeLink(createdLink)} disabled={deletePaymentLink.isPending}><Trash2 size={13} /> Supprimer</button><span className="reference-chip">Réf. {createdLink.reference ?? '—'}</span></div>
      </div>
      <button className="payment-success-close" aria-label="Masquer la confirmation" onClick={() => setCreatedLink(null)}><X size={16} /></button>
    </section>}
    <div className="payment-builder-layout">
      <form className="payment-builder card" onSubmit={submit}>
        <div className="builder-header"><div><span className="eyebrow">{editingLink ? 'Modification du lien' : 'Nouveau lien'}</span><h2>Les informations du paiement</h2><p>{editingLink ? `Modifiez les paramètres de « ${editingLink.productName} » puis enregistrez.` : 'Les champs marqués d’un astérisque sont obligatoires.'}</p></div><div className="builder-step"><span>01</span><small>{editingLink ? 'Édition' : 'Configuration'}</small></div></div>
        <div className="builder-section"><div className="builder-section-title"><span className="section-index">01</span><div><h3>Le produit ou service</h3><p>Présentez clairement ce que votre client va payer.</p></div></div>
          <div className="field"><label htmlFor="link-product-name">Nom du produit ou service <b>*</b></label><input id="link-product-name" value={productName} onChange={event => setProductName(event.target.value)} placeholder="Ex. Abonnement mensuel" required data-testid="input-link-product-name" /></div>
          <div className="field"><label htmlFor="link-description">Description <span>(facultatif)</span></label><textarea id="link-description" value={description} onChange={event => setDescription(event.target.value)} placeholder="Ajoutez quelques détails utiles pour votre client" data-testid="input-link-description" /></div>
        </div>
        <div className="builder-section"><div className="builder-section-title"><span className="section-index">02</span><div><h3>Montant et réception</h3><p>Choisissez la destination des fonds et le type de montant.</p></div></div>
          <div className="field"><label htmlFor="link-wallet">Wallet de réception</label><select id="link-wallet" value={walletId} onChange={event => setWalletId(event.target.value)} data-testid="select-link-wallet"><option value="all">Tous les wallets disponibles</option>{wallets.map(wallet => <option key={wallet.id} value={wallet.id}>{countryLabel(wallet.country)} · {wallet.currency}</option>)}</select><span className="field-hint">Mulapay dirigera le paiement vers le wallet choisi.</span></div>
          <div className="choice-grid"><label className={`choice-card ${amountType === 'FIXED' ? 'selected' : ''}`}><input type="radio" name="amount-type" checked={amountType === 'FIXED'} onChange={() => setAmountType('FIXED')} /><span className="choice-radio" /><span><strong>Montant fixe</strong><small>Le client paie exactement le montant indiqué.</small></span></label><label className={`choice-card ${amountType === 'CUSTOMER_CHOOSES' ? 'selected' : ''}`}><input type="radio" name="amount-type" checked={amountType === 'CUSTOMER_CHOOSES'} onChange={() => setAmountType('CUSTOMER_CHOOSES')} /><span className="choice-radio" /><span><strong>Montant choisi par le client</strong><small>Le client saisit le montant au moment du paiement.</small></span></label></div>
          {amountType === 'FIXED' && <div className="field amount-field"><label htmlFor="link-amount">Montant à payer <b>*</b></label><div className="input-prefix"><span>{wallets.find(wallet => wallet.id === walletId)?.currency ?? wallets[0]?.currency ?? 'XOF'}</span><input id="link-amount" type="number" min="1" step="1" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0" required data-testid="input-link-amount" /></div></div>}
        </div>
         <div className="builder-section"><div className="builder-section-title"><span className="section-index">03</span><div><h3>Règles du lien</h3><p>Gardez la main sur sa durée de vie et son nombre d’utilisations.</p></div></div>
          <div className="field"><label htmlFor="link-validity">Validité du lien</label><select id="link-validity" value={validity} onChange={event => setValidity(event.target.value)} data-testid="select-link-expiry"><option value="never">Sans expiration</option><option value="24h">24 heures</option><option value="7d">7 jours</option><option value="30d">30 jours</option><option value="custom">Date personnalisée</option></select></div>
          {validity === 'custom' && <div className="field"><label htmlFor="link-custom-date">Date de fin</label><input id="link-custom-date" type="date" min={today} value={customDate} onChange={event => setCustomDate(event.target.value)} /></div>}
          <div className="field"><label>Nombre de paiements</label><div className="inline-choice"><label className={`mini-choice ${paymentLimit === 'unlimited' ? 'selected' : ''}`}><input type="radio" name="payment-limit" checked={paymentLimit === 'unlimited'} onChange={() => setPaymentLimit('unlimited')} />Illimité</label><label className={`mini-choice ${paymentLimit === 'limited' ? 'selected' : ''}`}><input type="radio" name="payment-limit" checked={paymentLimit === 'limited'} onChange={() => setPaymentLimit('limited')} />Limité</label></div></div>
          {paymentLimit === 'limited' && <div className="field"><label htmlFor="link-max-payments">Nombre maximum</label><input id="link-max-payments" type="number" min="1" step="1" value={maxPayments} onChange={event => setMaxPayments(event.target.value)} placeholder="Ex. 25" /></div>}
        </div>
         <div className="builder-section"><div className="builder-section-title"><span className="section-index">04</span><div><h3>Après le paiement</h3><p>Choisissez l’expérience qui suit la confirmation.</p></div></div>
          <div className="choice-stack"><label className={`choice-card compact ${afterPaymentAction === 'CONFIRMATION' ? 'selected' : ''}`}><input type="radio" name="after-payment" checked={afterPaymentAction === 'CONFIRMATION'} onChange={() => setAfterPaymentAction('CONFIRMATION')} /><span className="choice-radio" /><span><strong>Confirmation Mulapay</strong><small>Votre client voit une confirmation claire après le paiement.</small></span></label><label className={`choice-card compact ${afterPaymentAction === 'REDIRECT' ? 'selected' : ''}`}><input type="radio" name="after-payment" checked={afterPaymentAction === 'REDIRECT'} onChange={() => setAfterPaymentAction('REDIRECT')} /><span className="choice-radio" /><span><strong>Rediriger vers une URL</strong><small>Retour vers votre site ou votre page de confirmation.</small></span></label></div>
          {afterPaymentAction === 'REDIRECT' && <div className="field redirect-field"><label htmlFor="link-redirect-url">URL HTTPS ou HTTP <b>*</b></label><input id="link-redirect-url" type="url" value={redirectUrl} onChange={event => setRedirectUrl(event.target.value)} placeholder="https://votre-site.com/merci" required /></div>}
        </div>
         <div className="builder-section builder-section-last"><div className="builder-section-title"><span className="section-index">05</span><div><h3>Notifications</h3><p>Recevez les informations importantes au bon endroit.</p></div></div>
          <div className="notification-options"><label className="toggle-row checked"><input type="checkbox" checked={notifyApp} onChange={event => setNotifyApp(event.target.checked)} /><span className="toggle-check">{notifyApp && <Check size={12} />}</span><span><strong>Notification Mulapay</strong><small>Dans votre espace de travail</small></span></label><label className="toggle-row checked"><input type="checkbox" checked={notifyEmail} onChange={event => setNotifyEmail(event.target.checked)} /><span className="toggle-check">{notifyEmail && <Check size={12} />}</span><span><strong>Notification e-mail</strong><small>À l’adresse de votre compte</small></span></label><label className="toggle-row"><input type="checkbox" checked={notifyWebhook} onChange={event => setNotifyWebhook(event.target.checked)} /><span className="toggle-check">{notifyWebhook && <Check size={12} />}</span><span><strong>Webhook</strong><small>Pour votre intégration technique</small></span></label></div>
        </div>
        <div className="builder-footer"><div className="reference-field"><span>Référence du paiement</span><strong>{editingLink?.reference ?? createdLink?.reference ?? 'MP-LINK-••••••••'}</strong><small>{editingLink ? 'La référence et l’URL restent inchangées' : 'Générée automatiquement · non modifiable'}</small></div><div className="builder-submit">{formError && <div className="form-error"><CircleAlert size={14} /> {formError}</div>}<div className="builder-submit-actions">{editingLink && <button type="button" className="button button-ghost" onClick={cancelEdit}>Annuler</button>}<button type="submit" className="button button-primary" disabled={createPaymentLink.isPending || updatePaymentLink.isPending} data-testid="button-submit-link">{createPaymentLink.isPending || updatePaymentLink.isPending ? (editingLink ? 'Mise à jour en cours…' : 'Création en cours…') : <><Pencil size={15} /> {editingLink ? 'Enregistrer les modifications' : 'Créer le lien de paiement'}</>}</button></div></div></div>
      </form>
       <aside className="payment-builder-aside"><div className="payment-preview card"><div className="preview-top"><div><span className="eyebrow">Aperçu</span><h2>Ce que votre client verra</h2></div><Eye size={17} /></div><div className="preview-payment"><div className="preview-brand"><span className="preview-mark">M</span><span>Mulapay</span><ShieldCheck size={13} /></div><div className="preview-product"><span className="preview-label">Paiement demandé</span><strong>{productName.trim() || 'Votre produit ou service'}</strong><p>{description.trim() || 'La description de votre paiement apparaîtra ici.'}</p></div><div className="preview-amount"><span>{amountType === 'FIXED' ? 'Montant' : 'Montant libre'}</span><strong>{amountType === 'FIXED' && amount ? money(Number(amount), wallets.find(wallet => wallet.id === walletId)?.currency ?? wallets[0]?.currency ?? 'XOF') : amountType === 'FIXED' ? '—' : 'Au choix'}</strong></div><div className="preview-detail"><span><Clock3 size={13} /> {validity === 'never' ? 'Sans expiration' : validity === 'custom' && customDate ? `Jusqu’au ${new Date(`${customDate}T12:00:00`).toLocaleDateString('fr-FR')}` : `Valide ${validity === '24h' ? '24 heures' : validity === '7d' ? '7 jours' : '30 jours'}`}</span><span><ShieldCheck size={13} /> Paiement sécurisé</span></div><div className="preview-button">Continuer vers le paiement <ArrowRight size={14} /></div></div></div></aside>
    </div>
    <section className="existing-links-section"><div className="section-head"><div><span className="eyebrow">Votre activité</span><h2 className="section-title">Liens existants</h2><p className="section-note">{links.length ? `${links.length} lien${links.length > 1 ? 's' : ''} enregistré${links.length > 1 ? 's' : ''}` : 'Vos liens créés apparaîtront ici.'}</p></div><span className="link-count-badge">{links.length}</span></div>
        {links.length === 0 ? <div className="empty-state card payment-links-empty"><Link2 size={25} /><strong>Aucun lien pour le moment</strong><p>Configurez votre premier lien ci-dessus pour commencer à recevoir des paiements.</p></div> : <div className="links-table card"><div className="links-table-head"><span>Produit / service</span><span>Montant</span><span>Référence</span><span>Statut</span><span>Validité</span><span>Paiements</span><span>Actions</span></div>{links.map(link => <div className={`links-table-row ${editingLink?.id === link.id ? 'is-editing' : ''}`} key={link.id} data-testid={`card-payment-link-${link.id}`}><div className="link-product"><span className="link-product-icon"><Link2 size={14} /></span><span><strong>{link.productName || link.description || 'Lien de paiement'}</strong><small>{link.description || 'Sans description'}</small></span></div><strong className="table-amount">{renderLinkAmount(link)}</strong><code>{link.reference || '—'}</code><span className={`pill ${link.status === 'Active' ? 'pill-success' : link.status === 'Expired' ? 'pill-danger' : 'pill-neutral'}`}>{statusLabel(link.status)}</span><span className="table-muted">{renderLinkExpiry(link)}</span><span className="table-muted">{link.payments}{link.maxPayments ? ` / ${link.maxPayments}` : ''}</span><div className="link-actions"><button className="icon-button" title="Modifier le lien" onClick={() => beginEdit(link)} data-testid={`button-edit-link-${link.id}`}><Pencil size={15} /></button><a className="icon-button" href={link.slug} target="_blank" rel="noreferrer" title="Aperçu du lien" data-testid={`button-preview-link-${link.id}`}><Eye size={15} /></a><button className="icon-button" title={copiedId === link.id ? 'Lien copié' : 'Copier le lien'} onClick={() => copyLink(link)} data-testid={`button-copy-link-${link.id}`}>{copiedId === link.id ? <Check size={15} /> : <Copy size={15} />}</button><button className="icon-button" title="Partager le lien" onClick={() => shareLink(link)} data-testid={`button-share-link-${link.id}`}><Send size={15} /></button><button className="icon-button" title="Afficher le QR code" onClick={() => setQrLink(link)} data-testid={`button-qr-link-${link.id}`}><QrCode size={15} /></button><button className="icon-button" title="Supprimer définitivement" onClick={() => removeLink(link)} disabled={deletePaymentLink.isPending} data-testid={`button-delete-link-${link.id}`}><Trash2 size={15} /></button></div></div>)}</div>}
    </section>
    {qrLink && <div className="payment-modal-backdrop" role="presentation" onClick={() => setQrLink(null)}><div className="payment-qr-modal card" role="dialog" aria-modal="true" aria-label="QR Code du lien" onClick={event => event.stopPropagation()}><button className="payment-success-close" aria-label="Fermer" onClick={() => setQrLink(null)}><X size={16} /></button><span className="eyebrow">À partager en présentiel</span><h2>QR Code du paiement</h2><p>{qrLink.productName}</p><QRCodeSVG value={qrLink.slug} size={220} level="M" includeMargin data-testid="qr-payment-link-modal" /><code>{qrLink.slug}</code><button className="button button-primary button-wide" onClick={() => copyLink(qrLink)}>{copiedId === qrLink.id ? <><Check size={14} /> Lien copié !</> : <><Copy size={14} /> Copier le lien</>}</button></div></div>}
  </main>;
}

function PublicPaymentPage() {
  const [location] = useLocation();
  const token = location.split('/').filter(Boolean).pop() ?? '';
  const [link, setLink] = useState<PublicPaymentLink | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [customerCountry, setCustomerCountry] = useState(mobileMoneyCountryOptions[0].country);
  const [customerOperator, setCustomerOperator] = useState(mobileMoneyCountryOptions[0].operators[0]?.name ?? '');
  const [customerValues, setCustomerValues] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState('');
  const [operatorOtp, setOperatorOtp] = useState('');
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const [paymentResult, setPaymentResult] = useState<{ reference?: string; message?: string; paymentUrl?: string | null } | null>(null);

  useEffect(() => {
    let mounted = true;
    setState('loading');
    void fetch(`/api/v1/public/payment-links/${encodeURIComponent(token)}`)
      .then(async response => {
        if (!response.ok) throw new Error('unavailable');
        return response.json() as Promise<PublicPaymentLink>;
      })
      .then(data => {
        if (!mounted) return;
        setLink(data);
        setState('ready');
      })
      .catch(() => {
        if (mounted) setState('error');
      });
    return () => { mounted = false; };
  }, [token]);

  if (state === 'loading') return <div className="loading-screen">Chargement du paiement…</div>;
  if (state === 'error' || !link) return <main className="page-wrap public-payment-page"><div className="public-payment-header"><Logo /></div><PageIntro eyebrow="Paiement Mulapay" title="Lien indisponible" subtitle="Vérifiez l’adresse reçue ou demandez un nouveau lien au commerçant." /><div className="card card-pad public-payment-unavailable"><CircleAlert size={22} /><strong>Ce lien de paiement n’est plus disponible.</strong><Link className="button button-primary" href="/">Retour à Mulapay</Link></div></main>;

  const selectedCustomerCountry = mobileMoneyCountryOptions.find(option => option.country === customerCountry) ?? mobileMoneyCountryOptions[0];
   // Les informations de paiement sont toujours obligatoires pour une transaction réelle,
   // même si un ancien lien a été créé avec une configuration de champs incomplète.
   const hasField = (_name: string) => true;
  const updateCustomerValue = (name: string, value: string) => setCustomerValues(values => ({ ...values, [name]: value }));
  const fixedAmount = link.amountType === 'FIXED' ? money(link.amount, link.currency) : 'Montant libre';
   const selectedAmount = link.amountType === 'FIXED' ? link.amount : Number(amount) || 0;
   const selectedAmountLabel = selectedAmount > 0 ? money(selectedAmount, link.currency) : `À renseigner en ${link.currency}`;
   const expiryLabel = link.expiresAt ? new Date(link.expiresAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Sans expiration';
  const submitPayment = async (event: FormEvent) => {
    event.preventDefault();
    setPaymentError('');
    setPaymentResult(null);
    setPaymentSubmitting(true);
    const selectedAmount = link.amountType === 'FIXED' ? link.amount : Number(amount);
    try {
      const response = await fetch(`/api/v1/public/payment-links/${encodeURIComponent(token)}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          amount: selectedAmount,
          fullName: customerValues.full_name?.trim(),
          country: customerCountry,
          operator: customerOperator,
          phone: `${selectedCustomerCountry.dialCode}${(customerValues.phone ?? '').replace(/\D/g, '')}`,
          email: customerValues.email?.trim(),
          ...(operatorOtp ? { operatorOtp } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Le paiement n’a pas pu être initié.');
      setPaymentResult(payload);
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : 'Le paiement n’a pas pu être initié.');
    } finally {
      setPaymentSubmitting(false);
    }
  };

   return <main className="page-wrap public-payment-page">
     <div className="public-payment-header"><Logo /><div className="public-payment-trust"><LockKeyhole size={13} /> Paiement sécurisé</div></div>
     <div className="public-payment-intro"><span className="eyebrow">Paiement Mulapay</span><h1>{link.productName}</h1><p>{link.description || 'Effectuez votre paiement Mobile Money en toute sécurité.'}</p></div>
     <div className="public-payment-layout">
       <aside className="public-payment-summary">
         <div className="public-payment-summary-top"><span className="public-payment-summary-mark"><Link2 size={15} /></span><div><span className="eyebrow">Récapitulatif</span><strong>{link.productName}</strong></div></div>
         <div className="public-payment-total"><span>{link.amountType === 'FIXED' ? 'Montant à payer' : 'Montant de votre choix'}</span><strong>{selectedAmountLabel}</strong>{link.amountType === 'CUSTOMER_CHOOSES' && <small>Le montant sera confirmé avant le paiement.</small>}</div>
         <div className="public-payment-details"><div><Clock3 size={14} /><span><small>Validité</small><strong>{expiryLabel}</strong></span></div><div><ShieldCheck size={14} /><span><small>Référence</small><strong>{link.reference ?? '—'}</strong></span></div></div>
         <div className="public-payment-methods"><span className="eyebrow">Moyens disponibles</span><div><span>Mobile Money</span><span className="public-payment-method-logos">{mobileMoneyProviders.slice(0, 4).map(provider => <img key={provider.name} src={`${import.meta.env.BASE_URL}mobile-money/${provider.src}`} alt={provider.name} />)}</span></div></div>
         <p className="public-payment-note">Votre paiement est transmis au service de paiement puis crédité au commerçant uniquement après confirmation.</p>
       </aside>
       <form className="card card-pad deposit-form public-payment-form" onSubmit={submitPayment}>
         {paymentResult ? <div className="public-payment-result" aria-live="polite"><span className="public-payment-result-icon"><CheckCircle2 size={22} /></span><span className="eyebrow">Demande enregistrée</span><h2>Continuez votre paiement</h2><p>{paymentResult.message}</p>{paymentResult.reference && <code>{paymentResult.reference}</code>}{paymentResult.paymentUrl ? <a className="button button-primary button-wide" href={paymentResult.paymentUrl} target="_blank" rel="noreferrer">Ouvrir le paiement sécurisé <ChevronRight size={15} /></a> : <div className="public-payment-waiting"><Clock3 size={15} /> Confirmez la demande sur votre téléphone.</div>}</div> : <>
           <div className="public-payment-form-head"><div><span className="eyebrow">Dernière étape</span><h2>Vos informations</h2><p>Renseignez les coordonnées utilisées pour le paiement.</p></div><span className="public-payment-step">1 / 1</span></div>
           {link.amountType === 'CUSTOMER_CHOOSES' && <div className="field"><label htmlFor="public-payment-amount">Montant à payer</label><div className="input-prefix"><span>{link.currency}</span><input id="public-payment-amount" type="number" min="1" step="1" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0" required /></div><small className="field-hint">Saisissez un montant entier en {link.currency}.</small></div>}
           {hasField('full_name') && <div className="field"><label htmlFor="public-payment-full-name">Nom complet</label><input id="public-payment-full-name" value={customerValues.full_name ?? ''} onChange={event => updateCustomerValue('full_name', event.target.value)} autoComplete="name" placeholder="Votre nom et prénom" required /></div>}
           {hasField('country') && <div className="field"><label htmlFor="public-payment-country">Pays du payeur</label><div className="country-select"><img src={`${import.meta.env.BASE_URL}countries/${selectedCustomerCountry.flagSrc}`} alt="" /><select id="public-payment-country" value={customerCountry} onChange={event => { setCustomerCountry(event.target.value); const next = mobileMoneyCountryOptions.find(option => option.country === event.target.value); setCustomerOperator(next?.operators[0]?.name ?? ''); }} required>{mobileMoneyCountryOptions.map(option => <option key={option.country} value={option.country} disabled={option.code === 'NE'}>{option.country} · {option.dialCode}{option.code === 'NE' ? ' · bientôt disponible' : ''}</option>)}</select><ChevronDown className="country-select-chevron" size={16} aria-hidden="true" /></div></div>}
           {hasField('operator') && <div className="field"><label>Opérateur Mobile Money</label><div className="mobile-money-options" role="radiogroup" aria-label="Choisir un opérateur Mobile Money">{selectedCustomerCountry.operators.map(option => <label className={`mobile-money-option ${customerOperator === option.name ? 'selected' : ''}`} key={option.name}><input type="radio" name="public-payment-operator" value={option.name} checked={customerOperator === option.name} onChange={event => setCustomerOperator(event.target.value)} required /><img src={`${import.meta.env.BASE_URL}mobile-money/${option.src}`} alt="" /><span>{option.name}</span></label>)}</div></div>}
           {hasField('phone') && <div className="field"><label htmlFor="public-payment-phone">Numéro de téléphone</label><div className="phone-input"><span className="phone-prefix" aria-label={`Indicatif ${selectedCustomerCountry.dialCode}`}>{selectedCustomerCountry.dialCode}</span><input id="public-payment-phone" type="tel" inputMode="numeric" value={customerValues.phone ?? ''} onChange={event => updateCustomerValue('phone', event.target.value.replace(/\D/g, ''))} placeholder="90 00 00 00" autoComplete="tel-national" required /></div><small className="field-hint">Utilisez le numéro associé à votre compte Mobile Money.</small></div>}
           {hasField('email') && <div className="field"><label htmlFor="public-payment-email">Adresse e-mail</label><input id="public-payment-email" type="email" value={customerValues.email ?? ''} onChange={event => updateCustomerValue('email', event.target.value)} placeholder="vous@exemple.com" autoComplete="email" required /></div>}
           {customerOperator === 'Orange Money' && <div className="field"><label htmlFor="public-payment-otp">Code OTP Mobile Money</label><input id="public-payment-otp" type="password" inputMode="numeric" value={operatorOtp} onChange={event => setOperatorOtp(event.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" required /><small className="field-hint">Le code est demandé uniquement lorsque l’opérateur l’exige.</small></div>}
           <div className="public-payment-security"><ShieldCheck size={15} /><span>Vos informations sont chiffrées et utilisées uniquement pour initier ce paiement.</span></div>
           {paymentError && <div className="form-error public-payment-error"><CircleAlert size={14} /> {paymentError}</div>}
           <button className="button button-primary button-wide" type="submit" disabled={paymentSubmitting}>{paymentSubmitting ? 'Initialisation du paiement…' : `Payer ${selectedAmount > 0 ? selectedAmountLabel : ''}`} <ChevronRight size={15} /></button>
           <p className="public-payment-terms">En continuant, vous confirmez les informations saisies et acceptez que le paiement soit traité par votre opérateur Mobile Money.</p>
         </>}
       </form>
     </div>
   </main>;
}

function RealKyc() {
  const { profile } = useStore();
  const status = profile.kycStatus;
  const verified = status === 'VERIFIE' || status === 'VERIFIED';
  const pending = status === 'EN_ATTENTE' || status === 'PENDING';
  const label = verified ? 'Vérifié' : pending ? 'En cours d’examen' : status === 'REFUSE' || status === 'REFUSED' ? 'Refusé' : 'Non vérifié';
  return <main className="page-wrap"><PageIntro eyebrow="Vérification du compte" title="Votre vérification" subtitle="Cet état provient de votre dossier KYC enregistré côté serveur." action={<span className={`pill ${verified ? 'pill-success' : pending ? 'pill-pending' : 'pill-neutral'}`} style={{ padding: '8px 12px' }}><ShieldCheck size={13} style={{ marginRight: 5 }} /> {label}</span>} /><div className="dashboard-grid" style={{ marginTop: 27 }}><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">État de la vérification</h2><p className="section-note">Aucun document ou statut n’est affiché avant son enregistrement réel.</p></div><ShieldCheck size={24} color="hsl(160 42% 38%)" /></div><div style={{ height: 7, borderRadius: 5, background: 'hsl(160 42% 38% / .12)', overflow: 'hidden', margin: '23px 0 25px' }}><div style={{ width: verified ? '100%' : pending ? '66%' : '0%', height: '100%', background: 'hsl(160 42% 38%)', borderRadius: 5 }} /></div><div className="empty-state"><FileCheck2 size={25} /><strong>{verified ? 'Dossier vérifié' : pending ? 'Dossier en cours d’examen' : 'Aucun dossier KYC enregistré'}</strong><p>{verified ? 'La vérification a été confirmée par les opérations.' : pending ? 'Votre dossier sera mis à jour après décision de l’équipe conformité.' : 'Le dépôt de documents sera disponible lorsque le circuit de collecte sécurisé sera activé.'}</p></div></div><div className="card card-pad"><div className="eyebrow">Documents</div><div className="notice" style={{ marginTop: 16 }}><LockKeyhole size={14} /><span>Les documents ne sont pas préremplis et aucun envoi local ne simule une vérification.</span></div></div></div></main>;
}

function Kyc() {
  const [uploaded, setUploaded] = useState(false); const { toast, submitKyc } = useStore();
  return <main className="page-wrap"><PageIntro eyebrow="Vérification du compte" title="Votre vérification" subtitle="Un compte vérifié rend les mouvements transfrontaliers plus sûrs pour tous. Les nouveaux documents sont enregistrés dans la file conformité." action={<span className="pill pill-success" style={{ padding: '8px 12px' }}><CheckCircle2 size={13} style={{ marginRight: 5 }} /> Vérifié</span>} /><div className="dashboard-grid" style={{ marginTop: 27 }}><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">État de la vérification</h2><p className="section-note">L’état actuel est enregistré sur votre profil Mulapay.</p></div><ShieldCheck size={24} color="hsl(160 42% 38%)" /></div><div style={{ height: 7, borderRadius: 5, background: 'hsl(160 42% 38% / .12)', overflow: 'hidden', margin: '23px 0 25px' }}><div style={{ width: uploaded ? '100%' : '66%', height: '100%', background: 'hsl(160 42% 38%)', borderRadius: 5 }} /></div><div className="step-list"><div className="step done"><div className="step-number"><Check size={13} /></div><div><div className="step-title">Informations du profil</div><div className="step-copy">Nom, email et numéro de téléphone confirmés.</div></div></div><div className="step done"><div className="step-number"><Check size={13} /></div><div><div className="step-title">Pièce d’identité</div><div className="step-copy">Carte nationale · examinée et approuvée.</div></div></div><div className={`step ${uploaded ? 'done' : ''}`}><div className="step-number">{uploaded ? <Check size={13} /> : '3'}</div><div><div className="step-title">Confirmation de l’adresse <span className="pill pill-neutral" style={{ marginLeft: 6 }}>{uploaded ? 'Envoyée' : 'Facultatif'}</span></div><div className="step-copy">{uploaded ? 'Justificatif de domicile envoyé pour examen.' : 'Ajoutez un justificatif de domicile pour augmenter vos limites.'}</div></div></div></div></div><div className="card card-pad"><div className="eyebrow">Liste des documents</div><div className="step-list" style={{ marginTop: 10 }}><div className="step done"><div className="step-number"><Check size={13} /></div><div><div className="step-title">Carte nationale</div><div className="step-copy">Approuvée et conservée dans le dossier de vérification.</div></div></div><div className={`step ${uploaded ? 'done' : ''}`}><div className="step-number">{uploaded ? <Check size={13} /> : '+'}</div><div style={{ flex: 1 }}><div className="step-title">Justificatif de domicile</div><div className="step-copy">{uploaded ? 'Document envoyé avec succès.' : 'Facture ou relevé bancaire des 3 derniers mois.'}</div>{!uploaded && <button className="button button-ghost button-sm" style={{ marginTop: 11 }} onClick={() => { setUploaded(true); submitKyc(['National ID', 'Selfie', 'Proof of address']); toast('Justificatif de domicile envoyé pour examen.'); }} data-testid="button-upload-kyc">Envoyer le document</button>}</div></div></div><div className="notice" style={{ marginTop: 20 }}><LockKeyhole size={14} /><span>Les documents sont transmis au circuit conformité Mulapay ; aucun prestataire de paiement n’intervient.</span></div></div></div></main>;
}

function RealSettings() {
  const { profile, signOut } = useStore();
  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  return <main className="page-wrap"><PageIntro eyebrow="Préférences du compte" title="Paramètres" subtitle="Les informations d’identité sont gérées par Clerk ; aucun bouton local ne prétend enregistrer une modification non persistée." /><div className="form-layout" style={{ marginTop: 27 }}><div className="card card-pad"><div className="section-title">Informations du profil</div><p className="section-note" style={{ marginTop: 5, marginBottom: 22 }}>Ces données viennent du profil authentifié.</p><div className="field"><label>Nom complet</label><input value={fullName || 'Non renseigné'} readOnly /></div><div className="field"><label>Adresse e-mail</label><input value={profile.email || 'Non renseignée'} readOnly /></div><div className="field"><label>Pays de résidence</label><input value={profile.country} readOnly /></div><div className="notice"><LockKeyhole size={14} /><span>Pour modifier votre identité ou votre sécurité, utilisez les réglages de votre compte Clerk.</span></div></div><div><div className="card card-pad"><div className="section-title">Sécurité</div><div className="activity-row"><div className="activity-main"><div className="activity-icon"><LockKeyhole size={15} /></div><div><div className="activity-name">Authentification</div><div className="activity-meta">Gérée par Clerk avec des sessions sécurisées</div></div></div><Link className="button button-ghost button-sm" href="/sign-in">Gérer</Link></div></div><div className="card card-pad" style={{ marginTop: 14 }}><div className="eyebrow">Compte</div><button className="button button-danger button-wide" style={{ marginTop: 17 }} onClick={signOut} data-testid="button-sign-out"><LogOut size={14} /> Se déconnecter</button></div></div></div></main>;
}

function Settings() {
  const { toast, signOut } = useStore(); const [name, setName] = useState('Afi Kossi'); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('+228 90 12 45 67');
  return <main className="page-wrap"><PageIntro eyebrow="Préférences du compte" title="Paramètres" subtitle="Gardez votre profil Mulapay et vos informations de sécurité à jour." /><div className="form-layout" style={{ marginTop: 27 }}><div className="card card-pad"><div className="section-title">Informations du profil</div><p className="section-note" style={{ marginTop: 5, marginBottom: 22 }}>Votre identité est gérée de façon sécurisée par Clerk ; les données de paiement restent dans le ledger Mulapay.</p><div className="field"><label>Nom complet</label><input value={name} onChange={e => setName(e.target.value)} data-testid="input-settings-name" /></div><div className="field"><label>Adresse email</label><input value={email} onChange={e => setEmail(e.target.value)} placeholder="Gérée par votre fournisseur de connexion" data-testid="input-settings-email" /></div><div className="field"><label>Numéro de téléphone</label><input value={phone} onChange={e => setPhone(e.target.value)} data-testid="input-settings-phone" /></div><div className="field"><label>Pays de résidence</label><select defaultValue="Togo" data-testid="select-settings-country"><option>Togo</option><option>Bénin</option><option>Sénégal</option><option>Côte d’Ivoire</option><option>Burkina Faso</option><option>Mali</option><option>Niger</option></select></div><button className="button button-primary" onClick={() => toast('Préférences du profil enregistrées pour la prochaine mise à jour.')} data-testid="button-save-settings">Enregistrer les changements</button></div><div><div className="card card-pad"><div className="section-title">Sécurité</div><div className="activity-row"><div className="activity-main"><div className="activity-icon"><LockKeyhole size={15} /></div><div><div className="activity-name">Authentification</div><div className="activity-meta">Gérée par Clerk avec des sessions sécurisées</div></div></div><Link className="button button-ghost button-sm" href="/sign-in">Gérer</Link></div><div className="activity-row"><div className="activity-main"><div className="activity-icon"><Bell size={15} /></div><div><div className="activity-name">Alertes de transaction</div><div className="activity-meta">Notifications email et dans l’application</div></div></div><button className="button button-primary button-sm" onClick={() => toast('Les alertes de transaction sont activées.')} data-testid="button-toggle-alerts">Activées</button></div></div><div className="card card-pad" style={{ marginTop: 14 }}><div className="eyebrow">Compte</div><button className="button button-danger button-wide" style={{ marginTop: 17 }} onClick={signOut} data-testid="button-sign-out"><LogOut size={14} /> Se déconnecter</button></div></div></div></main>;
}

function AdminFeeSettings() {
  const { toast } = useStore();
  const settingsQuery = useGetAdminSettings({ query: { queryKey: getGetAdminSettingsQueryKey(), retry: false } });
  const updateSettingsMutation = useUpdateAdminSettings();
  const [value, setValue] = useState('');

  useEffect(() => {
    if (settingsQuery.data) setValue(String(settingsQuery.data.feePercentage));
  }, [settingsQuery.data]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const feePercentage = Number(value);
    if (!Number.isFinite(feePercentage) || feePercentage < 0 || feePercentage > 100) {
      toast('Le taux doit être compris entre 0 % et 100 %.');
      return;
    }
    updateSettingsMutation.mutate({ data: { feePercentage } }, {
      onSuccess: response => {
        setValue(String(response.feePercentage));
        void queryClient.invalidateQueries({ queryKey: getGetAdminSettingsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetBootstrapQueryKey() });
        toast('Le taux de frais a été enregistré.');
      },
      onError: () => toast('Le taux de frais n’a pas pu être enregistré.'),
    });
  };

  return <div className="card card-pad" style={{ marginTop: 17 }}>
    <div className="section-head">
      <div><h2 className="section-title">Configuration des frais</h2><p className="section-note">Ce taux est utilisé pour les estimations de retrait et d’envoi.</p></div>
      <span className="pill pill-success">Admin</span>
    </div>
    <form onSubmit={save} style={{ display: 'flex', alignItems: 'end', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
      <div className="field" style={{ marginBottom: 0, width: 190 }}>
        <label htmlFor="admin-fee-percentage">Pourcentage des frais</label>
        <div className="input-prefix">
          <input id="admin-fee-percentage" type="number" min="0" max="100" step="0.01" value={value} onChange={event => setValue(event.target.value)} placeholder="1" required data-testid="input-admin-fee-percentage" />
          <span style={{ left: 'auto', right: 12 }}>%</span>
        </div>
      </div>
      <button className="button button-primary" type="submit" disabled={updateSettingsMutation.isPending || !value} data-testid="button-save-admin-fee">
        {updateSettingsMutation.isPending ? 'Enregistrement…' : 'Enregistrer le taux'}
      </button>
    </form>
  </div>;
}

function AdminOverview() {
  const { exchanges, transactions, adminSummary } = useStore();
  const pendingExchanges = exchanges.filter(exchange => exchange.status === 'Pending review').length;
  return <main className="page-wrap"><PageIntro eyebrow="Opérations sécurisées" title="Vue d’ensemble des opérations" subtitle="Une vue des contrôles et mouvements réellement enregistrés dans Mulapay." action={<Link href="/admin/exchanges" className="button button-primary" data-testid="button-admin-review"><Eye size={15} /> Ouvrir la file</Link>} /><div className="admin-grid"><div className="card admin-stat"><div className="metric-label">KYC à examiner <FileCheck2 size={15} /></div><div className="metric-value">{adminSummary?.kycAwaiting ?? 0}</div><div className="activity-meta">Dossiers persistés</div></div><div className="card admin-stat"><div className="metric-label">File des échanges <RefreshCw size={15} /></div><div className="metric-value">{pendingExchanges}</div><div className="activity-meta">Décision requise</div></div><div className="card admin-stat"><div className="metric-label">Volume enregistré <ArrowUpRight size={15} /></div><div className="metric-value">{money(adminSummary?.volume ?? 0).replace(' XOF', '')}<small>XOF</small></div><div className="activity-meta">Ledger Mulapay</div></div><div className="card admin-stat"><div className="metric-label">Taux de réussite <Activity size={15} /></div><div className="metric-value">{String(adminSummary?.successRate ?? 0).replace('.', ',')}<small>%</small></div><div className="activity-meta">Calculé par le serveur</div></div></div><div className="dashboard-grid"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Files de contrôle</h2><p className="section-note">Les dossiers et opérations nécessitant une décision.</p></div></div><Link href="/admin/exchanges" className="case-row" data-testid="link-admin-exchange-case"><div className="case-person"><div className="person-initial"><RefreshCw size={15} /></div><div><div className="case-name">Demandes d’échange</div><div className="case-meta">{pendingExchanges} demande(s) en attente</div></div></div><ChevronRight size={16} color="hsl(203 18% 46%)" /></Link><Link href="/admin/kyc" className="case-row" style={{ marginTop: 10 }} data-testid="link-admin-kyc-case"><div className="case-person"><div className="person-initial"><FileCheck2 size={15} /></div><div><div className="case-name">Dossiers KYC</div><div className="case-meta">{adminSummary?.kycAwaiting ?? 0} dossier(s) en attente</div></div></div><ChevronRight size={16} color="hsl(203 18% 46%)" /></Link></div><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">État du système</h2><p className="section-note">Données courantes du serveur</p></div><span className="pill pill-success">Opérationnel</span></div><div className="summary-box"><div className="summary-line"><span>Transactions chargées</span><strong>{transactions.length}</strong></div><div className="summary-line"><span>Échanges en attente</span><strong>{pendingExchanges}</strong></div><div className="summary-line"><span>Actions échouées</span><strong>—</strong></div></div><div className="activity-meta" style={{ marginTop: 15 }}><Activity size={12} style={{ verticalAlign: 'middle', marginRight: 5 }} /> Actualisé depuis l’API</div></div></div><AdminFeeSettings /><div className="card card-pad" style={{ marginTop: 17 }}><div className="section-head"><div><h2 className="section-title">Derniers mouvements</h2><p className="section-note">Sur tous les wallets par pays</p></div><Link href="/admin/transactions" className="eyebrow" data-testid="link-admin-all-transactions">Voir le ledger</Link></div>{transactions.slice(0, 3).map(t => <TransactionRow transaction={t} key={t.id} />)}</div></main>;
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
    adminKyc: (adminKycQuery.data ?? []) as AdminKycCase[], adminTransactions: (adminTransactionsQuery.data ?? []) as Transaction[], adminSummary: adminSummaryQuery.data as AdminSummary | undefined, feePercentage: data?.feePercentage ?? 1,
    transfer: ({ amount, currency, country, counterparty, note, feePayer }) => { transferMutation.mutate({ data: { amount, currency, country, counterparty, note, feePayer } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('Transfert impossible. Vérifiez le solde disponible.') }); },
    exchange: ({ source, destination, amount }) => { exchangeMutation.mutate({ data: { source, destination, amount } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('La demande d’échange n’a pas pu être créée.') }); },
    setExchangeStatus: (id, status) => { exchangeDecisionMutation.mutate({ id, data: { decision: status === 'Completed' ? 'APPROVED' : 'REJECTED' } }, { onSuccess: response => { invalidate(); toast(response.message); }, onError: () => toast('La décision d’échange n’a pas pu être enregistrée.') }); },
    addLink: data => { paymentLinkMutation.mutate({ data }, { onSuccess: response => { invalidate(); toast(`Lien de paiement ${response.slug} créé.`); }, onError: () => toast('Le lien de paiement n’a pas pu être créé.') }); },
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
  const Kyc = RealKyc;
  const Settings = RealSettings;
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
  return <Switch><Route path="/" component={HomeRedirect} /><Route path="/pay/:token" component={PublicPaymentPage} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/forgot-password" component={ForgotPasswordPage} /><Route path="/terms" component={() => <LegalPage kind="terms" />} /><Route path="/privacy" component={() => <LegalPage kind="privacy" />} /><Route path="/app" component={RoutedApp} /><Route path="/app/:rest*" component={RoutedApp} /><Route path="/admin" component={RoutedApp} /><Route path="/admin/:rest*" component={RoutedApp} /><Route component={NotFound} /></Switch>;
}

function App() {
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={basePath}><ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={frFR}><Router /></ClerkProvider></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;