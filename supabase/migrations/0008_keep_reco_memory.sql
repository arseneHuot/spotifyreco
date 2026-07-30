-- ============================================================================
-- La suppression d'un groupe ne doit pas effacer la mémoire anti-répétition.
--
-- Le filtre « pas de retour avant dix jours » s'appuie sur l'historique des
-- recommandations. Or supprimer un groupe cascadait sur ses recommandations :
-- ses morceaux redevenaient « jamais proposés » et revenaient dès le lot
-- suivant — constaté après la suppression des lots d'essai, dont les morceaux
-- ont tous été re-proposés le lendemain.
--
-- Les recommandations survivent donc à leur groupe, orphelines : l'interface
-- les ignore (elle n'affiche que les groupes existants), mais le filtre
-- continue de les voir.
-- ============================================================================

alter table public.recommendations
  alter column batch_id drop not null;

alter table public.recommendations
  drop constraint recommendations_batch_fk;

alter table public.recommendations
  add constraint recommendations_batch_fk
  foreign key (batch_id) references public.reco_batches(id) on delete set null;

comment on column public.recommendations.batch_id is
  'Groupe d''origine. NULL quand le groupe a été supprimé : la ligne reste pour
   nourrir la mémoire anti-répétition et le profil de goût.';
