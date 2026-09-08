import { useEffect, useState } from "react";
import { Share, X } from "lucide-react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const DISMISSED_KEY = "mulapay:pwa-install-dismissed";
const DISMISS_DURATION = 7 * 24 * 60 * 60 * 1000;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
    || Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
}

function wasDismissedRecently() {
  const value = window.localStorage.getItem(DISMISSED_KEY);
  return value ? Date.now() - Number(value) < DISMISS_DURATION : false;
}

export function PwaInstallBanner() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIos, setIsIos] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isStandalone() || wasDismissedRecently()) return;
    const userAgent = window.navigator.userAgent.toLowerCase();
    const iosDevice = /iphone|ipad|ipod/.test(userAgent);
    setIsIos(iosDevice);

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const handleInstalled = () => {
      setVisible(false);
      setInstallPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    if (iosDevice) setVisible(true);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setVisible(false);
  };

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <aside className="pwa-install-banner" role="dialog" aria-label="Installer Mulapay">
      <div className="pwa-install-icon"><img src={`${import.meta.env.BASE_URL}mulapay-mark.png`} alt="" /></div>
      <div className="pwa-install-copy">
        <strong>Installer Mulapay</strong>
        {isIos && !installPrompt
          ? <span>Appuyez sur <Share size={13} aria-hidden="true" /> puis « Sur l’écran d’accueil ».</span>
          : <span>Accédez plus vite à vos wallets depuis votre écran d’accueil.</span>}
      </div>
      {installPrompt && <button type="button" className="button button-primary button-sm" onClick={() => void install()}>Installer</button>}
      <button type="button" className="pwa-install-close" onClick={dismiss} aria-label="Fermer la bannière"><X size={16} /></button>
    </aside>
  );
}