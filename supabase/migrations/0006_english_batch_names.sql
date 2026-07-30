-- Passage de l'interface en anglais : les noms de groupes déjà enregistrés
-- restaient en français, puisqu'ils sont figés en base au moment de la
-- génération et non recalculés à l'affichage.
--
-- Seuls les noms **par défaut** sont réécrits. Un groupe nommé par
-- l'utilisateur lui appartient : le traduire serait réécrire son intention.
-- Le motif de reconnaissance est donc strict — c'est exactement ce que
-- produisait `defaultBatchName()` avant ce changement.
--
-- Le nom est régénéré depuis `created_at` plutôt que traduit mot à mot, ce qui
-- évite d'avoir à mapper les noms de mois français. Le fuseau est celui de
-- l'affichage, pour que la date portée par le nom reste celle que
-- l'utilisateur a vue.

update public.reco_batches
set name =
  case kind
    when 'auto_daily' then 'Daily mix — '
    when 'auto_refill' then 'Refill — '
    else 'Selection — '
  end
  || to_char(created_at at time zone 'Europe/Paris', 'FMDD FMMonth')
where name ~ '^(Sélection|Réassort) du \d';
