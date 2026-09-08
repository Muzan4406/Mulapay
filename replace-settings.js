const fs = require('fs');

const content = fs.readFileSync('artifacts/mulapay/src/App.tsx', 'utf8');

const regex = /function RealSettings\(\) \{[\s\S]*?function Settings\(\) \{[\s\S]*?\n\}/m;

const replacement = `function Settings() {
  const { profile, toast, signOut } = useStore();
  const queryClient = useQueryClient();

  const [firstName, setFirstName] = useState(profile.firstName || '');
  const [lastName, setLastName] = useState(profile.lastName || '');
  const [birthDate, setBirthDate] = useState((profile as any).birthDate || '');
  const [phone, setPhone] = useState(profile.phone || '');
  const [language, setLanguage] = useState((profile as any).language || 'fr');
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    (profile as any).notificationsEnabled ?? true
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

  const kycVerified = profile.kycStatus === 'VERIFIED';
  
  return (
    <main className="page-wrap">
      <PageIntro eyebrow="Informations personnelles" title="Compte" subtitle="Gérez votre profil et vos préférences de contact." />
      
      <div className="dashboard-grid" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(280px,0.85fr)' }}>
        <div>
          <form onSubmit={handleSave} className="card card-pad">
            <div className="section-head" style={{ marginBottom: 12 }}>
              <h3 className="section-title">Profil</h3>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="field">
                <label>Nom</label>
                <input value={lastName} onChange={e => setLastName(e.target.value)} required disabled={loading} data-testid="input-settings-lastname" />
              </div>
              <div className="field">
                <label>Prénom</label>
                <input value={firstName} onChange={e => setFirstName(e.target.value)} required disabled={loading} data-testid="input-settings-firstname" />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="field">
                <label>Date de naissance</label>
                <input type="date" value={birthDate} onChange={e => setBirthDate(e.target.value)} disabled={loading} data-testid="input-settings-birthdate" />
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

            <div className="section-head" style={{ marginTop: 24, marginBottom: 12 }}>
              <h3 className="section-title">Préférences</h3>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="field">
                <label>Langue</label>
                <select value={language} onChange={e => setLanguage(e.target.value)} disabled={loading} data-testid="select-settings-language">
                  <option value="fr">Français</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 24 }}>
                <input type="checkbox" id="notif-toggle" checked={notificationsEnabled} onChange={e => setNotificationsEnabled(e.target.checked)} disabled={loading} style={{ width: 'auto', margin: 0 }} data-testid="checkbox-settings-notifications" />
                <label htmlFor="notif-toggle" style={{ margin: 0, cursor: 'pointer' }}>Activer les notifications</label>
              </div>
            </div>

            <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="button button-primary" disabled={loading} data-testid="button-save-settings">
                {loading ? 'Enregistrement...' : 'Enregistrer les modifications'}
              </button>
            </div>
          </form>
        </div>

        <div>
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
                {kycVerified ? 'Vérifié' : 'En attente'}
              </span>
            </div>
            <Link href="/app/kyc" className="button button-ghost button-wide" style={{ marginTop: 16 }} data-testid="link-settings-kyc">
              Voir ou modifier les informations KYC
            </Link>
          </div>

          <div className="card card-pad" style={{ marginTop: 16 }}>
            <div className="activity-row" style={{ borderBottom: 0, paddingBottom: 0, paddingTop: 0 }}>
              <div className="activity-main">
                <div className="activity-icon" style={{ background: 'hsl(5 59% 49% / 0.1)', color: 'hsl(var(--destructive))' }}><LogOut size={16} /></div>
                <div>
                  <div className="activity-name">Déconnexion</div>
                  <div className="activity-meta">Ferme la session actuelle.</div>
                </div>
              </div>
              <button className="button button-danger button-sm" onClick={signOut} data-testid="button-logout-settings">Quitter</button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}`;

if (regex.test(content)) {
  const updated = content.replace(regex, replacement);
  fs.writeFileSync('artifacts/mulapay/src/App.tsx', updated);
  console.log('Update successful');
} else {
  console.log('Regex did not match.');
}
