-- ============================================================================
-- Assertions de sécurité.
--
-- Cette migration n'altère rien : elle échoue si une invariante de sécurité
-- est violée. Elle rejoue à chaque `db push` et sert donc de test permanent.
--
-- La faute classique sur Supabase est de créer une table sans RLS : PostgREST
-- la publie aussitôt, et la clé publishable — qui vit dans le navigateur —
-- suffit alors à tout lire.
-- ============================================================================

do $$
declare
  unprotected text[];
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity
    -- Table interne du CLI Supabase, hors du schéma applicatif.
    and c.relname <> 'schema_migrations';

  if array_length(unprotected, 1) > 0 then
    raise exception
      'RLS désactivée sur : %. Toute table du schéma public est exposée via PostgREST.',
      array_to_string(unprotected, ', ');
  end if;
end;
$$;


-- `spotify_accounts` contient les refresh tokens chiffrés. La table doit rester
-- sans aucune policy : même son propriétaire ne doit pas pouvoir la lire depuis
-- le navigateur. Seul service_role, côté serveur, y accède.
do $$
declare
  policy_count integer;
begin
  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public' and tablename = 'spotify_accounts';

  if policy_count > 0 then
    raise exception
      'spotify_accounts porte % policy(ies). Cette table doit rester inaccessible au rôle authenticated.',
      policy_count;
  end if;
end;
$$;


-- Toute table portant une colonne `user_id` doit filtrer dessus dans ses
-- policies, sans quoi un utilisateur connecté lit les données des autres.
do $$
declare
  offending text[];
begin
  select coalesce(array_agg(distinct t.tablename order by t.tablename), '{}')
    into offending
  from pg_policies t
  join information_schema.columns col
    on col.table_schema = t.schemaname
   and col.table_name = t.tablename
   and col.column_name = 'user_id'
  where t.schemaname = 'public'
    and t.cmd in ('SELECT', 'ALL', 'UPDATE', 'DELETE')
    and coalesce(t.qual, '') not like '%user_id%';

  if array_length(offending, 1) > 0 then
    raise exception
      'Policies sans filtre sur user_id : %.',
      array_to_string(offending, ', ');
  end if;
end;
$$;
