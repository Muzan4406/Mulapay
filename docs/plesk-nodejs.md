# Déployer Mulapay sur Plesk

Ce dépôt est un workspace pnpm : l’application web et l’API doivent être construites ensemble. Ne lancez pas `npm install` à la racine et ne déployez pas seulement le dossier `artifacts/mulapay`.

## 1. Paramètres Git

- Connectez le dépôt GitHub dans Plesk.
- Déployez le dépôt dans son dossier racine, celui qui contient `pnpm-lock.yaml`.
- Dans les actions de déploiement après le pull, ajoutez :

```sh
sh scripts/plesk-build.sh
```

Le script installe les dépendances du workspace avec pnpm, construit le client Mulapay et l’API, et s’arrête avec une erreur explicite si la clé publique Clerk de production n’est pas disponible pendant le build. Le workspace approuve explicitement les scripts d’installation de `@clerk/shared` et `esbuild`, dont pnpm a besoin pour préparer Clerk et construire le serveur.

Installez pnpm 10 pour l’utilisateur du site si Plesk ne fournit pas déjà `pnpm` ou Corepack. Le projet utilise pnpm et son installation racine refuse volontairement npm/yarn.

## 2. Paramètres Node.js

Dans **Plesk → Node.js** :

- Version : **Node.js 20.x recommandé** (version du workspace Replit). Le Node.js **26.13.1** affiché dans ta capture respecte les contraintes déclarées de Vite, Clerk, Express et pg, mais le build local a été vérifié sous Node 20.20.0, pas sur Plesk.
- Racine de l’application : racine du dépôt Git.
- Fichier de démarrage : `app.js`.
- Racine des documents : `artifacts/mulapay/dist/public`.
- Mode : production.
- Activez SSL pour le domaine avant d’activer les paiements ou les webhooks.
- Ne définissez pas un port fixe dans le code. L’application écoute le `PORT` fourni par Plesk/Passenger.
- Après un pull réussi, utilisez **Restart App**.

Dans la capture actuelle, `/httpdocs` correspond bien à la racine du dépôt si elle contient `package.json` et `pnpm-lock.yaml`. Le champ Startup File indique `app.js` comme manquant parce que cette version n’est pas encore présente dans le dépôt téléchargé par Plesk. Après le push et le pull du correctif, le fichier `/httpdocs/app.js` sera fourni.

Le Document Root affiché (`/httpdocs/artifacts/mulapay/public`) est le dossier source des fichiers publics, pas le résultat Vite. Après le build, le bon dossier est `/httpdocs/artifacts/mulapay/dist/public`. Il est créé par `scripts/plesk-build.sh`; configure cette racine après la première compilation si le sélecteur Plesk ne permet pas de choisir un dossier encore absent.

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

La clé publique Clerk est nécessaire **au moment du build**, car Vite l’intègre au client web. Le script lit `VITE_CLERK_PUBLISHABLE_KEY`, ou `CLERK_PUBLISHABLE_KEY` si Plesk ne transmet pas la variable Vite. Si le panneau **Run Node.js commands** ne transmet pas les variables d’environnement, crée dans le Gestionnaire de fichiers Plesk `/httpdocs/.env.production` avec cette ligne : `VITE_CLERK_PUBLISHABLE_KEY=pk_live_VOTRE_CLE_PUBLIQUE`. Le script accepte aussi le fichier `/httpdocs/artifacts/mulapay/.env.production`, avec ou sans guillemets autour de la valeur. Puis lance normalement `pnpm run build:plesk`. Ces fichiers sont ignorés par Git; ne les pousse pas. La clé publique peut être intégrée au navigateur, mais n’ajoute jamais `CLERK_SECRET_KEY`, les clés Supabase serveur ou les secrets PSP à ces fichiers.

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

Si le build indique qu’aucune clé publique Clerk n’est disponible, vérifiez que `/httpdocs/.env.production` contient `VITE_CLERK_PUBLISHABLE_KEY=pk_live_...` et que le nom du fichier est exactement `.env.production`. Le champ **Run Node.js commands** peut interpréter une affectation `NOM=valeur` comme le nom d’une commande au lieu d’une variable shell : dans ce cas, lancez seulement `pnpm run build:plesk`.
