# Administration Mulapay

## Accès et rôles

L’administration est disponible sur `/admin` après connexion Clerk. Une clé API de marchand n’accorde jamais un accès administrateur.

- **SUPER_ADMIN** : configuration financière, ajustements de wallets, comptes marchands, agrégateurs, routes, liste noire, révocations, communications et conformité.
- **ADMIN** : consultation, décisions manuelles KYC et échanges, communications, procédure de récupération et déclaration des sites API. Les réglages sensibles restent en lecture seule.
- **USER** : aucun accès aux routes d’administration, même en appelant directement l’API.

Les permissions sont contrôlées côté serveur, indépendamment des boutons affichés.

## Les rubriques

Dashboard, marchands, vérification KYC, transactions, wallets par pays, échanges wallet, agrégateurs, opérateurs par pays, clés API, liens de paiement, liste noire, messages marchands, notifications et paramètres. La déconnexion demande confirmation.

Toutes les listes utilisent les données PostgreSQL. Les recherches et filtres portent sur les enregistrements disponibles, puis sont paginés. Les historiques des clés et liens sont consultables dans leurs détails.

## Soldes et comptabilité

- Les fonds disponibles des wallets marchands ne sont **pas** présentés comme une trésorerie détenue par Mulapay chez un PSP. La trésorerie reste « Indisponible » tant qu’aucune donnée vérifiée ne permet de l’afficher.
- Un crédit/débit manuel exige un wallet, un montant entier, un motif et une confirmation. La modification du solde, le grand livre et le journal d’audit sont atomiques. Une même clé d’idempotence ne peut pas créditer deux fois.
- Un débit ne peut pas consommer les fonds réservés. Les fonds d’un dépôt en attente ne diminuent pas le disponible.
- Les frais Payin/Payout spécifiques au marchand sont indépendants. Un champ vide signifie « hériter du taux global ». Les montants et frais déjà capturés par une transaction ne sont pas recalculés après un changement de taux.
- Un échange peut être approuvé/rejeté une seule fois ; le refus libère la réservation. Un refus KYC/échange exige un motif.
- Les statistiques financières séparent les montants confirmés, les demandes du jour et les commissions. Une remise à zéro ne change que le début de la période de reporting, pas les soldes ni les historiques.
- Les ajustements manuels ne gonflent pas les volumes et commissions des paiements.
- Les indicateurs monétaires du dashboard sont en XOF. La rubrique wallets conserve des totaux distincts pour chaque devise, sans les additionner.

## Comptes et identité

La suspension bloque l’accès et révoque les clés actives. La réactivation ne restaure pas les clés révoquées. La fermeture définitive conserve le compte technique et les références financières ; elle exige des soldes et réservations nuls. Un compte fermé ne peut pas être réactivé. L’administrateur ne peut pas se fermer lui-même ni supprimer le dernier super administrateur actif.

Une nouvelle adresse e-mail non vérifiée est ajoutée comme adresse secondaire dans Clerk. L’adresse locale actuelle reste active. Le marchand passe par **Sécurité > Gérer mes adresses e-mail**, vérifie la nouvelle adresse, la définit comme principale, puis utilise **Synchroniser mon adresse principale**. Le serveur n’accepte alors que l’adresse principale vérifiée par Clerk.

La procédure de récupération envoyée par l’administration ne définit pas de mot de passe partagé et ne force pas artificiellement une déconnexion. Le marchand termine lui-même la récupération Clerk.

## Routage et maintenance

Chaque couple pays/opérateur a un routage, un agrégateur, un état et un plafond journalier facultatif. Les réservations de capacité sont atomiques et comprennent les opérations en attente. Une réponse fournisseur incertaine conserve la réservation ; elle ne permet pas de soumettre de nouveau la même demande. Les échecs définitifs libèrent la capacité. Le jour est celui d’Africa/Lome.

L’arrêt d’un agrégateur, la désactivation d’une route, les restrictions du marchand et les maintenances sont appliqués aux demandes réelles, y compris à l’API et aux liens publics. Ils ne bloquent jamais les confirmations des transactions déjà soumises. Les PSP restent des détails internes, absents de la documentation partenaire.

### DrimPay — production uniquement

