-- ============================================================================
-- NextTrack — schéma initial
--
-- Trois familles de tables :
--   1. Comptes et secrets   → accessibles uniquement au rôle service_role
--   2. Catalogue musical    → partagé entre utilisateurs, lecture pour tous
--   3. Signaux utilisateur  → strictement isolés par RLS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Garde-fou : toute nouvelle table du schéma public reçoit la RLS d'office.
-- Une table publiée par PostgREST sans RLS est lisible par n'importe quel
-- porteur de la clé publishable, qui est par définition dans le navigateur.
-- ----------------------------------------------------------------------------
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
as $$
declare
  obj record;
begin
  for obj in
    select * from pg_event_trigger_ddl_commands()
    where command_tag = 'CREATE TABLE'
      and schema_name = 'public'
  loop
    execute format('alter table %s enable row level security', obj.object_identity);
  end loop;
end;
$$;

drop event trigger if exists rls_auto_enable_trigger;
create event trigger rls_auto_enable_trigger
  on ddl_command_end
  when tag in ('CREATE TABLE')
  execute function public.rls_auto_enable();


-- ============================================================================
-- 1. COMPTES
-- ============================================================================

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is
  'Profil applicatif, en miroir de auth.users.';

create policy "profil visible par son propriétaire"
  on public.profiles for select
  using ((select auth.uid()) = id);

create policy "profil modifiable par son propriétaire"
  on public.profiles for update
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);


-- ----------------------------------------------------------------------------
-- Tokens Spotify.
--
-- RLS activée SANS AUCUNE POLICY : le rôle `authenticated` n'a donc aucun accès,
-- pas même le propriétaire de la ligne. Seul service_role (qui contourne la RLS)
-- peut lire ces colonnes, depuis le serveur. Les tokens sont en plus chiffrés
-- applicativement en AES-256-GCM, avec une clé absente de la base.
--
-- Contrainte Spotify : depuis juillet 2026 un refresh token expire 6 mois après
-- l'autorisation INITIALE, et le rafraîchir ne prolonge pas ce délai. D'où
-- `authorized_at`, qui n'est jamais mis à jour par un refresh.
-- ----------------------------------------------------------------------------
create type public.spotify_account_status as enum (
  'active',        -- tout va bien
  'needs_reauth',  -- invalid_grant : l'utilisateur doit refaire un OAuth complet
  'revoked'        -- l'utilisateur a retiré l'accès depuis son compte Spotify
);

