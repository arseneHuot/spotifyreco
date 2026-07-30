import "server-only";

import { randomUUID } from "node:crypto";

import { enrichArtistsFromLastfm, fetchSimilarArtists } from "@/lib/enrich/lastfm";
import { enrichTracksWithFeatures } from "@/lib/enrich/reccobeats";
import { upsertTracks } from "@/lib/spotify/catalog";
import { spotifyFetch } from "@/lib/spotify/client";
import { limiters } from "@/lib/rate-limit";
import type { SpotifyTrack } from "@/lib/spotify/types";
import {
  generateAiRecommendations,
  QUOTA_ABORT_THRESHOLD_MS,
  quotaMessage,
} from "@/lib/reco/ai";
import { diversifyAndExplore } from "@/lib/reco/diversity";
import { scoreCandidates } from "@/lib/reco/scoring";
import {
  buildTasteProfile,
  type Candidate,
  type PartialFeatureVector,
  type TasteProfile,
  type WeightedTag,
} from "@/lib/reco/taste";
import { milestones, type ProgressReporter } from "@/lib/reco/progress";
import {
  isRecentRepeat,
  recentlyRecommended,
  type RecentRecos,
} from "@/lib/reco/no-repeat";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TablesInsert } from "@/lib/supabase/database.types";
import { DISPLAY_TIME_ZONE } from "@/lib/format";

/**
 * Génération d'un lot de recommandations.
 *
 * Deux étages, comme tout moteur sérieux : on produit d'abord un vivier large
 * et bon marché, puis on classe finement. La particularité ici est que le
 * vivier doit être *construit*, faute de pouvoir demander des suggestions à
 * Spotify — l'endpoint `/recommendations` a été supprimé.
 *
 * Le budget d'appels Spotify est explicite et strict : le quota est décompté
 * par compte développeur et partagé par tous les utilisateurs, donc une
 * génération gourmande pénaliserait les autres comptes.
 */

/** En dessous, le profil est trop mince pour produire autre chose que du bruit. */
const MIN_SIGNALS = 5;

/**
 * En dessous de ce nombre de propositions non consommées, la file est
 * considérée comme épuisée et un réassort se déclenche en arrière-plan.
 */
export const REFILL_THRESHOLD = 5;

/**
 * Nom donné à un groupe quand l'utilisateur n'en fournit pas.
 *
 * Les groupes automatiques sont datés pour rester distinguables dans la liste ;
 * l'index unique (utilisateur, nom, jour) garantit par ailleurs qu'il ne peut
 * pas y en avoir deux identiques le même jour.
 */
function defaultBatchName(kind: BatchKind): string {
  // Le fuseau est explicite : le serveur tourne en UTC, et un groupe produit
  // après 22 h porterait sinon la date de la veille pour qui l'écoute.
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(new Date());

  switch (kind) {
    case "auto_daily":
      return `Daily mix — ${day}`;
    case "auto_refill":
      return `Refill — ${day}`;
    default:
      return `Selection — ${day}`;
  }
}

/**
 * Regénère en arrière-plan si la file de propositions est presque vide.
 *
 * Appelé après une notation : noter fait mécaniquement baisser le compteur, et
 * c'est le moment naturel pour reconstituer la file sans que l'utilisateur ait
 * à le demander.
 *
 * Renvoie `null` quand rien n'était nécessaire.
 */
export async function refillIfNeeded(
  userId: string,
): Promise<GenerationResult | null> {
  const admin = createAdminClient();

  const { count } = await admin
    .from("recommendations")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["pending", "served"]);

  if ((count ?? 0) >= REFILL_THRESHOLD) return null;

  return generateRecommendations(userId, {
    kind: "auto_refill",
    // Réassort volontairement plus court qu'une sélection demandée : il comble
    // un creux, il ne remplace pas une intention de l'utilisateur.
    k: 12,
  });
}

export type RecoEngine = "algo" | "ai" | "both";

export type BatchKind = "manual" | "auto_daily" | "auto_refill";

export type GenerationResult = {
  batchId: string | null;
  batchName: string | null;
  generated: number;
  candidatesConsidered: number;
  catalogAdded: number;
  /** Répartition du lot par moteur, pour l'affichage et la comparaison. */
  byEngine: { algo: number; ai: number };
  /** Suggestions écartées par l'ancrage, quand le moteur IA a été sollicité. */
  aiRejected?: number;
  reason?: string;
};

