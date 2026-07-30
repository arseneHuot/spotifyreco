# Planifier la collecte

Rotation a besoin d'appeler `/api/cron/poll` **toutes les 5 à 15 minutes**.

Cette fréquence n'est pas un confort. Elle découle de deux limites de l'API Spotify :

- `/me/player/recently-played` ne retient que **50 écoutes**, sans possibilité de
  remonter plus loin. Entre deux passages trop espacés, les écoutes excédentaires
  sont perdues définitivement.
- La durée réellement écoutée n'est **jamais** renvoyée par l'API. On la
  reconstruit en échantillonnant `progress_ms` pendant la lecture : plus les
  passages sont fréquents, plus la mesure est juste. Un passage par jour ne
  mesure rien du tout.

## Sur un compte Pro : Vercel Cron suffit

Le plan **Pro** autorise une exécution par minute. Le fichier `vercel.json` à la
racine déclare donc le job directement :

```json
{
  "crons": [{ "path": "/api/cron/poll", "schedule": "*/10 * * * *" }]
}
```

L'authentification est automatique : lorsqu'une variable d'environnement
`CRON_SECRET` existe sur le projet, Vercel l'envoie en `Authorization: Bearer`
sur chaque déclenchement — ce que la route vérifie déjà. Rien d'autre à câbler.

> Le plan **Hobby**, lui, plafonne à une exécution par jour avec une précision de
> ±59 minutes, et une expression plus fréquente fait échouer le déploiement. Les
> options externes ci-dessous restent valables dans ce cas.

## Option externe : cron-job.org

1. Créer un compte sur <https://cron-job.org>.
2. Nouveau cron job :
   - **URL** : `https://<votre-app>.vercel.app/api/cron/poll`
   - **Fréquence** : toutes les 10 minutes
   - **En-tête** : `Authorization: Bearer <CRON_SECRET>`
3. La valeur de `CRON_SECRET` est celle du `.env.local`, à reporter dans les
   variables d'environnement Vercel.

La route répond `404` — et non `401` — quand le secret est absent ou faux : rien
ne doit révéler l'existence de l'endpoint à un visiteur non autorisé.

## Alternative : GitHub Actions

Gratuit sur dépôt public, mais la granularité réelle est irrégulière (GitHub
retarde souvent les jobs planifiés de plusieurs minutes en période de charge).

```yaml
# .github/workflows/poll.yml
name: poll
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS -f -X GET "$URL" -H "Authorization: Bearer $SECRET"
        env:
          URL: ${{ secrets.ROTATION_POLL_URL }}
          SECRET: ${{ secrets.ROTATION_CRON_SECRET }}
```

## À ne pas faire : pg_cron dans Supabase

Tentant, mais piégeux : sur le plan gratuit, un projet Supabase est **mis en
pause après une semaine d'inactivité**. Si le planificateur vit dans la base
qu'il est censé maintenir active, une pause suffit à l'arrêter définitivement,
sans redémarrage automatique possible. Le déclencheur doit rester externe.

## Vérifier que ça tourne

```bash
curl -i "https://<votre-app>.vercel.app/api/cron/poll" -H "Authorization: Bearer <CRON_SECRET>"
```

La réponse liste, compte par compte, le nombre d'écoutes insérées et mises à
jour. Un compte en `needs_reauth` signale une autorisation Spotify expirée
(6 mois) ou révoquée : seule une reconnexion de l'utilisateur la résout, aucun
retry n'y changera rien.
