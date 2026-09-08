const fs = require('fs');

const cssContent = fs.readFileSync('artifacts/mulapay/src/index.css', 'utf8');
if (!cssContent.includes('.settings-layout')) {
  const newCss = cssContent + `
.settings-layout { display: flex; flex-direction: column; gap: 24px; margin-top: 24px; }
.settings-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.settings-bottom-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
.settings-danger-zone { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 24px; border: 1px solid hsl(var(--destructive) / 0.2); border-radius: 17px; background: hsl(var(--destructive) / 0.05); }

@media (max-width: 768px) {
  .settings-form-grid { grid-template-columns: 1fr; }
  .settings-bottom-grid { grid-template-columns: 1fr; gap: 16px; }
  .settings-danger-zone { flex-direction: column; align-items: stretch; text-align: center; }
}
`;
  fs.writeFileSync('artifacts/mulapay/src/index.css', newCss);
}

const content = fs.readFileSync('artifacts/mulapay/src/App.tsx', 'utf8');

const regex = /function Settings\(\) \{[\s\S]*?function AdminFeeSettings\(\) \{/m;

const replacement = `function Settings() {
  const { profile, toast, signOut } = useStore();
  const queryClient = useQueryClient();

  const [firstName, setFirstName] = useState(profile.firstName || '');
  const [lastName, setLastName] = useState(profile.lastName || '');
  const [birthDate, setBirthDate] = useState(profile.birthDate || '');
  const [phone, setPhone] = useState(profile.phone || '');
  const [language, setLanguage] = useState(profile.language || 'fr');
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    profile.notificationsEnabled ?? true
  );
  const [loading, setLoading] = useState(false);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/v1/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ firstName, lastName, birthDate, phone, language, notificationsEnabled })
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: getGetBootstrapQueryKey() });
        toast('Vos informations ont été mises à jour.');
      } else {
        toast('Erreur lors de la mise à jour du profil.');
      }
    } catch (err) {
      toast('Erreur de connexion. Veuillez réessayer.');
    } finally {
      setLoading(false);
    }
  };

  const kycVerified = kycIsVerified(profile.kycStatus);
  const kycRejected = ['REFUSED', 'REJECTED'].includes(profile.kycStatus.toUpperCase());
  const kycPending = ['PENDING', 'EN_ATTENTE', 'REVIEW'].includes(profile.kycStatus.toUpperCase());
  const kycLabel = kycVerified ? 'Vérifié' : kycRejected ? 'À corriger' : kycPending ? 'En attente' : 'Non vérifié';

  return (
    <main className="page-wrap">
      <PageIntro eyebrow="Informations personnelles" title="Compte" subtitle="Gérez votre profil et vos préférences de contact." />

      <div className="settings-layout">
        <form onSubmit={handleSave} className="card card-pad">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h3 className="section-title">Informations personnelles</h3>
          </div>

          <div className="settings-form-grid">
            <div className="field">
              <label>Nom</label>
              <input value={lastName} onChange={e => setLastName(e.target.value)} required disabled={loading} data-testid="input-settings-lastname" />
            </div>
            <div className="field">
              <label>Prénom</label>
              <input value={firstName} onChange={e => setFirstName(e.target.value)} required disabled={loading} data-testid="input-settings-firstname" />
            </div>
          </div>

          <div className="settings-form-grid">
            <div className="field">
              <label>Date de naissance</label>
              <input type="date" max={new Date().toISOString().slice(0, 10)} value={birthDate} onChange={e => setBirthDate(e.target.value)} disabled={loading} data-testid="input-settings-birthdate" />
            </div>
            <div className="field">
              <label>Numéro de téléphone</label>
              <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} disabled={loading} data-testid="input-settings-phone" />
            </div>
          </div>

          <div className="field">
            <label>Adresse e-mail</label>
            <input value={profile.email} readOnly disabled className="static-field" style={{ cursor: 'not-allowed', opacity: 0.7 }} />
            <small className="field-hint">Adresse utilisée pour la connexion.</small>
          </div>

          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', paddingTop: 20, borderTop: '1px solid hsl(var(--border))' }}>
            <button type="submit" className="button button-primary" disabled={loading} data-testid="button-save-settings">
              {loading ? 'Enregistrement...' : 'Enregistrer les modifications'}
            </button>
          </div>
        </form>

        <div className="settings-bottom-grid">
          <div className="card card-pad">
            <div className="section-head" style={{ marginBottom: 16 }}>
              <h3 className="section-title">Préférences</h3>
            </div>
            
            <div className="field">
              <label>Langue</label>
              <select value={language} onChange={e => setLanguage(e.target.value)} disabled={loading} data-testid="select-settings-language">
                <option value="fr">Français</option>
                <option value="en">English</option>
              </select>
            </div>
            <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
              <input type="checkbox" id="notif-toggle" checked={notificationsEnabled} onChange={e => setNotificationsEnabled(e.target.checked)} disabled={loading} style={{ width: 'auto', margin: 0 }} data-testid="checkbox-settings-notifications" />
              <label htmlFor="notif-toggle" style={{ margin: 0, cursor: 'pointer' }}>Activer les notifications</label>
            </div>
          </div>

          <div className="card card-pad">
            <div className="section-head" style={{ marginBottom: 12 }}>
              <h3 className="section-title">Conformité</h3>
            </div>
            <div className="activity-row" style={{ borderBottom: 0, paddingBottom: 0, paddingTop: 0 }}>
              <div className="activity-main">
                <div className="activity-icon"><ShieldCheck size={16} /></div>
                <div>
                  <div className="activity-name">Vérification KYC</div>
                  <div className="activity-meta">Statut de votre identité</div>
                </div>
              </div>
              <span className={\`pill \${kycVerified ? 'pill-success' : 'pill-pending'}\`} style={{ marginLeft: 10 }}>
                {kycLabel}
              </span>
            </div>
            <Link href="/app/kyc" className="button button-ghost button-wide" style={{ marginTop: 24 }} data-testid="link-settings-kyc">
              Voir ou modifier les informations KYC
            </Link>
          </div>
        </div>

        <div className="settings-danger-zone">
          <div>
            <div style={{ fontWeight: 700, color: 'hsl(var(--destructive))', marginBottom: 4 }}>Déconnexion</div>
            <div style={{ fontSize: 13, color: 'hsl(var(--destructive) / 0.8)' }}>Ferme la session actuelle de manière sécurisée.</div>
          </div>
          <button className="button button-danger" onClick={signOut} data-testid="button-logout-settings"><LogOut size={15} /> Quitter</button>
        </div>
      </div>
    </main>
  );
}

function AdminFeeSettings() {`;

const updated = content.replace(regex, replacement);
fs.writeFileSync('artifacts/mulapay/src/App.tsx', updated);
console.log('Update successful');