export async function generateRecommendations(
  userId: string,
  {
    k = 20,
    expansionBudget = 20,
    engine = "both",
    kind = "manual",
    name,
    onProgress,
  }: {
    k?: number;
    expansionBudget?: number;
    engine?: RecoEngine;
    kind?: BatchKind;
    name?: string;
    onProgress?: ProgressReporter;
  } = {},
): Promise<GenerationResult> {
  const wantsAlgoEarly = engine === "algo" || engine === "both";
  const wantsAiEarly = engine === "ai" || engine === "both";
  const mark = milestones(wantsAiEarly, wantsAlgoEarly);
  const report: ProgressReporter = onProgress ?? (() => {});

  report({ type: "step", at: mark.profile, label: "Reading your taste profile" });
  const profile = await buildTasteProfile(userId);

  if (profile.sampleSize < MIN_SIGNALS) {
    return {
      batchId: null,
      batchName: null,
      generated: 0,
      candidatesConsidered: 0,
      catalogAdded: 0,
      byEngine: { algo: 0, ai: 0 },
      reason:
        "Not enough signal yet. Listen to and rate a few tracks, then try again.",
    };
  }

  const wantsAlgo = engine === "algo" || engine === "both";
  const wantsAi = engine === "ai" || engine === "both";

  const excluded = await recentlyRecommended(userId);

  // En mode comparatif, chaque moteur fournit la moitié du lot : c'est ce qui
  // rend les deux approches comparables sur un même échantillon de notes.
  const algoQuota = engine === "both" ? Math.ceil(k / 2) : k;

  const rows: TablesInsert<"recommendations">[] = [];
  const batchId = randomUUID();
  const batchName = name?.trim() || defaultBatchName(kind);
  let catalogAdded = 0;
  let candidatesConsidered = 0;
  let aiRejected: number | undefined;
  const reasons: string[] = [];

  // --- Moteur maison --------------------------------------------------------
  if (wantsAlgo) {
    // Quota Spotify suspendu : l'expansion attendrait des heures pour rien.
    // Le moteur maison reste utile sans elle — le catalogue déjà en base
    // suffit à produire un lot, simplement sans sang neuf.
    if (limiters.spotify.pausedForMs > QUOTA_ABORT_THRESHOLD_MS) {
      reasons.push(
        `Catalogue expansion skipped: ${quotaMessage(limiters.spotify.pausedForMs)}`,
      );
    } else {
      report({
        type: "step",
        at: mark.catalog,
        label: "Widening the catalogue around your artists",
      });
      catalogAdded = await expandCatalog(userId, profile, expansionBudget);
    }

    report({
      type: "step",
      at: mark.candidates,
      label: "Gathering candidate tracks",
    });
    const candidates = await collectCandidates(profile, excluded);
    candidatesConsidered = candidates.length;

    report({
      type: "step",
      at: mark.ranking,
      label: `Ranking ${candidates.length} candidates for fit and variety`,
    });

    if (candidates.length === 0) {
      reasons.push(
        "In-house engine: no candidate available, the catalogue needs filling out.",
      );
    } else {
      const scored = scoreCandidates(candidates, profile);
      const selected = diversifyAndExplore(scored, profile, {
        k: algoQuota,
        armStats: await loadArmStats(userId),
      });

      for (const candidate of selected) {
        rows.push({
          user_id: userId,
          track_id: candidate.trackId,
          batch_id: batchId,
          score: candidate.score,
          reasons: candidate.reasons,
          exploration: candidate.exploration,
          engine: "algo",
          status: "pending",
        });
      }
    }
  }

  // --- Moteur IA ------------------------------------------------------------
  if (wantsAi) {
    const alreadyPicked = new Set(rows.map((row) => row.track_id));
    // Le quota est transmis pour que la vérification s'arrête dès qu'elle a de
    // quoi remplir le lot, au lieu d'éprouver des suggestions qu'on jetterait.
    const ai = await generateAiRecommendations(userId, profile, {
      wanted: engine === "both" ? k - rows.length : k,
      exclude: excluded,
      onProgress: report,
      milestones: mark,
    });

    aiRejected = ai.rejected;
    if (ai.reason) reasons.push(`AI engine: ${ai.reason}`);

    const aiQuota = engine === "both" ? k - rows.length : k;

    for (const recommendation of ai.recommendations.slice(0, aiQuota)) {
      // Les deux moteurs peuvent converger sur le même morceau ; le publier deux
      // fois fausserait la comparaison et gaspillerait une place dans le lot.
      if (alreadyPicked.has(recommendation.trackId)) continue;
      alreadyPicked.add(recommendation.trackId);

      rows.push({
        user_id: userId,
        track_id: recommendation.trackId,
        batch_id: batchId,
        // Le modèle ne produit pas de score comparable à celui du moteur
        // maison : on enregistre une valeur neutre et on garde l'explication.
        score: 0,
        reasons: {
          source: "claude-opus-5",
          explication: recommendation.reason,
          registre: recommendation.familiarity,
        },
        exploration: recommendation.exploration,
        engine: "ai",
        status: "pending",
      });
    }
  }

  if (rows.length === 0) {
    return {
      batchId: null,
      batchName: null,
      generated: 0,
      candidatesConsidered,
      catalogAdded,
      byEngine: { algo: 0, ai: 0 },
      aiRejected,
      reason: reasons.join(" ") || "No recommendation could be produced.",
    };
  }

  const admin = createAdminClient();

  // Le groupe existe avant ses membres : `recommendations.batch_id` porte une
  // clé étrangère, l'insertion échouerait sinon.
  //
  // Les lots précédents ne sont plus écartés : ce sont maintenant des groupes
  // nommés que l'utilisateur veut pouvoir rouvrir, pas une file jetable.
  report({ type: "step", at: mark.persist, label: "Saving the selection" });

  const { error: batchError } = await admin.from("reco_batches").insert({
    id: batchId,
    user_id: userId,
    name: batchName,
    kind,
  });

  if (batchError) {
    // Deux générations du même nom le même jour : l'index unique les refuse.
    // Le cas se produit surtout par double clic ; renvoyer une erreur claire
    // vaut mieux qu'un doublon silencieux.
    if (batchError.code === "23505") {
      return {
        batchId: null,
        batchName: null,
        generated: 0,
        candidatesConsidered,
        catalogAdded,
        byEngine: { algo: 0, ai: 0 },
        aiRejected,
        reason: `A group named “${batchName}” already exists for today.`,
      };
    }
    throw new Error(`insert reco_batches : ${batchError.message}`);
  }

  const { error } = await admin.from("recommendations").insert(rows);
  if (error) throw new Error(`insert recommendations : ${error.message}`);

  return {
    batchId,
    batchName,
    generated: rows.length,
    candidatesConsidered,
    catalogAdded,
    byEngine: {
      algo: rows.filter((row) => row.engine === "algo").length,
      ai: rows.filter((row) => row.engine === "ai").length,
    },
    aiRejected,
    reason: reasons.length > 0 ? reasons.join(" ") : undefined,
  };
}

