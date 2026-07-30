-- ============================================================================
-- Provenance des recommandations.
--
-- Deux moteurs coexistent et sont comparés sur les mêmes notes :
--   'algo' — moteur maison (tags, features, MMR, bandit), déterministe et gratuit
--   'ai'   — Claude Opus 5, ancré sur un catalogue réel pour écarter les
--            morceaux hallucinés
--
-- Sans cette colonne, impossible de savoir lequel produit les meilleures notes :
-- c'est la seule façon de trancher autrement qu'à l'intuition.
-- ============================================================================

create type public.reco_engine as enum ('algo', 'ai');

alter table public.recommendations
  add column engine public.reco_engine not null default 'algo';

comment on column public.recommendations.engine is
  'Moteur ayant produit la recommandation. Sert à comparer les performances des
   deux approches sur les notes réellement attribuées.';

create index recommendations_engine_idx
  on public.recommendations (user_id, engine, status);


-- ----------------------------------------------------------------------------
-- Comparaison des deux moteurs, sur les recommandations effectivement notées.
--
-- `security_invoker` fait respecter les policies RLS de l'appelant : chacun ne
-- voit que ses propres chiffres, sans policy supplémentaire à maintenir.
-- ----------------------------------------------------------------------------
create view public.engine_performance
with (security_invoker = true)
as
select
  r.user_id,
  r.engine,
  count(*)                                              as rated_count,
  round(avg(t.rating)::numeric, 2)                      as avg_rating,
  count(*) filter (where t.rating >= 4)                 as loved_count,
  round(
    100.0 * count(*) filter (where t.rating >= 4) / nullif(count(*), 0),
    1
  )                                                     as loved_pct,
  count(*) filter (where t.rating <= 1)                 as rejected_count,
  round(avg(r.exploration)::numeric, 2)                 as avg_exploration
from public.recommendations r
join public.ratings t
  on t.user_id = r.user_id
 and t.track_id = r.track_id
where r.status = 'rated'
group by r.user_id, r.engine;

comment on view public.engine_performance is
  'Performance comparée des moteurs : note moyenne, part de morceaux adorés
   (4-5) et part de rejets (0-1), par utilisateur.';
