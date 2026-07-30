-- ============================================================================
-- Groupes de recommandations.
--
-- Un lot cesse d'être un simple identifiant technique pour devenir un objet
-- nommé, que l'utilisateur retrouve et parcourt comme une playlist interne.
--
-- Trois origines, distinguées parce qu'elles ne se jugent pas de la même
-- façon : une sélection demandée explicitement n'a pas la même valeur qu'un
-- réassort automatique déclenché par une file qui se vide.
-- ============================================================================

create type public.reco_batch_kind as enum (
  'manual',      -- demandée par l'utilisateur, avec un nom qu'il a choisi
  'auto_daily',  -- sélection du jour, produite par le scheduler
  'auto_refill'  -- réassort : la file de propositions était presque épuisée
);

create table public.reco_batches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  kind        public.reco_batch_kind not null,
  created_at  timestamptz not null default now()
);

comment on table public.reco_batches is
  'Groupe de recommandations généré en une fois. Nommé pour être retrouvé et
   parcouru comme une playlist interne à l''application.';

create index reco_batches_user_idx
  on public.reco_batches (user_id, created_at desc);

-- Un même nom ne peut pas désigner deux groupes le même jour : sans cette
-- contrainte, un double clic produirait deux groupes indiscernables.
--
-- Le fuseau est fixé explicitement : `created_at::date` dépendrait du réglage
-- de la session, et Postgres refuse une expression non immuable dans un index.
create unique index reco_batches_user_name_day_idx
  on public.reco_batches (
    user_id,
    name,
    ((created_at at time zone 'UTC')::date)
  );

create policy "groupes visibles par leur propriétaire"
  on public.reco_batches for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "groupes modifiables par leur propriétaire"
  on public.reco_batches for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "groupes supprimables par leur propriétaire"
  on public.reco_batches for delete to authenticated
  using ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- Rattachement des recommandations déjà produites.
--
-- `recommendations.batch_id` existait déjà mais ne référençait rien. On crée un
-- groupe par lot existant avant de poser la contrainte, sinon elle échouerait
-- sur les données en place.
-- ----------------------------------------------------------------------------
insert into public.reco_batches (id, user_id, name, kind, created_at)
select
  r.batch_id,
  r.user_id,
  'Sélection du ' || to_char(min(r.created_at), 'DD/MM/YYYY'),
  'manual',
  min(r.created_at)
from public.recommendations r
group by r.batch_id, r.user_id
on conflict (id) do nothing;

alter table public.recommendations
  add constraint recommendations_batch_fk
  foreign key (batch_id) references public.reco_batches(id) on delete cascade;
