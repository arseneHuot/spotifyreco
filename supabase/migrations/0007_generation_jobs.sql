-- ============================================================================
-- Générations suivies.
--
-- Une génération IA dure deux à trois minutes, quand la fonction qui la porte
-- est coupée à cinq. Tant qu'elle vivait dans la requête HTTP, l'utilisateur
-- attendait devant un écran figé et perdait tout en rechargeant la page — et
-- une coupure du serveur ne laissait aucune trace de ce qui s'était passé.
--
-- L'état de la génération devient donc une donnée. Le travail continue après
-- la réponse, écrit son avancement ici, et l'interface le lit. Rafraîchir la
-- page ou revenir plus tard retrouve la génération là où elle en est.
-- ============================================================================

create type public.generation_status as enum (
  'running',  -- en cours : `progress` et `step` sont à jour
  'done',     -- terminée ; `batch_id` pointe le groupe produit, s'il y en a un
  'failed'    -- abandonnée ; `error` dit pourquoi
);

create table public.generation_jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,

  -- Rappelés pour que l'interface puisse décrire la tâche sans la relancer.
  engine      text not null,
  name        text,

  status      public.generation_status not null default 'running',

  -- Position de la barre, entre 0 et 1, et libellé de l'étape en cours.
  progress    real not null default 0,
  step        text,

  -- Renseignés à l'arrivée. `batch_id` reste nul quand la génération aboutit
  -- sans rien produire — un profil trop mince, par exemple.
  batch_id    uuid,
  result      jsonb,
  error       text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.generation_jobs is
  'Génération de recommandations suivie hors de la requête HTTP : elle survit
   au rechargement de la page et garde une trace de son issue.';

-- L'interface ne demande qu'une chose : la dernière génération de
-- l'utilisateur. L'index la sert directement.
create index generation_jobs_user_idx
  on public.generation_jobs (user_id, created_at desc);

alter table public.generation_jobs enable row level security;

-- Lecture seule pour le porteur du jeton : tout ce qui écrit ici est le
-- serveur, via la clé de service.
create policy "générations visibles par leur propriétaire"
  on public.generation_jobs for select to authenticated
  using ((select auth.uid()) = user_id);
