# Déployer sur Vercel

Ordre imposé : les étapes 2 et 3 dépendent de l'URL que Vercel attribue au
premier déploiement.

## 1. Importer le projet

Sur <https://vercel.com/new>, importer `<votre-compte>/<votre-fork>`. Next.js est
détecté automatiquement — ne rien changer aux commandes de build.

## 2. Variables d'environnement

À coller dans **Settings → Environment Variables**, pour les trois
environnements (Production, Preview, Development).

Les cinq premières sont **obligatoires** : elles sont validées par le proxy, qui
s'exécute sur chaque requête. S'il en manque une, toute l'application répond en
erreur, pas seulement la page concernée.

| Variable | Valeur | Obligatoire |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<votre-projet>.supabase.co` | ✅ |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | la clé publishable du projet Supabase | ✅ |
| `SUPABASE_SECRET_KEY` | la clé `service_role` | ✅ |
| `TOKEN_ENCRYPTION_KEY` | **reprendre celle de `.env.local`** — voir l'avertissement ci-dessous | ✅ |
| `CRON_SECRET` | reprendre celle de `.env.local` | ✅ |
| `SPOTIFY_CLIENT_ID` | `5839754b12e941caa677dd023df8fbbc` | pour l'auth |
| `SPOTIFY_CLIENT_SECRET` | depuis le dashboard Spotify | pour l'auth |
| `MUSICBRAINZ_USER_AGENT` | `NextTrack/0.1 ( you@example.com )` | recommandé |
| `ANTHROPIC_API_KEY` | pour le moteur IA | optionnel |
| `LASTFM_API_KEY` | pour les tags et la similarité | optionnel |

> ⚠️ **`TOKEN_ENCRYPTION_KEY` doit être identique partout.** C'est elle qui
> déchiffre les refresh tokens Spotify en base. En générer une nouvelle pour la
> production rendrait illisibles tous les tokens déjà stockés : chaque
> utilisateur devrait se reconnecter, sans message d'erreur explicite.

`NEXT_PUBLIC_SITE_URL` n'a pas besoin d'être définie : les routes OAuth
utilisent l'origine de la requête et suivent donc automatiquement l'URL Vercel,
y compris sur les déploiements de preview.

## 3. Supabase — le piège qui coûte le plus de temps

Une fois l'URL Vercel connue, dans **Authentication → URL Configuration** :

- **Site URL** : `https://<votre-app>.vercel.app`
- **Redirect URLs** : ajouter les deux
  - `https://<votre-app>.vercel.app/**`
  - `http://127.0.0.1:3000/**`

Sans cette liste, Supabase refuse la redirection après l'authentification
Spotify et renvoie l'utilisateur sur la page d'accueil sans explication — le
symptôme ressemble à un bug de l'application alors que c'est une configuration
manquante.

Puis dans **Authentication → Providers → Spotify** : activer le fournisseur et
coller le Client ID et le Client Secret de l'application Spotify.

## 4. Autoriser les comptes Spotify

Sur le dashboard Spotify, onglet **User Management**, ajouter le nom et
l'adresse e-mail **exacte du compte Spotify** de chaque utilisateur — cinq au
maximum, c'est le plafond du mode développement.

Un compte absent de cette liste franchit l'écran d'autorisation sans erreur,
puis reçoit un 403 sur chaque appel API. L'application détecte ce cas et
l'explique, mais l'ajout reste manuel.

## 5. Planifier la collecte

Sur un compte **Pro**, rien à faire : `vercel.json` déclare déjà le job, et
Vercel envoie `CRON_SECRET` en Bearer token à chaque déclenchement.

```json
{ "crons": [{ "path": "/api/cron/poll", "schedule": "*/10 * * * *" }] }
```

Vérifier dans **Settings → Cron Jobs** que le job apparaît et que la
fonctionnalité est activée.

Sur un compte **Hobby**, les crons sont plafonnés à une exécution par jour — ce
qui ne suffit pas, `/me/player/recently-played` ne retenant que 50 écoutes. Il
faut alors un déclencheur externe : voir [scheduler.md](scheduler.md).

## 6. Vérifier le déploiement

```bash
# Doit répondre 404 sans le secret — l'endpoint ne s'annonce pas
curl -s -o /dev/null -w "%{http_code}\n" https://<votre-app>.vercel.app/api/cron/poll

# Doit répondre 200 avec le secret
curl -s -w "\n%{http_code}\n" https://<votre-app>.vercel.app/api/cron/poll \
  -H "Authorization: Bearer <CRON_SECRET>"
```

Puis, dans l'application : se connecter avec Spotify, lancer une
synchronisation, et vérifier que les écoutes remontent.

## Ce qui restera limité

Le mode développement de Spotify est définitif pour un particulier : cinq
comptes, ajoutés à la main. Le mode « extended quota » est réservé aux
organisations d'au moins 250 000 utilisateurs actifs mensuels. L'application est
construite en multi-comptes propre — si cette porte se rouvre un jour, il n'y
aura rien à réécrire.