create table public.spotify_accounts (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  spotify_user_id     text not null unique,
  email               text,
  display_name        text,
  -- 'premium' | 'free' | 'open'. Le Web Playback SDK exige 'premium'.
  product             text,
  country             text,

  access_token_enc    text not null,
  refresh_token_enc   text not null,
  access_expires_at   timestamptz not null,

  -- Début des 6 mois de validité du refresh token.
  authorized_at       timestamptz not null default now(),
  scopes              text[] not null default '{}',

  status              public.spotify_account_status not null default 'active',
  last_error          text,
  last_refreshed_at   timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on column public.spotify_accounts.authorized_at is
  'Date de l''autorisation initiale. Le refresh token expire 6 mois après, et un
   refresh ne prolonge PAS ce délai — il faut une réautorisation utilisateur.';

-- Aucune policy : table volontairement inaccessible au rôle authenticated.


-- ============================================================================
-- 2. CATALOGUE MUSICAL (partagé)
--
-- Lecture ouverte à tout utilisateur connecté, écriture réservée au serveur.
-- Mutualiser le catalogue évite de refaire les mêmes appels API pour chaque
-- utilisateur — ce qui compte double ici, le quota Spotify étant décompté par
-- compte développeur et partagé par tous les utilisateurs de l'app.
-- ============================================================================

create table public.artists (
  id              text primary key,            -- identifiant Spotify
  name            text not null,
  image_url       text,
  -- `genres` est marqué Deprecated côté Spotify et sur la trajectoire de
  -- suppression : on le conserve à titre indicatif mais le moteur s'appuie sur
  -- `artist_tags` (Last.fm / MusicBrainz), pas sur cette colonne.
  spotify_genres  text[] not null default '{}',
  mb_artist_mbid  uuid,
  enriched_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.albums (
  id            text primary key,
  name          text not null,
  image_url     text,
  release_date  text,                          -- Spotify renvoie une précision variable
  release_year  smallint,
  total_tracks  smallint,
  created_at    timestamptz not null default now()
);

create table public.tracks (
  id                 text primary key,         -- identifiant Spotify
  name               text not null,
  album_id           text references public.albums(id) on delete set null,
  duration_ms        integer,
  isrc               text,                     -- pivot vers MusicBrainz
  explicit           boolean,
  popularity         smallint,
  mb_recording_mbid  uuid,
  enriched_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index tracks_isrc_idx on public.tracks (isrc) where isrc is not null;
create index tracks_needs_enrichment_idx on public.tracks (enriched_at nulls first);

create table public.track_artists (
  track_id   text not null references public.tracks(id) on delete cascade,
  artist_id  text not null references public.artists(id) on delete cascade,
  position   smallint not null default 0,
  primary key (track_id, artist_id)
);

create index track_artists_artist_idx on public.track_artists (artist_id);


-- ----------------------------------------------------------------------------
-- Caractéristiques audio.
--
-- Spotify a supprimé /v1/audio-features le 27/11/2024 pour toute app créée
-- après cette date. La source est donc ReccoBeats, qui expose des descripteurs
-- équivalents indexés par identifiant de piste Spotify.
-- ----------------------------------------------------------------------------
create table public.track_features (
  track_id          text primary key references public.tracks(id) on delete cascade,
  source            text not null default 'reccobeats',
  acousticness      real,
  danceability      real,
  energy            real,
  instrumentalness  real,
  liveness          real,
  speechiness       real,
  valence           real,
  loudness          real,
  tempo             real,
  key               smallint,
  mode              smallint,
  fetched_at        timestamptz not null default now()
);


-- ----------------------------------------------------------------------------
-- Tags. C'est le socle sémantique du moteur : contrairement aux genres Spotify,
-- ces données viennent de sources ouvertes (Last.fm, MusicBrainz), ce qui les
-- rend utilisables pour entraîner un modèle — la Developer Policy Spotify
-- l'interdit pour le Spotify Content.
-- ----------------------------------------------------------------------------
create table public.tags (
  id      serial primary key,
  name    text not null,
  source  text not null,                       -- 'lastfm' | 'musicbrainz'
  unique (name, source)
);

create table public.artist_tags (
  artist_id  text not null references public.artists(id) on delete cascade,
  tag_id     integer not null references public.tags(id) on delete cascade,
  weight     real not null default 1,          -- Last.fm : 0-100 normalisé en 0-1
  primary key (artist_id, tag_id)
);

create index artist_tags_tag_idx on public.artist_tags (tag_id);

create table public.track_tags (
  track_id  text not null references public.tracks(id) on delete cascade,
  tag_id    integer not null references public.tags(id) on delete cascade,
  weight    real not null default 1,
  primary key (track_id, tag_id)
);

create index track_tags_tag_idx on public.track_tags (tag_id);


-- ----------------------------------------------------------------------------
-- Similarité entre artistes, issue de ListenBrainz / Last.fm. Sert de première
-- source de candidats, remplaçant /artists/{id}/related-artists (supprimé).
-- ----------------------------------------------------------------------------
create table public.artist_similarity (
  artist_id         text not null references public.artists(id) on delete cascade,
  similar_artist_id text not null references public.artists(id) on delete cascade,
  score             real not null,
  source            text not null,
  primary key (artist_id, similar_artist_id, source),
  constraint artist_similarity_no_self check (artist_id <> similar_artist_id)
);

create index artist_similarity_lookup_idx
  on public.artist_similarity (artist_id, score desc);


-- Le catalogue est en lecture seule pour les utilisateurs ; seul le serveur y écrit.
do $$
declare t text;
begin
  foreach t in array array[
    'artists', 'albums', 'tracks', 'track_artists',
    'track_features', 'tags', 'artist_tags', 'track_tags', 'artist_similarity'
  ]
  loop
    execute format(
      'create policy "catalogue lisible par les utilisateurs connectés"
         on public.%I for select to authenticated using (true)', t);
  end loop;
end;
$$;


-- ============================================================================
-- 3. SIGNAUX UTILISATEUR
-- ============================================================================

create type public.listen_source as enum (
  'recently_played',  -- GET /me/player/recently-played : pas de durée écoutée
  'playback_sdk',     -- Web Playback SDK : durée précise à la seconde
  'now_playing'       -- GET /me/player observé par le poller : durée estimée
);

-- ----------------------------------------------------------------------------
-- Écoutes.
--
-- `ms_played` est nullable PAR CONSTRUCTION : l'API Spotify ne renvoie jamais la
-- durée réellement écoutée. Elle n'est connue que lorsque la lecture a eu lieu
-- dans NextTrack (Web Playback SDK), ou estimée en observant `progress_ms`.
-- ----------------------------------------------------------------------------
create table public.listens (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  track_id     text not null references public.tracks(id) on delete cascade,
  played_at    timestamptz not null,
  ms_played    integer,
  source       public.listen_source not null,
  context_uri  text,                          -- playlist / album d'origine
  -- Renseigné quand ms_played et duration_ms sont connus : ratio d'achèvement.
  -- < 0.3 vaut signal négatif implicite, > 0.9 signal positif.
  completion   real,
  created_at   timestamptz not null default now(),

  constraint listens_unique_play unique (user_id, track_id, played_at)
);

create index listens_user_time_idx on public.listens (user_id, played_at desc);
create index listens_user_track_idx on public.listens (user_id, track_id);

create policy "écoutes visibles par leur propriétaire"
  on public.listens for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "écoutes insérables par leur propriétaire"
  on public.listens for insert to authenticated
  with check ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- Notes explicites : 0 = insupportable, 5 = exactement ce que j'aime.
-- C'est le signal le plus fort du moteur.
-- ----------------------------------------------------------------------------
create table public.ratings (
  user_id     uuid not null references auth.users(id) on delete cascade,
  track_id    text not null references public.tracks(id) on delete cascade,
  rating      smallint not null check (rating between 0 and 5),
  -- Contexte de la notation, utile pour pondérer la confiance : une note posée
  -- après 10 secondes d'écoute vaut moins qu'après le morceau entier.
  ms_at_rating integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, track_id)
);

create index ratings_user_rating_idx on public.ratings (user_id, rating);

create policy "notes gérées par leur propriétaire"
  on public.ratings for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);


-- Morceaux likés sur Spotify (GET /me/tracks).
create table public.saved_tracks (
  user_id   uuid not null references auth.users(id) on delete cascade,
  track_id  text not null references public.tracks(id) on delete cascade,
  added_at  timestamptz not null,
  primary key (user_id, track_id)
);

create policy "likes visibles par leur propriétaire"
  on public.saved_tracks for select to authenticated
  using ((select auth.uid()) = user_id);


-- Instantanés de /me/top/{type}, conservés pour observer la dérive des goûts.
create type public.top_time_range as enum ('short_term', 'medium_term', 'long_term');

create table public.top_items (
  user_id      uuid not null references auth.users(id) on delete cascade,
  entity_type  text not null check (entity_type in ('artist', 'track')),
  entity_id    text not null,
  time_range   public.top_time_range not null,
  rank         smallint not null,
  captured_on  date not null default current_date,
  primary key (user_id, entity_type, time_range, entity_id, captured_on)
);

create policy "tops visibles par leur propriétaire"
  on public.top_items for select to authenticated
  using ((select auth.uid()) = user_id);


-- ============================================================================
-- 4. RECOMMANDATIONS
-- ============================================================================

create type public.reco_status as enum (
  'pending',    -- générée, pas encore présentée
  'served',     -- présentée à l'utilisateur
  'rated',      -- notée
  'skipped',    -- passée sans note
  'dismissed'   -- explicitement écartée
);

create table public.recommendations (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  track_id     text not null references public.tracks(id) on delete cascade,
  batch_id     uuid not null,
  score        real not null,
  -- Décomposition du score et provenance du candidat, pour pouvoir expliquer
  -- « pourquoi ce morceau » et déboguer le moteur.
  reasons      jsonb not null default '{}'::jsonb,
  -- Part d'exploration : 0 = pur exploit, 1 = pure découverte. Permet de
  -- mesurer a posteriori si l'exploration paie.
  exploration  real not null default 0,
  status       public.reco_status not null default 'pending',
  served_at    timestamptz,
  created_at   timestamptz not null default now()
);

create index recommendations_user_status_idx
  on public.recommendations (user_id, status, score desc);
create unique index recommendations_user_track_batch_idx
  on public.recommendations (user_id, track_id, batch_id);

create policy "recos visibles par leur propriétaire"
  on public.recommendations for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "recos modifiables par leur propriétaire"
  on public.recommendations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);


-- ============================================================================
-- 5. ÉTAT DES JOBS
-- ============================================================================

create table public.sync_state (
  user_id          uuid not null references auth.users(id) on delete cascade,
  job              text not null,             -- 'recently_played' | 'saved_tracks' | ...
  cursor           text,                      -- curseur `after` de Spotify
  last_run_at      timestamptz,
  last_success_at  timestamptz,
  last_error       text,
  consecutive_failures smallint not null default 0,
  primary key (user_id, job)
);

create policy "état de synchro visible par son propriétaire"
  on public.sync_state for select to authenticated
  using ((select auth.uid()) = user_id);


-- ============================================================================
-- 6. AUTOMATISMES
-- ============================================================================

-- Création du profil à l'inscription.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- Entretien de `updated_at`.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'spotify_accounts', 'artists', 'tracks', 'ratings']
  loop
    execute format(
      'create trigger %I_touch_updated_at before update on public.%I
         for each row execute function public.touch_updated_at()', t, t);
  end loop;
end;
$$;
