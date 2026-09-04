# Mulapay — guide de mise en production

## État actuel

Mulapay utilise Clerk comme unique système d’authentification. Les routes API et le dashboard exigent une session Clerk valide. Le compte administrateur de démonstration, le stockage de session local et les données seedées de démonstration ont été retirés.

Les wallets sont créés avec un solde nul pour chaque pays V1 :

- Togo
- Bénin
- Côte d’Ivoire
- Burkina Faso
- Sénégal
- Mali
- Niger

Les écrans utilisateur couvrent le dashboard, les wallets, dépôt, retrait, transactions, envoi, réception, échange, paiements, liens, QR, API partenaire, documents, notifications, KYC, sécurité, profil et support.

## Authentification

1. L’utilisateur arrive sur `/`.
2. Il crée son compte via `/sign-up`.
3. Clerk gère l’e-mail/téléphone, OTP, récupération et sessions.
4. Après connexion, Mulapay charge `/api/v1/bootstrap`.
5. Une session absente reçoit `401` sur l’API et est redirigée vers `/sign-in`.

Les rôles administrateur sont lus depuis `mulapay_users.role`. Aucun rôle administrateur n’est attribué automatiquement en développement.

## Argent réel et Drimpay

Les routes suivantes existent et échouent volontairement sans créditer ni débiter de wallet tant que le contrat Drimpay n’est pas configuré :

- `POST /api/v1/deposits`
- `POST /api/v1/withdrawals`

Cette protection est importante : une redirection navigateur ou une réponse inventée ne doit jamais créer d’écriture financière.

Avant d’activer Drimpay, récupérer depuis l’espace fournisseur :

- base URL sandbox et production ;
- authentification et en-têtes ;
- endpoint de création Payin ;
- endpoint de création Payout ;
- identifiant de transaction fournisseur ;
- endpoint de consultation de statut ;
- URL et contenu des webhooks ;
- algorithme de signature ;
- politique de retry ;
- pays, devises et opérateurs autorisés ;
- frais, limites et délais.

Les clés et tokens doivent être enregistrés dans les secrets Replit, jamais dans Git, le PDF, le frontend ou le chat.

## Règles financières obligatoires

- Créditer un wallet uniquement après un webhook fournisseur vérifié ou une vérification serveur équivalente.
- Débiter un retrait uniquement après acceptation du contrôle de solde, KYC, limites et fraude.
- Exiger `Idempotency-Key` pour toute opération sensible.
- Conserver l’identifiant fournisseur et la référence Mulapay.
- Inscrire chaque variation dans le ledger dans la même transaction PostgreSQL que la mise à jour du wallet.
- Ne jamais faire confiance à une redirection frontend pour confirmer un paiement.
- Journaliser les événements, erreurs, retries et décisions admin.

## API partenaire

La base publique prévue est `/api/v1`. Les clés partenaires doivent être :

- limitées par scopes ;
- révocables ;
- rotatives ;
- hachées ou chiffrées côté serveur ;
- jamais renvoyées au frontend après leur création.

Les webhooks partenaires doivent être signés, idempotents, rejouables et consultables dans l’espace admin.

## Vérification avant production

- Configurer les clés Clerk de production.
- Configurer les secrets Drimpay après validation du contrat.
- Tester chaque pays et chaque opérateur en sandbox.
- Tester les doublons de webhook.
- Tester les timeouts et retries.
- Tester les paiements échoués, expirés, annulés et remboursés.
- Vérifier le rapprochement PSP/ledger.
- Vérifier les limites par pays et statut KYC.
- Faire valider le cadre réglementaire et les partenaires autorisés dans chaque pays.
- Ne pas présenter Mulapay comme un établissement de paiement si la licence n’est pas détenue.
