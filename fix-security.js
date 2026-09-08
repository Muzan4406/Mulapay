const fs = require('fs');

const content = fs.readFileSync('artifacts/mulapay/src/App.tsx', 'utf8');

const securityRegex = /function Security\(\) \{[\s\S]*?return \([\s\S]*?\n\s*\);\n\}/m;

const replacement = `function Security() {
  const { user } = useUser();
  const { signOut, toast } = useStore();
  const { sessions } = useSessionList();
  const { session: currentSession } = useSession();

  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [pinModalOpen, setPinModalOpen] = useState(false);
  
  const [passwordVal, setPasswordVal] = useState('');
  const [passwordConfirmVal, setPasswordConfirmVal] = useState('');
  
  const [pinVal, setPinVal] = useState('');
  const [pinAction, setPinAction] = useState<'create' | 'modify'>('create');
  
  const [pinStatus, setPinStatus] = useState<'loading' | 'defined' | 'undefined'>('loading');
  const [loadingAction, setLoadingAction] = useState(false);

  useEffect(() => {
    fetch('/api/v1/security/pin')
      .then(res => {
        if (res.ok) setPinStatus('defined');
        else if (res.status === 404) setPinStatus('undefined');
        else setPinStatus('undefined');
      })
      .catch(() => setPinStatus('undefined'));
  }, []);

  useEffect(() => {
    if (pinStatus === 'defined') setPinAction('modify');
    else if (pinStatus === 'undefined') setPinAction('create');
  }, [pinStatus]);

  const handleRevoke = async (sessionId: string) => {
    try {
      const sessionToRevoke = sessions?.find(s => s.id === sessionId);
      if (sessionToRevoke) {
        await sessionToRevoke.remove();
        toast('Appareil déconnecté et révoqué avec succès.');
      }
    } catch (e) {
      toast('Erreur lors de la révocation de l’appareil.');
    }
  };

  const updatePasswordRequest = async (pwd: string) => {
    if (!user) return;
    return await user.updatePassword({ newPassword: pwd });
  };
  
  const enhancedUpdatePassword = useReverification(updatePasswordRequest);

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (passwordVal.length < 8) {
      toast('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    if (passwordVal !== passwordConfirmVal) {
      toast('Les mots de passe ne correspondent pas.');
      return;
    }
    
    setLoadingAction(true);
    try {
      await enhancedUpdatePassword(passwordVal);
      toast('Mot de passe mis à jour avec succès.');
      setPasswordModalOpen(false);
      setPasswordVal('');
      setPasswordConfirmVal('');
    } catch (e: any) {
      toast(e.message || 'Échec de la modification du mot de passe.');
    } finally {
      setLoadingAction(false);
    }
  };

  const handlePinSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (pinVal.length !== 4) return;
    
    setLoadingAction(true);
    try {
      const res = await fetch('/api/v1/security/pin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinVal })
      });
      if (res.ok) {
        toast(\`Code PIN \${pinAction === 'create' ? 'créé' : 'modifié'} avec succès.\`);
        setPinModalOpen(false);
        setPinVal('');
        setPinStatus('defined');
      } else {
        toast('Erreur lors de la mise à jour du code PIN.');
      }
    } catch (e) {
      toast('Erreur réseau lors de la modification du code PIN.');
    } finally {
      setLoadingAction(false);
    }
  };
  
  const formatDate = (date: Date) => {
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <main className="page-wrap">
      <PageIntro eyebrow="Sécurité du compte" title="Accès et appareils" subtitle="Gérez vos méthodes de connexion, surveillez vos appareils et protégez vos données." />
      
      <div className="dashboard-grid" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(280px,0.85fr)' }}>
        <div>
          <div className="section-head" style={{ marginBottom: 12 }}>
            <h3 className="section-title">Authentification</h3>
          </div>
          <div className="card card-pad" style={{ padding: '8px 22px' }}>
            <div className="activity-row">
              <div className="activity-main">
                <div className="activity-icon"><KeyRound size={16} /></div>
                <div>
                  <div className="activity-name">Mot de passe</div>
                  <div className="activity-meta">Dernière modification : {user?.updatedAt ? formatDate(user.updatedAt) : 'Inconnue'}</div>
                </div>
              </div>
              <button className="button button-ghost button-sm" onClick={() => { setPasswordVal(''); setPasswordConfirmVal(''); setPasswordModalOpen(true); }} data-testid="button-modify-password">Modifier</button>
            </div>
            
            <div className="activity-row">
              <div className="activity-main">
                <div className="activity-icon"><LockKeyhole size={16} /></div>
                <div>
                  <div className="activity-name">Code PIN</div>
                  <div className="activity-meta">{pinStatus === 'loading' ? 'Chargement...' : pinStatus === 'undefined' ? 'Non défini · Requis pour les transferts rapides' : 'Défini · Utilisé pour les paiements'}</div>
                </div>
              </div>
              <button className="button button-ghost button-sm" onClick={() => setPinModalOpen(true)} disabled={pinStatus === 'loading'} data-testid="button-manage-pin">{pinAction === 'create' ? 'Créer' : 'Modifier'}</button>
            </div>
          </div>
          
          <div className="notice notice-dark" style={{ marginTop: 14 }}>
            <Shield size={14} />
            <div>La double authentification (2FA) sera bientôt disponible pour renforcer la sécurité de votre compte avec une couche de validation supplémentaire.</div>
          </div>

          <div className="section-head" style={{ marginTop: 34, marginBottom: 12 }}>
            <h3 className="section-title">Appareils connectés</h3>
          </div>
          <div className="card card-pad" style={{ padding: '8px 22px' }}>
            {sessions?.map(sess => {
              const isCurrent = sess.id === currentSession?.id;
              const deviceType = (sess as any).latestActivity?.deviceType || 'Appareil';
              const isMobile = deviceType.toLowerCase().includes('mobile') || deviceType.toLowerCase().includes('phone');
              
              return (
                <div className="activity-row" key={sess.id} data-testid={\`row-device-\${sess.id}\`}>
                  <div className="activity-main">
                    <div className="activity-icon" style={{ background: isCurrent ? 'hsl(var(--primary) / 0.1)' : 'hsl(var(--secondary))', color: isCurrent ? 'hsl(var(--primary))' : 'hsl(var(--primary))' }}>
                      {isMobile ? <Smartphone size={16} /> : <Laptop size={16} />}
                    </div>
                    <div>
                      <div className="activity-name">
                        {deviceType} {((sess as any).latestActivity?.browserName) ? \`(\${(sess as any).latestActivity.browserName})\` : ''}
                        {isCurrent && <span className="pill pill-success" style={{ marginLeft: 6 }}>Actuel</span>}
                      </div>
                      <div className="activity-meta">{((sess as any).latestActivity?.city) ? ((sess as any).latestActivity.city + ' · ') : ''}{sess.lastActiveAt ? formatDate(sess.lastActiveAt) : 'Actif'}</div>
                    </div>
                  </div>
                  {!isCurrent && <button className="button button-danger button-sm" onClick={() => handleRevoke(sess.id)} data-testid={\`button-revoke-\${sess.id}\`}>Révoquer</button>}
                </div>
              );
            })}
            {(!sessions || sessions.length === 0) && <div style={{ padding: '16px 0', fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>Chargement des appareils...</div>}
          </div>
        </div>

        <div>
          <div className="section-head" style={{ marginBottom: 12 }}>
            <h3 className="section-title">Activité récente</h3>
          </div>
          <div className="card card-pad" style={{ padding: '8px 22px' }}>
            {sessions?.slice(0, 3).map(sess => {
              return (
                <div className="activity-row" key={sess.id + '-act'}>
                  <div className="activity-main">
                    <div className="activity-icon" style={{ background: 'transparent', border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}><History size={15} /></div>
                    <div>
                      <div className="activity-name">{sess.status === 'active' ? 'Session active' : 'Session ' + sess.status}</div>
                      <div className="activity-meta">{(sess as any).latestActivity?.deviceType || 'Appareil'} {((sess as any).latestActivity?.city) ? \`(\${(sess as any).latestActivity.city})\` : ''}<br/>{sess.lastActiveAt ? formatDate(sess.lastActiveAt) : ''}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          
          <div className="card card-pad" style={{ marginTop: 16 }}>
             <div className="activity-row" style={{ borderBottom: 0, paddingBottom: 0, paddingTop: 0 }}>
               <div className="activity-main">
                 <div className="activity-icon" style={{ background: 'hsl(5 59% 49% / 0.1)', color: 'hsl(var(--destructive))' }}><LogOut size={16} /></div>
                 <div>
                   <div className="activity-name">Déconnexion globale</div>
                   <div className="activity-meta">Ferme la session actuelle.</div>
                 </div>
               </div>
               <button className="button button-danger button-sm" onClick={signOut} data-testid="button-logout">Quitter</button>
             </div>
          </div>
        </div>
      </div>

      <Dialog open={passwordModalOpen} onOpenChange={setPasswordModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mise à jour du mot de passe</DialogTitle>
            <DialogDescription>
              Saisissez votre nouveau mot de passe. Clerk vérifiera votre identité si nécessaire.
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={handlePasswordSubmit} style={{ display: 'grid', gap: 16, marginTop: 10 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Nouveau mot de passe</label>
              <input type="password" required minLength={8} value={passwordVal} onChange={e => setPasswordVal(e.target.value)} placeholder="Minimum 8 caractères" data-testid="input-new-password" disabled={loadingAction} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Confirmer le mot de passe</label>
              <input type="password" required minLength={8} value={passwordConfirmVal} onChange={e => setPasswordConfirmVal(e.target.value)} placeholder="Confirmer le mot de passe" data-testid="input-confirm-password" disabled={loadingAction} />
            </div>
            <DialogFooter style={{ marginTop: 10 }}>
              <button type="button" className="button button-ghost" onClick={() => setPasswordModalOpen(false)} disabled={loadingAction}>Annuler</button>
              <button type="submit" className="button button-primary" disabled={loadingAction}>{loadingAction ? 'Mise à jour...' : 'Enregistrer'}</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={pinModalOpen} onOpenChange={setPinModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pinAction === 'create' ? 'Création du code PIN' : 'Modification du code PIN'}</DialogTitle>
            <DialogDescription>
              Ce code à 4 chiffres sécurise vos transferts et retraits d'argent. Ne le partagez avec personne.
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={handlePinSubmit} style={{ display: 'grid', gap: 16, marginTop: 10 }}>
            <div className="field" style={{ marginBottom: 0, display: 'grid', justifyItems: 'center', margin: '15px 0' }}>
              <label style={{ marginBottom: 10 }}>Code PIN à 4 chiffres</label>
              <InputOTP maxLength={4} value={pinVal} onChange={setPinVal} data-testid="input-pin-code" disabled={loadingAction}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <DialogFooter style={{ marginTop: 10 }}>
              <button type="button" className="button button-ghost" onClick={() => setPinModalOpen(false)} disabled={loadingAction}>Annuler</button>
              <button type="submit" className="button button-primary" disabled={pinVal.length !== 4 || loadingAction} data-testid="button-confirm-pin">{loadingAction ? 'Enregistrement...' : 'Enregistrer'}</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

    </main>
  );
}`;

const updated = content.replace(securityRegex, replacement);
fs.writeFileSync('artifacts/mulapay/src/App.tsx', updated);
console.log('Update successful');
