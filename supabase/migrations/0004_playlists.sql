-- ============================================================================
-- Export d'une sélection de recommandations vers une playlist Spotify.
--
-- La playlist vit chez Spotify : c'est lui qui détient le contenu, l'ordre et
-- la suppression. On conserve malgré tout un lien local, pour une raison
-- précise : pouvoir RÉALIMENTER la même playlist au lieu d'en créer une par
-- export. Sans cette table, chaque envoi produirait « NextTrack — 28 juillet
-- 2026 », puis « NextTrack — 29 juillet 2026 », et la bibliothèque de
-- l'utilisateur se remplirait de playlists de trois morceaux.
--
-- Retrouver ces playlists côté Spotify coûterait une pagination complète de
-- GET /me/playlists à chaque export — sur un quota décompté par compte
-- développeur et partagé par tous les utilisateurs de l'app.
-- ============================================================================

create table public.playlists (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  -- Identifiant Spotify, seule clé qui compte pour les appels API ultérieurs.
  spotify_playlist_id text not null,
  -- Copie du nom au moment de l'export. Volontairement non synchronisée : si
  -- l'utilisateur renomme la playlist dans Spotify, la vérité est chez lui,
  -- mais on n'a pas de raison de dépenser une requête pour s'en apercevoir.
  name                text not null,
  -- Nombre de morceaux ENVOYÉS par NextTrack, pas la taille réelle de la
  -- playlist : l'utilisateur peut y ajouter ou retirer des titres de son côté.
  -- C'est un indicateur d'usage, pas une donnée faisant autorité.
  track_count         integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Un même utilisateur ne référence une playlist Spotify qu'une fois : c'est
  -- la cible du `upsert` fait à chaque export. La contrainte porte sur le
  -- couple et non sur `spotify_playlist_id` seul, car une playlist
  -- collaborative peut être suivie par plusieurs comptes.
  constraint playlists_user_spotify_unique unique (user_id, spotify_playlist_id)
);

comment on table public.playlists is
  'Playlists Spotify créées par NextTrack. Sert à réalimenter une playlist
   existante plutôt qu''à en créer une nouvelle à chaque export.';

comment on column public.playlists.track_count is
  'Cumul des morceaux envoyés depuis NextTrack, pas la taille réelle côté
   Spotify — l''utilisateur reste libre de modifier sa playlist.';

-- Toutes les lectures se font « les playlists de cet utilisateur, la plus
-- récemment alimentée en premier ».
create index playlists_user_idx on public.playlists (user_id, updated_at desc);


-- ----------------------------------------------------------------------------
-- RLS.
--
-- La RLS est déjà activée d'office par l'event trigger `rls_auto_enable` de la
-- migration 0001 ; on la réaffirme ici pour que la table reste protégée même si
-- ce trigger venait à disparaître. Sans RLS, PostgREST publie la table et la
-- clé publishable — qui vit dans le navigateur — suffit à lire les playlists de
-- tout le monde.
--
-- Ne PAS compter sur la migration 0002 pour l'attraper : `supabase db push`
-- n'applique que les migrations absentes de `schema_migrations`, et 0002 y est
-- déjà. Ses assertions ne rejouent donc qu'au `db reset` ou sur une base neuve,
-- pas au push de cette migration-ci. Invariante vérifiée à la main sur la base
-- distante : un INSERT anonyme via PostgREST renvoie bien
-- `42501 new row violates row-level security policy`.
--
-- Pas de policy DELETE : supprimer la ligne locale ne supprimerait rien chez
-- Spotify et ferait juste réapparaître une nouvelle playlist au prochain
-- export. Le nettoyage éventuel reste une opération serveur.
-- ----------------------------------------------------------------------------
alter table public.playlists enable row level security;

create policy "playlists visibles par leur propriétaire"
  on public.playlists for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "playlists insérables par leur propriétaire"
  on public.playlists for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "playlists modifiables par leur propriétaire"
  on public.playlists for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);


-- `updated_at` sert d'horodatage du dernier export : c'est lui qui ordonne la
-- liste proposée à l'utilisateur, d'où le trigger plutôt qu'un `now()` répété
-- dans le code applicatif.
create trigger playlists_touch_updated_at
  before update on public.playlists
  for each row execute function public.touch_updated_at();