/**
 * Ajoute au catalogue des morceaux d'artistes voisins de ceux que
 * l'utilisateur apprécie.
 *
 * Sans cette étape, le vivier se limite à ce que l'utilisateur a déjà entendu
 * et le moteur ne peut rien proposer de neuf. Le chemin est :
 * artiste apprécié → voisins Last.fm → recherche Spotify → morceaux populaires.
 */
async function expandCatalog(
  userId: string,
  profile: TasteProfile,
  budget: number,
): Promise<number> {
  const admin = createAdminClient();

  const topArtists = [...profile.artistWeights.entries()]
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([artistId]) => artistId);

  if (topArtists.length === 0) return 0;

  const { data: artistRows } = await admin
    .from("artists")
    .select("id, name")
    .in("id", topArtists);

  let spent = 0;
  let added = 0;
  const seenNames = new Set<string>();

  for (const artist of artistRows ?? []) {
    if (spent >= budget) break;

    let neighbours: Array<{ name: string; match: number }> = [];
    try {
      neighbours = await fetchSimilarArtists(artist.name);
    } catch {
      // Last.fm indisponible ou sans clé : l'expansion s'arrête, le reste du
      // pipeline continue de fonctionner sur le catalogue existant.
      continue;
    }

    for (const neighbour of neighbours.slice(0, 4)) {
      if (spent >= budget) break;

      const key = neighbour.name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      try {
        // `/search` est plafonné en mode développement : une seule requête, un
        // seul résultat exploité.
        const found = await spotifyFetch<{
          artists?: { items?: Array<{ id: string; name: string }> };
        }>(
          userId,
          `/search?q=${encodeURIComponent(neighbour.name)}&type=artist&limit=1`,
        );
        spent++;

        const match = found?.artists?.items?.[0];
        if (!match) continue;

        const top = await spotifyFetch<{ tracks?: SpotifyTrack[] }>(
          userId,
          `/artists/${match.id}/top-tracks?market=from_token`,
          { allowNotFound: true },
        );
        spent++;

        const tracks = (top?.tracks ?? []).slice(0, 5);
        if (tracks.length === 0) continue;

        await upsertTracks(tracks);
        added += tracks.length;
      } catch {
        // Quota atteint ou artiste introuvable : on arrête l'expansion sans
        // compromettre la génération, qui saura travailler avec l'existant.
        return added;
      }
    }
  }

  // Enrichir ce qui vient d'entrer : sans caractéristiques ni tags, un morceau
  // ne peut pas être scoré et resterait invisible.
  if (added > 0) {
    const { data: fresh } = await admin
      .from("tracks")
      .select("id")
      .is("enriched_at", null)
      .limit(120);

    const ids = (fresh ?? []).map((t) => t.id);
    if (ids.length > 0) {
      await enrichTracksWithFeatures(ids).catch(() => undefined);
    }

    const { data: freshArtists } = await admin
      .from("artists")
      .select("id")
      .is("enriched_at", null)
      .limit(30);

    const artistIds = (freshArtists ?? []).map((a) => a.id);
    if (artistIds.length > 0) {
      await enrichArtistsFromLastfm(artistIds).catch(() => undefined);
    }
  }

  return added;
}

