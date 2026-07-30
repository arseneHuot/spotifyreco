import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Mémoire anti-répétition des générations.
 *
 * Sans elle, un morceau proposé hier et resté sans écoute revenait dans chaque
 * lot : `knownTrackIds` ne couvre que ce qui a été écouté, noté ou liké, pas ce
 * qui a été proposé. Dix jours, demande explicite de l'utilisateur : au-delà,
 * une bonne suggestion ignorée mérite une seconde chance.
 */
export const NO_REPEAT_DAYS = 10;

/**
 * Deux empreintes, parce qu'une seule ne suffit pas.
 *
 * L'identifiant Spotify est exact mais myope : « The Wild Ones (Remastered) »
 * existe sous plusieurs identifiants selon l'album qui le porte, et l'un a
 * effectivement resurgi le lendemain sous sa seconde forme. Le couple
 * artiste + titre normalisé rattrape ces rééditions.
 */
export type RecentRecos = {
  trackIds: Set<string>;
  titleKeys: Set<string>;
};

/**
 * Réduit un titre à ce qui identifie la chanson.
 *
 * Les qualificatifs d'édition — « (Remastered) », « - 2013 Remaster »,
 * « (feat. …) » — varient d'une réédition à l'autre sans changer le morceau.
 * Le nettoyage est volontairement conservateur : une collision ne coûte
 * qu'une exclusion de trop, une empreinte ratée coûte une répétition.
 */
function normalizeTitle(title: string): string {
  return (
    title
      .toLowerCase()
      // « Titre - 2013 Remaster », « Titre - Radio Edit »
      .split(" - ")[0]
      // « Titre (Remastered) », « Titre (feat. X) »
      .replace(/\([^)]*\)/g, "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "")
  );
}

export function titleKey(artistId: string, title: string): string {
  return `${artistId}|${normalizeTitle(title)}`;
}

/**
 * Tout ce qui a été recommandé dans la fenêtre, tous statuts confondus : un
 * morceau écarté hier n'a pas plus sa place qu'un morceau encore en attente.
 * Les lignes orphelines — groupe supprimé — comptent aussi : effacer un groupe
 * n'est pas effacer le souvenir de ce qu'on y a vu.
 */
export async function recentlyRecommended(userId: string): Promise<RecentRecos> {
  const admin = createAdminClient();
  const cutoff = new Date(
    Date.now() - NO_REPEAT_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data } = await admin
    .from("recommendations")
    .select("track_id, tracks(name, track_artists(artist_id))")
    .eq("user_id", userId)
    .gte("created_at", cutoff);

  const trackIds = new Set<string>();
  const titleKeys = new Set<string>();

  for (const row of data ?? []) {
    trackIds.add(row.track_id);

    const track = row.tracks;
    if (!track?.name) continue;
    for (const link of track.track_artists ?? []) {
      titleKeys.add(titleKey(link.artist_id, track.name));
    }
  }

  return { trackIds, titleKeys };
}

/** Vrai si le morceau est un retour trop précoce, sous une forme ou une autre. */
export function isRecentRepeat(
  recent: RecentRecos,
  trackId: string,
  title: string | null,
  artistIds: string[],
): boolean {
  if (recent.trackIds.has(trackId)) return true;
  if (!title) return false;
  return artistIds.some((artistId) =>
    recent.titleKeys.has(titleKey(artistId, title)),
  );
}
