# Déployer Mulapay sur Plesk

Ce dépôt est un workspace pnpm : l’application web et l’API doivent être construites ensemble. Ne lancez pas `npm install` à la racine et ne déployez pas seulement le dossier `artifacts/mulapay`.

## 1. Paramètres Git

- Connectez le dépôt GitHub dans Plesk.
- Déployez le dépôt dans son dossier racine, celui qui contient `pnpm-lock.yaml`.
- Dans les actions de déploiement après le pull, ajoutez :

```sh
sh scripts/plesk-build.sh
```

Le script installe les dépendances du workspace avec pnpm, construit le client Mulapay et l’API, et s’arrête avec une erreur explicite si la clé publique Clerk de production n’est pas disponible pendant le build.

Installez pnpm 10 pour l’utilisateur du site si Plesk ne fournit pas déjà `pnpm` ou Corepack. Le projet utilise pnpm et son installation racine refuse volontairement npm/yarn.

## 2. Paramètres Node.js

Dans **Plesk → Node.js** :

- Version : **Node.js 20.x**.
- Racine de l’application : racine du dépôt Git.
- Fichier de démarrage : `plesk-start.mjs`.
- Racine des documents : `artifacts/mulapay/dist/public`.
- Mode : production.
- Activez SSL pour le domaine avant d’activer les paiements ou les webhooks.
- Ne définissez pas un port fixe dans le code. L’application écoute le `PORT` fourni par Plesk/Passenger.
- Après un pull réussi, utilisez **Restart App**.

Ajoutez ces variables d’environnement dans la configuration Node.js Plesk :

| Variable | Obligatoire | Utilisation |
| --- | --- | --- |
| `NODE_ENV` | Oui | `production` |
| `PLESK_SERVE_FRONTEND` | Oui | `true`, sert l’interface et ses routes SPA depuis l’API |
| `CLERK_PUBLISHABLE_KEY` | Oui | Clé publique Clerk de production utilisée par l’API |
| `CLERK_SECRET_KEY` | Oui | Clé secrète Clerk de production |
| `SUPABASE_DATABASE_URL` | Oui | Connexion à la base Supabase de production |
| `ADMIN_ENCRYPTION_KEY` | Oui | Même clé que celle utilisée pour chiffrer les réglages administrateur existants |
| `SUPABASE_URL` | Pour le KYC | URL du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Pour le KYC | Clé serveur privée pour le bucket KYC |
| `DRIMPAY_API_KEY` | Pour DrimPay | Clé API Live DrimPay |
| `DRIMPAY_WEBHOOK_SECRET` | Pour DrimPay | Secret correspondant à la clé DrimPay |
| `DRIMPAY_WEBHOOK_URL` | Pour DrimPay | URL HTTPS publique terminant par `/api/v1/webhooks/drimpay` |
| `ASHTECHPAY_API_KEY` | Pour AshtechPay | Clé serveur AshtechPay |
| `ASHTECHPAY_WEBHOOK_URL` | Pour AshtechPay | URL HTTPS publique de webhook AshtechPay |
| `RESEND_API_KEY` et `MAIL_FROM` | Pour les e-mails marchands | Envoi des e-mails transactionnels |
| `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID` | Pour Telegram | Notifications administrateur |
| `LOG_LEVEL` | Non | Niveau de journalisation; défaut `info` |

La variable `VITE_CLERK_PUBLISHABLE_KEY` est nécessaire **au moment du build**, car Vite l’intègre au client web. Fournissez-la aussi à l’action de déploiement qui exécute `scripts/plesk-build.sh`. Elle doit commencer par `pk_live_`. Ne fournissez jamais `CLERK_SECRET_KEY`, les clés Supabase serveur ou les secrets PSP au build du navigateur.

Ne copiez aucun secret dans GitHub, dans un fichier suivi par Git ou dans le code. Ajoutez les valeurs dans les variables d’environnement Plesk; ne changez pas `ADMIN_ENCRYPTION_KEY` si des réglages chiffrés existent déjà.

## 3. Clerk, Supabase et webhooks

- Dans Clerk, autorisez le domaine public réellement utilisé par Mulapay et vérifiez que les deux clés configurées sont du même environnement Live.
- Utilisez la base Supabase de production déjà associée au projet. Vérifiez que les tables sont présentes avant d’ouvrir le site; n’exécutez pas une commande destructive de synchronisation de schéma au déploiement.
- Configurez le webhook DrimPay avec l’URL HTTPS de production `/api/v1/webhooks/drimpay`, puis utilisez le secret associé à ce webhook dans Plesk. Mulapay ne bascule pas sur Sandbox.
- Le serveur refuse les appels DrimPay Live quand `NODE_ENV` n’est pas `production`.

## 4. Déploiements suivants

1. Envoyez les changements sur GitHub.
2. Dans Plesk, cliquez **Pull + Deploy Now**. L’action `sh scripts/plesk-build.sh` doit apparaître dans les journaux et terminer avec `Plesk build complete`.
3. Cliquez **Restart App** dans Node.js.
4. Vérifiez le site, la connexion Clerk, l’API et les journaux Plesk avant d’activer les paiements réels.

Si le build indique que `VITE_CLERK_PUBLISHABLE_KEY` manque, ajoutez-la à l’environnement de l’action de déploiement; la variable définie uniquement pour le processus Node.js peut ne pas être héritée par l’action Git selon la configuration Plesk.