/**
 * Assemble les candidats depuis la base : morceaux jamais entendus, munis d'au
 * moins un descripteur exploitable.
 */
async function collectCandidates(
  profile: TasteProfile,
  excluded: RecentRecos,
): Promise<Candidate[]> {
  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("tracks")
    .select(
      `id,
       name,
       track_artists(artist_id),
       track_tags(tag_id, weight),
       track_features(acousticness, danceability, energy, instrumentalness,
                      liveness, speechiness, valence, loudness, tempo)`,
    )
    .limit(2000);

  const candidates: Candidate[] = [];

  for (const row of rows ?? []) {
    if (profile.knownTrackIds.has(row.id)) continue;

    const artistIds = (row.track_artists ?? []).map((a) => a.artist_id);
    // Recommandé il y a moins de dix jours, sous cet identifiant ou sous une
    // réédition du même titre : pas de retour si tôt.
    if (isRecentRepeat(excluded, row.id, row.name, artistIds)) continue;

    const tags: WeightedTag[] = (row.track_tags ?? []).map((t) => ({
      tagId: t.tag_id,
      weight: t.weight,
    }));

    const raw = Array.isArray(row.track_features)
      ? row.track_features[0]
      : row.track_features;

    const features: PartialFeatureVector | null = raw
      ? {
          acousticness: raw.acousticness,
          danceability: raw.danceability,
          energy: raw.energy,
          instrumentalness: raw.instrumentalness,
          liveness: raw.liveness,
          speechiness: raw.speechiness,
          valence: raw.valence,
          loudness: raw.loudness,
          tempo: raw.tempo,
        }
      : null;

    // Un morceau sans aucun descripteur ne pourrait être classé qu'au hasard.
    if (tags.length === 0 && !features) continue;

    candidates.push({
      trackId: row.id,
      artistIds,
      tags,
      features,
      source: "catalogue",
    });
  }

  return candidates;
}

/**
 * Rejoue l'historique des lots passés pour alimenter le bandit.
 *
 * Une note de 4 ou 5 compte comme succès, un morceau écarté ou ignoré comme
 * échec. C'est ce qui permet à l'exploration de se concentrer progressivement
 * sur les directions qui portent leurs fruits.
 */
async function loadArmStats(userId: string) {
  const admin = createAdminClient();

  const { data } = await admin
    .from("recommendations")
    .select("track_id, status, reasons")
    .eq("user_id", userId)
    .in("status", ["rated", "dismissed", "skipped"])
    .order("created_at", { ascending: false })
    .limit(500);

  if (!data?.length) return undefined;

  const ratedIds = data
    .filter((r) => r.status === "rated")
    .map((r) => r.track_id);

  const { data: ratings } = ratedIds.length
    ? await admin
        .from("ratings")
        .select("track_id, rating")
        .eq("user_id", userId)
        .in("track_id", ratedIds)
    : { data: [] };

  const ratingByTrack = new Map(
    (ratings ?? []).map((r) => [r.track_id, r.rating]),
  );

  const arms = new Map<string, { successes: number; failures: number }>();

  for (const reco of data) {
    const reasons = reco.reasons as Record<string, unknown> | null;
    const arm =
      typeof reasons?.arm === "string" ? reasons.arm : "__default__";

    const entry = arms.get(arm) ?? { successes: 0, failures: 0 };
    const rating = ratingByTrack.get(reco.track_id);

    if (reco.status === "rated" && rating !== undefined && rating >= 4) {
      entry.successes++;
    } else {
      entry.failures++;
    }

    arms.set(arm, entry);
  }

  return arms;
}
