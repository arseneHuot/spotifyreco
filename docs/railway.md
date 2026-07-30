# Déployer sur Railway

Railway fait tourner un **processus durable**, là où Vercel exécute des
fonctions coupées net au bout d'un délai. C'est la seule différence qui compte
ici, et elle est décisive pour deux raisons :

- **La génération par IA dure deux à trois minutes.** Sur Vercel, la fonction
  était tuée à 300 s sans avoir rien écrit, et l'interface n'avait plus qu'à
  signaler une connexion perdue. Sur un processus durable, la contrainte
  disparaît.
- **Les journaux d'une tâche de fond y sont lisibles.** Le travail détaché par
  `after()` n'apparaît pas dans les journaux Vercel, ce qui rend un incident de
  génération très difficile à diagnostiquer.

En contrepartie, un processus durable coûte à l'heure et non à l'invocation.

## 1. Créer le service

Sur <https://railway.com/new>, choisir **Deploy from GitHub repo** et
sélectionner le dépôt. Railway détecte Next.js ; `railway.json` fixe déjà les
commandes de build et de démarrage, il n'y a rien à saisir.

Générer ensuite un domaine : **Settings → Networking → Generate Domain**. Cette
URL est nécessaire aux deux étapes suivantes.

## 2. Variables d'environnement

Coller le contenu de `.env.example` dans **Variables → Raw Editor**, puis
remplir. Deux valeurs diffèrent du développement local :

| Variable | Valeur |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | l'URL du domaine Railway, sans barre oblique finale |
| `ENABLE_SCHEDULER` | `true` |

`ENABLE_SCHEDULER` est le point qui distingue les deux hébergements. Sur Vercel,
`vercel.json` déclenche les routes `/api/cron/*` de l'extérieur. Railway n'a pas
d'équivalent : l'application planifie alors ses tâches elle-même, au démarrage
du serveur (`src/instrumentation.ts`). L'activer sur Vercel ferait tourner
chaque tâche deux fois.

Ne pas définir `PORT` : Railway l'injecte, et Next l'utilise.

## 3. Supabase et Spotify

Le domaine ayant changé, deux listes doivent être mises à jour — c'est l'oubli
qui coûte le plus de temps :

- **Supabase → Authentication → URL Configuration** : ajouter
  `https://<domaine-railway>/**` aux *Redirect URLs*, et régler la *Site URL*.
- **Spotify → Dashboard → Settings** : la redirect URI reste celle de Supabase
  (`https://<projet>.supabase.co/auth/v1/callback`), inchangée. Spotify ne
  connaît pas l'URL de l'application.

## 4. Vérifier

```bash
# Doit répondre 404 sans le secret — l'endpoint ne s'annonce pas
curl -s -o /dev/null -w "%{http_code}\n" https://<domaine>/api/cron/poll
```

Dans les journaux Railway, au démarrage :

```
[scheduler] tâches périodiques activées
```

La première collecte part trente secondes après le démarrage, puis toutes les
dix minutes. La sélection quotidienne se déclenche au premier passage après 6 h
(heure de Paris) : le planificateur vérifie le jour civil plutôt que de viser un
instant précis, ce qui lui évite de manquer son tour à chaque redéploiement.

## Migrer depuis Vercel

Les deux peuvent coexister le temps de vérifier. Dans ce cas, laisser
`ENABLE_SCHEDULER=false` sur Vercel et supprimer ses crons une fois Railway
confirmé — sinon les deux instances collectent en parallèle et consomment deux
fois le quota Spotify, qui est décompté par application et non par déploiement.

La base de données est la même : rien à migrer.