L’intégration suit la documentation officielle [DrimPay Pay-in](https://docs.drimpay.com/fr/docs/payin) et [DrimPay Pay-out](https://docs.drimpay.com/fr/docs/payout). Elle ne propose aucun mode Sandbox.

- API de production : `https://drimpay.com/api/v2`.
- Pay-in : `POST /payin/initiate`; suivi : `GET /payin/:reference`. `order_id` sert de référence idempotente.
- Pay-out : `POST /payout/initiate`; suivi : `GET /payout/:reference`. Mulapay transmet la référence interne sous `external_ref`.
- La clé serveur doit commencer par `dp_live_sk_`. Le webhook doit avoir une URL HTTPS publique.
- Le secret de signature webhook est distinct de la clé API et doit correspondre à cette clé DrimPay. La signature `X-DrimPay-Signature` couvre le timestamp et le corps HTTP brut avec HMAC-SHA256. Mulapay refuse les événements expirés, mal formés ou qui n’indiquent pas le mode `live`.
- Le routage DrimPay refuse les opérateurs/pays absents du contrat documenté : TG, BJ, BF, ML, SN et CI, avec validation de l’opérateur pour chaque pays.

Les trois paramètres serveur requis sont `DRIMPAY_API_KEY`, `DRIMPAY_WEBHOOK_SECRET` et `DRIMPAY_WEBHOOK_URL`. Le bouton d’activation reste bloqué tant qu’ils ne sont pas tous configurés. Même avec ces valeurs, l’API DrimPay Live ne peut pas être appelée depuis l’aperçu de développement ; elle s’active uniquement en production.

Une révocation administrative de lien ou de clé est définitive. Les suppressions de liens/clés par les marchands conservent les enregistrements historiques. La liste noire utilise des numéros internationaux normalisés et s’applique également aux nouveaux comptes correspondants.

## Messages e-mail

L’adaptateur d’envoi utilise **Resend**, avec une adresse d’expédition vérifiée :

- `RESEND_API_KEY` dans les secrets ;
- `MAIL_FROM` pour l’expéditeur vérifié.

Ne jamais saisir une clé dans le chat ou dans un formulaire ordinaire. Sans ces paramètres, les envois et récupérations par e-mail sont refusés explicitement.

Les messages sont persistés par destinataire : `QUEUED`, `SENDING`, `SENT` ou `FAILED`. `SENT` signifie que Resend a accepté le message, pas qu’il a été lu ou reçu en boîte principale. Les erreurs ou réponses incertaines ne sont pas relancées automatiquement. L’idempotence protège la mise en file contre un rejeu de la même demande.

Les annonces marchands sont distinctes des e-mails. Elles apparaissent sur `/app` et leur fermeture est enregistrée individuellement. La suppression d’une annonce arrête son affichage sans effacer les traces de fermeture.

## Telegram

Le Bot Token et le Chat ID se configurent depuis Paramètres. `ADMIN_ENCRYPTION_KEY`, fourni dans les secrets et conservé durablement, chiffre la configuration au repos avec AES-256-GCM. Le bot ne peut pas être déchiffré si cette clé est perdue/remplacée ; il faudra alors enregistrer à nouveau sa configuration.

Les identifiants enregistrés ne sont jamais renvoyés au navigateur, ni inscrits dans le journal d’audit. Le bouton de test exige une confirmation réelle de Telegram. Les notifications envoyées sont suivies durablement ; un verrou empêche plusieurs processus d’envoyer simultanément la même notification. Comme toute API sans idempotence externe, une interruption entre envoi et confirmation peut nécessiter une vérification manuelle.

## Base et vérification

Les tables d’administration déjà présentes dans Supabase sont réutilisées. La migration `lib/db/migrations/20261123_admin_console.sql` est additive et rejouable ; elle ne supprime aucun enregistrement.

Vérifications :

```sh
pnpm run typecheck
NODE_ENV=development pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/src/services/adminConsole.test.ts ../artifacts/api-server/src/services/drimpay.test.ts ../artifacts/api-server/src/lib/registrationProfile.test.ts ../artifacts/api-server/src/lib/clerkConfiguration.test.ts
```

Les tests de service utilisent uniquement leurs propres comptes synthétiques et n’appellent ni PSP ni service d’e-mail. Les tests financiers et de concurrence sont nettoyés sans toucher aux comptes réels.
