import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { limiters } from "@/lib/rate-limit";
import { upsertTracks } from "@/lib/spotify/catalog";
import { spotifyFetch } from "@/lib/spotify/client";
import type { SpotifyTrack } from "@/lib/spotify/types";
import { env } from "@/lib/env";
import type { TasteProfile } from "@/lib/reco/taste";
import { isRecentRepeat, type RecentRecos } from "@/lib/reco/no-repeat";
import type { Milestones, ProgressReporter } from "@/lib/reco/progress";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Moteur de recommandation par modèle de langage (Claude Opus 5).
 *
 * ── CE QUI EST ENVOYÉ AU MODÈLE, ET POURQUOI ────────────────────────────────
 * La Developer Policy de Spotify interdit explicitement d'« ingérer du Spotify
 * Content dans un modèle d'apprentissage automatique ou d'IA ». Le profil de
 * goût transmis ici est donc construit **exclusivement** à partir de sources
 * ouvertes :
 *
 *   - les tags viennent de Last.fm et MusicBrainz ;
 *   - les caractéristiques audio viennent de ReccoBeats ;
 *   - les noms d'artistes et de morceaux sont des faits publics, présents dans
 *     MusicBrainz, Discogs ou Wikipédia.
 *
 * Ce qui ne sort jamais : identifiants Spotify, popularité, caractéristiques
 * issues de leur API — c'est-à-dire le contenu et les métadonnées propriétaires.
 * Spotify n'intervient qu'après coup, pour rendre jouable un morceau nommé par
 * le modèle.
 *
 * Une version antérieure ne transmettait que les artistes déjà résolus vers un
 * MBID MusicBrainz. Sur un catalogue peu enrichi cela n'en transmettait aucun :
 * le modèle ne recevait qu'une liste de genres à plat et proposait au hasard.
 * Mesuré : 0 artiste sur 40 candidats.
 *
 * ── HALLUCINATIONS ──────────────────────────────────────────────────────────
 * Un modèle de langage invente des morceaux plausibles qui n'existent pas.
 * Aucune suggestion n'est donc retenue sur parole : chacune doit être retrouvée
 * dans MusicBrainz **puis** dans Spotify. Ce qui échoue à l'une des deux étapes
 * est écarté, et le taux de rejet est journalisé — s'il explose, c'est le signal
 * que le prompt dérive.
 */

const MODEL = "claude-opus-5";

/**
 * Nombre de suggestions demandées, avant filtrage par ancrage.
 *
 * Ce nombre est plafonné par la durée de la fonction, pas par le coût. Le
 * budget de bout en bout tient dans les 300 s de Vercel : ~130 s de
 * raisonnement, ~30 s de rédaction, ~60 s de vérification. À trente
 * suggestions, la rédaction et la vérification débordaient, la fonction était
 * tuée avant d'écrire quoi que ce soit, et l'utilisateur ne récoltait qu'une
 * connexion coupée après quatre minutes d'attente.
 */
const REQUESTED = 18;

/**
 * Longueur de sortie attendue, pour situer l'avancement du modèle.
 *
 * Mesurée à ~5 500 tokens sur des générations réelles, soit environ 20 000
 * caractères en comptant le raisonnement. Une sortie plus longue que prévu ne
 * casse rien : la progression est simplement plafonnée.
 */
const EXPECTED_OUTPUT_CHARS = 20_000;

/**
 * Durée de référence de la phase de réflexion, en secondes.
 *
 * Le raisonnement adaptif ne produit aucun événement tant qu'il dure : mesuré
 * à 83 s sur une génération de 117 s. Cette constante ne sert qu'à donner une
 * allure à l'estimation — la dépasser ne casse rien, la courbe étant
 * asymptotique.
 */
const THINKING_SECONDS = 85;

/**
 * Temps maximal consacré à la vérification des suggestions.
 *
 * La fonction Vercel est coupée à 300 s. Le raisonnement puis la rédaction en
 * consomment déjà environ 130 : au-delà de cette borne, poursuivre garantirait
 * de tout perdre plutôt que de livrer un lot un peu plus court.
 */
const ANCHORING_BUDGET_MS = 150_000;

/**
 * Temps maximal accordé à une vérification isolée.
 *
 * MusicBrainz s'autorise 15 s par requête et trois relances : une seule
 * suggestion récalcitrante pouvait donc mobiliser plus d'une minute, et le
 * budget global ne pouvait rien puisqu'il ne s'évalue qu'entre deux
 * suggestions. Passer à la suivante coûte moins cher que d'insister.
 */
const MUSICBRAINZ_TIMEOUT_MS = 8_000;

/**
 * Délai de la recherche Spotify.
 *
 * Généreux à dessein : Spotify est le juge final, l'abandonner écarte une
 * suggestion valable, là où lâcher MusicBrainz ne fait que reporter le doute.
 *
 * Mais il en faut un. `ANCHORING_BUDGET_MS` ne s'évalue qu'entre deux
 * suggestions : un seul appel qui ne revient pas gèle la boucle et emporte
 * toute la génération — c'est ce qui s'est produit après l'avoir retiré, la
 * vérification tournant de la 66ᵉ à la 260ᵉ seconde. Le budget global limite
 * par ailleurs le nombre d'abandons, donc le nombre de requêtes laissées
 * pendantes derrière le limiteur.
 */
const SPOTIFY_TIMEOUT_MS = 25_000;

/**
 * Abandonne l'attente au-delà du délai imparti.
 *
 * La requête sous-jacente n'est pas annulée — elle finira dans le vide — mais
 * elle ne retient plus la génération.
 */
async function withDeadline<T>(
  work: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[ai] ${label} : abandon après ${timeoutMs} ms`);
      resolve(null);
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Au-delà de cette pause du limiteur Spotify, inutile d'insister : le quota de
 * l'application est épuisé et chaque recherche ne ferait qu'attendre puis
 * expirer. Les pauses réelles observées se comptent en heures.
 */
export const QUOTA_ABORT_THRESHOLD_MS = 20_000;

/** Dit quand réessayer, en heure locale : « réessayez plus tard » ne dit rien. */
export function quotaMessage(pausedForMs: number): string {
  const resume = new Date(Date.now() + pausedForMs);
  const at = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  }).format(resume);
  return `Spotify has rate-limited the app — its quota is shared across all users. Try again after ${at}.`;
}

/** Plafond d'appels Spotify pour la résolution : le quota est partagé. */
const RESOLUTION_BUDGET = 40;

export const suggestionSchema = z.object({
  suggestions: z
    .array(
      z.object({
        artist: z.string().describe("Artist name, exact spelling"),
        title: z.string().describe("Track title, exact spelling"),
        reason: z
          .string()
          .describe(
            "One sentence explaining the link to the profile, in English",
          ),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe("How certain you are this track exists under this title"),
        familiarity: z
          .enum(["evident", "adjacent", "lointain"])
          .describe(
            "evident = inside the comfort zone, adjacent = a step sideways, lointain = a bet",
          ),
      }),
    )
    .describe("The suggestions, from most relevant to most exploratory"),
});

export type AiSuggestion = z.infer<
  typeof suggestionSchema
>["suggestions"][number];

export type AiRecommendation = {
  trackId: string;
  reason: string;
  familiarity: AiSuggestion["familiarity"];
  exploration: number;
};

export type AiGenerationResult = {
  recommendations: AiRecommendation[];
  suggested: number;
  rejected: number;
  reason?: string;
};

/**
 * Le prompt système est stable d'un appel à l'autre, ce qui le rend cachable.
 * Tout ce qui varie (le profil de l'utilisateur) est envoyé dans le message,
 * après le point de césure du cache.
 */
export const SYSTEM_PROMPT = `You are a record-shop owner who has known someone for years. You are given their taste: their go-to artists, their most replayed tracks, the genres that keep coming back, and sometimes their ratings.

Your job: suggest real tracks they will genuinely love.

Hard rules:

1. ANCHOR ON ARTISTS AND TRACKS, NOT ON GENRES. Genres are too broad: "rock" or "pop" mean nothing on their own, and two people sharing those labels listen to completely different things. The information lives in the named artists and the replayed tracks. Every suggestion must trace back to one of them.

2. RESPECT THE HIERARCHY. The profile separates what sits at the core of the taste, what is merely present, and what is marginal. Do not build a selection on the margins: if a genre is flagged as minor, it may inspire one or two suggestions at most.

3. Only suggest tracks you are certain exist, with the exact spelling of artist and title. Every suggestion is checked against a music database; an invention is discarded and counted against you. When in doubt, suggest something else.

4. Spread across three registers:
   - "evident": very close to what is already loved, a friend would say "obviously"
   - "adjacent": a step sideways — same family, different era, different country, different production
   - "lointain": a bet, but one that keeps a PRECISE bridge to the profile (a texture, a voice, a shared producer, a lineage)
   Roughly a third of each. A "lointain" without an explicit bridge is a mistake, not daring.

5. Avoid commercial obviousness and chart staples. A track everyone has already heard adds nothing.

6. Never two tracks by the same artist, and none of the already-listened artists listed in the profile.

7. The "reason" field must name a SPECIFIC artist or track from the profile and say what connects them. "Because you like rock" is worthless. "The same saturated guitar as Starsailor, but at slower tempos" is useful.

Write every "reason" in English.

Answer only through the requested structured format.`;

/**
 * Interroge Claude puis ancre chaque suggestion dans un catalogue réel.
 *
 * @param userId - utilisateur destinataire, utilisé pour les appels Spotify
 * @param profile - profil de goût, converti en descripteurs ouverts
 */
export async function generateAiRecommendations(
  userId: string,
  profile: TasteProfile,
  options?: {
    /** Nombre de morceaux réellement souhaités par l'appelant. */
    wanted?: number;
    /** Morceaux interdits de retour — recommandés il y a moins de dix jours. */
    exclude?: RecentRecos;
    onProgress?: ProgressReporter;
    milestones?: Milestones;
  },
): Promise<AiGenerationResult> {
  const report = options?.onProgress ?? (() => {});
  const mark = options?.milestones;
  const wanted = options?.wanted ?? REQUESTED;
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      recommendations: [],
      suggested: 0,
      rejected: 0,
      reason:
        "AI engine not configured: set ANTHROPIC_API_KEY in .env.local.",
    };
  }

  // Vérifier le quota AVANT de payer l'appel au modèle. Quand Spotify a
  // renvoyé un 429, sa pause se compte en heures : aucune suggestion ne pourra
  // être ancrée, et dépenser quatre-vingts secondes de raisonnement pour tout
  // écarter ensuite serait du gâchis — vécu, et facturé.
  if (limiters.spotify.pausedForMs > QUOTA_ABORT_THRESHOLD_MS) {
    return {
      recommendations: [],
      suggested: 0,
      rejected: 0,
      reason: quotaMessage(limiters.spotify.pausedForMs),
    };
  }

  if (mark) {
    report({
      type: "step",
      at: mark.portrait,
      label: "Describing your taste for the model",
    });
  }
  const portrait = await buildOpenPortrait(profile);

  if (!portrait) {
    return {
      recommendations: [],
      suggested: 0,
      rejected: 0,
      reason:
        "Profile still too thin to query the model: listen to and rate a few tracks.",
    };
  }

  if (mark) {
    report({
      type: "step",
      at: mark.model,
      label: "Claude is picking tracks — the long part",
    });
  }

  const client = new Anthropic();

  // Streaming plutôt qu'un appel bloquant : cette étape dure à elle seule une
  // grosse minute. En `parse()`, rien ne sortait pendant tout ce temps — ni
  // progression pour l'utilisateur, ni le moindre octet sur la connexion, ce
  // qui l'exposait en prime à une coupure pour inactivité. Les tokens produits
  // donnent une progression *réelle*, pas une animation.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    // Le modèle refuse `thinking.type.enabled` et le dit sans ambiguïté : sur
    // Opus 5, la profondeur de raisonnement se règle par `effort`, plus bas.
    // C'est là qu'est le levier — passer `effort` de « high » à « medium » a
    // ramené la réflexion de plus de 130 s à une cinquantaine.
    thinking: { type: "adaptive" },
    output_config: {
      // « high » faisait dépasser la durée de la fonction : le raisonnement
      // à lui seul consommait l'essentiel du budget, et la génération
      // n'aboutissait jamais. Une sélection un peu moins fouillée mais qui
      // arrive vaut mieux qu'une sélection idéale que personne ne voit.
      effort: "medium",
      format: zodOutputFormat(suggestionSchema),
    },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Le prompt système ne change pas d'un utilisateur à l'autre : le mettre
        // en cache évite de le refacturer à chaque génération.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Voici le profil. Propose ${REQUESTED} morceaux.\n\n${portrait}`,
      },
    ],
  });

  if (mark) {
    const span = mark.grounding - mark.model;

    // La barre ne recule jamais : la réflexion et la rédaction estiment leur
    // avancement de deux façons différentes, et la bascule de l'une à l'autre
    // ne doit pas se voir comme un retour en arrière.
    let furthest = mark.model;
    const advance = (at: number, label: string) => {
      furthest = Math.max(furthest, at);
      report({ type: "step", at: furthest, label });
    };

    let produced = 0;
    let lastReport = 0;
    const started = Date.now();

    // Pendant la réflexion, l'API ne renvoie **rien** — mesuré à 83 s sur une
    // génération de 117 s. Sans battement, la barre resterait figée sur les
    // trois quarts de l'attente et la connexion passerait ce temps sans un
    // octet, à portée d'une coupure pour inactivité.
    //
    // Le temps écoulé est le seul fait disponible ici : il est affiché tel
    // quel, et la position n'est qu'une estimation asymptotique qui ne peut pas
    // atteindre la moitié de l'intervalle, réservée à la rédaction observable.
    const heartbeat = setInterval(() => {
      if (produced > 0) return;
      const seconds = (Date.now() - started) / 1000;
      const share = 1 - Math.exp(-seconds / THINKING_SECONDS);
      advance(
        mark.model + span * 0.5 * share,
        `Claude is thinking (${Math.round(seconds)}s)`,
      );
    }, 1000);

    try {
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;

        const delta = event.delta as {
          text?: string;
          thinking?: string;
          partial_json?: string;
        };
        produced +=
          (delta.text ?? delta.thinking ?? delta.partial_json ?? "").length;

        // Une émission par seconde : le flux sert à montrer que ça avance, pas
        // à retransmettre chaque token.
        const now = Date.now();
        if (now - lastReport < 1000) continue;
        lastReport = now;

        // La rédaction occupe la seconde moitié de l'intervalle, et n'atteint
        // pas non plus sa borne : le jalon suivant appartient à un travail qui
        // n'a pas commencé.
        const share = Math.min(1, produced / EXPECTED_OUTPUT_CHARS);
        advance(
          mark.model + span * (0.5 + 0.47 * share),
          "Claude is writing its picks",
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  const response = await stream.finalMessage();

  // Les classificateurs de sécurité peuvent décliner une requête : la réponse
  // est un succès HTTP avec `stop_reason: "refusal"` et un contenu vide.
  if (response.stop_reason === "refusal") {
    return {
      recommendations: [],
      suggested: 0,
      rejected: 0,
      reason: "The model declined the request.",
    };
  }

  const parsed = response.parsed_output as z.infer<
    typeof suggestionSchema
  > | null;

  const suggestions = parsed?.suggestions ?? [];
  if (suggestions.length === 0) {
    return {
      recommendations: [],
      suggested: 0,
      rejected: 0,
      reason: "The model suggested no tracks.",
    };
  }

  const { anchored, rejects } = await anchorSuggestions(
    userId,
    suggestions,
    profile,
    { report, mark, wanted, exclude: options?.exclude },
  );

  return {
    recommendations: anchored,
    suggested: suggestions.length,
    rejected: suggestions.length - anchored.length,
    reason:
      anchored.length === 0
        ? explainRejects(suggestions.length, rejects)
        : undefined,
  };
}

/**
 * Décrit le goût de l'utilisateur en n'utilisant que des sources ouvertes.
 *
 * Renvoie `null` si le profil ne contient pas encore assez de descripteurs
 * ouverts : mieux vaut ne rien envoyer qu'un portrait vide, qui produirait des
 * suggestions génériques.
 */
async function buildOpenPortrait(
  profile: TasteProfile,
): Promise<string | null> {
  const admin = createAdminClient();

  // --- Tags, avec leur poids ------------------------------------------------
  // Une liste à plat de vingt genres est un fourre-tout : « rock, house,
  // chanson française, hip hop » ne décrit personne. Les poids relatifs
  // distinguent le cœur du goût de ses marges, et c'est là que se joue la
  // pertinence des suggestions.
  const weighted = [...profile.tagWeights.entries()]
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24);

  const rejectedTagIds = [...profile.rejectedTagWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => id);

  const allTagIds = [...new Set([...weighted.map(([id]) => id), ...rejectedTagIds])];
  if (allTagIds.length === 0) return null;

  const { data: tagRows } = await admin
    .from("tags")
    .select("id, name")
    .in("id", allTagIds);

  const tagName = new Map((tagRows ?? []).map((t) => [t.id, t.name]));

  const maxWeight = weighted[0]?.[1] ?? 1;
  const named = weighted
    .map(([id, weight]) => ({ name: tagName.get(id), part: weight / maxWeight }))
    .filter((t): t is { name: string; part: number } => Boolean(t.name));

  if (named.length === 0) return null;

  // Trois paliers plutôt qu'un score brut : le modèle raisonne mieux sur
  // « central / présent / marginal » que sur « 0.62 ».
  const coeur = named.filter((t) => t.part >= 0.6).map((t) => t.name);
  const present = named.filter((t) => t.part >= 0.25 && t.part < 0.6).map((t) => t.name);
  const marges = named.filter((t) => t.part < 0.25).map((t) => t.name);

  const rejected = rejectedTagIds
    .map((id) => tagName.get(id))
    .filter((n): n is string => Boolean(n));

  // --- Artistes -------------------------------------------------------------
  // Un nom d'artiste est un fait public, présent dans MusicBrainz, Discogs ou
  // Wikipédia : ce n'est pas du contenu Spotify. Ce que la Developer Policy
  // interdit, c'est d'ingérer le *contenu* — audio, caractéristiques
  // propriétaires, identifiants. Rien de tout cela ne sort d'ici : ni identifiant
  // Spotify, ni popularité, ni caractéristique issue de leur API.
  //
  // La version précédente n'envoyait que les artistes déjà résolus vers un
  // MBID. Sur un catalogue peu enrichi, cela revenait à n'en envoyer aucun, et
  // le modèle proposait au hasard dans des genres génériques.
  const rankedArtists = [...profile.artistWeights.entries()]
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1]);

  const { data: artistRows } = rankedArtists.length
    ? await admin
        .from("artists")
        .select("id, name")
        .in("id", rankedArtists.slice(0, 60).map(([id]) => id))
    : { data: [] };

  const artistName = new Map((artistRows ?? []).map((a) => [a.id, a.name]));
  const artistes = rankedArtists
    .map(([id]) => artistName.get(id))
    .filter((n): n is string => Boolean(n));

  const piliers = artistes.slice(0, 12);
  const secondaires = artistes.slice(12, 30);

  // --- Morceaux emblématiques ----------------------------------------------
  // Le signal le plus direct dont on dispose : ce qui est réellement réécouté.
  // Un titre précis ancre bien mieux qu'un genre.
  const { data: repeats } = await admin
    .from("listens")
    .select("track_id, tracks(name, track_artists(artists(name)))")
    .order("played_at", { ascending: false })
    .limit(200);

  const playCount = new Map<string, number>();
  const label = new Map<string, string>();

  for (const listen of repeats ?? []) {
    const track = listen.tracks;
    if (!track?.name) continue;
    const artist =
      track.track_artists?.map((l) => l.artists?.name).filter(Boolean)[0] ?? "";
    playCount.set(listen.track_id, (playCount.get(listen.track_id) ?? 0) + 1);
    label.set(listen.track_id, artist ? `${artist} — ${track.name}` : track.name);
  }

  const emblematiques = [...playCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => label.get(id))
    .filter((l): l is string => Boolean(l));

  // --- Morceaux adorés et détestés ------------------------------------------
  const { data: loved } = await admin
    .from("ratings")
    .select("rating, tracks(name, track_artists(artists(name)))")
    .gte("rating", 4)
    .limit(15);

  const { data: hated } = await admin
    .from("ratings")
    .select("rating, tracks(name, track_artists(artists(name)))")
    .lte("rating", 1)
    .limit(10);

  const describeRated = (rows: typeof loved) =>
    (rows ?? [])
      .map((r) => {
        const t = r.tracks;
        if (!t?.name) return null;
        const a =
          t.track_artists?.map((l) => l.artists?.name).filter(Boolean)[0] ?? "";
        return a ? `${a} — ${t.name}` : t.name;
      })
      .filter((l): l is string => Boolean(l));

  // --- Rédaction ------------------------------------------------------------
  const lines: string[] = [];

  if (piliers.length > 0) {
    lines.push(
      `Most-listened artists, from most to least: ${piliers.join(", ")}.`,
    );
    if (secondaires.length > 0) {
      lines.push(`Also listened to, more occasionally: ${secondaires.join(", ")}.`);
    }
    lines.push(
      "Do not suggest any of these artists: they are landmarks, not targets.",
    );
  }

  if (emblematiques.length > 0) {
    lines.push(`Most replayed tracks: ${emblematiques.join(" · ")}.`);
  }

  const adores = describeRated(loved);
  if (adores.length > 0) {
    lines.push(`Rated 4 or 5 — aim for this level: ${adores.join(" · ")}.`);
  }

  const detestes = describeRated(hated);
  if (detestes.length > 0) {
    lines.push(`Rated 0 or 1 — avoid at all costs: ${detestes.join(" · ")}.`);
  }

  if (coeur.length > 0) lines.push(`At the core of the taste: ${coeur.join(", ")}.`);
  if (present.length > 0) lines.push(`Clearly present: ${present.join(", ")}.`);
  if (marges.length > 0) {
    lines.push(
      `Marginal, minor — do not build the selection on these: ${marges.join(", ")}.`,
    );
  }

  if (rejected.length > 0) {
    lines.push(`Rejected registers: ${rejected.join(", ")}. Avoid them.`);
  }

  const centroid = profile.featureCentroid;
  const spread = profile.featureSpread;

  if (centroid) {
    const describe = (key: keyof typeof centroid, label: string) => {
      const value = centroid[key];
      if (typeof value !== "number") return null;
      const variation = spread?.[key];
      const qualifier =
        typeof variation === "number" && variation > 0.25
          ? " (taste is very open on this one)"
          : "";
      return `${label} ${Math.round(value * 100)}/100${qualifier}`;
    };

    const descriptors = [
      describe("energy", "energy"),
      describe("danceability", "danceability"),
      describe("valence", "mood (0 dark, 100 bright)"),
      describe("acousticness", "acoustic"),
      describe("instrumentalness", "instrumental"),
    ].filter(Boolean);

    if (descriptors.length > 0) {
      lines.push(`Average sonic profile: ${descriptors.join(", ")}.`);
    }
  }

  lines.push(
    `Profile built on ${profile.sampleSize} signals (confidence ${profile.confidence.toFixed(2)}/1).`,
  );

  if (profile.confidence < 0.4) {
    lines.push(
      "Low confidence: favour safe picks within the described register rather than bets.",
    );
  }

  return lines.join("\n");
}

/** Pourquoi des suggestions ont été écartées, cause par cause. */
type RejectCounts = {
  duplicateArtist: number;
  recentlyRecommended: number;
  spotifyQuota: number;
  spotifyUnreachable: number;
  notInMusicBrainz: number;
  musicBrainzSilent: number;
  notOnSpotify: number;
  alreadyKnown: number;
};

/**
 * Vérifie que chaque suggestion correspond à un morceau réel et jouable.
 *
 * Deux filtres successifs : MusicBrainz atteste l'existence de l'enregistrement,
 * Spotify fournit l'identifiant qui permettra de l'écouter. Une suggestion qui
 * échoue à l'un des deux est écartée.
 */
async function anchorSuggestions(
  userId: string,
  suggestions: AiSuggestion[],
  profile: TasteProfile,
  progress?: {
    report: ProgressReporter;
    mark: Milestones | undefined;
    wanted: number;
    exclude?: RecentRecos;
  },
): Promise<{ anchored: AiRecommendation[]; rejects: RejectCounts }> {
  const anchored: AiRecommendation[] = [];
  const seenArtists = new Set<string>();
  let spent = 0;
  let checked = 0;

  // Les suggestions les plus sûres d'abord : le budget d'appels Spotify est
  // limité, autant le dépenser sur ce qui a le plus de chances d'aboutir.
  const ordered = [...suggestions].sort((a, b) => b.confidence - a.confidence);

  const wanted = progress?.wanted ?? REQUESTED;
  const deadline = Date.now() + ANCHORING_BUDGET_MS;

  // Comptage des causes d'abandon. Un lot vide est indistinguable d'un moteur
  // cassé sans cela : « 30 écartées » ne dit pas si le modèle a inventé des
  // morceaux, si Spotify ne les trouve pas, ou s'ils étaient déjà connus.
  const rejects: RejectCounts = {
    duplicateArtist: 0,
    recentlyRecommended: 0,
    spotifyQuota: 0,
    spotifyUnreachable: 0,
    notInMusicBrainz: 0,
    musicBrainzSilent: 0,
    notOnSpotify: 0,
    alreadyKnown: 0,
  };

  for (const suggestion of ordered) {
    if (spent >= RESOLUTION_BUDGET) break;

    // Quota épuisé en cours de route : sortir tout de suite. Continuer ferait
    // expirer chaque recherche l'une après l'autre, comptées à tort comme des
    // morceaux introuvables.
    if (limiters.spotify.pausedForMs > QUOTA_ABORT_THRESHOLD_MS) {
      rejects.spotifyQuota = ordered.length - checked;
      break;
    }

    // Deux gardes qui manquaient, et dont l'absence faisait dépasser la durée
    // maximale de la fonction :
    //
    //  - on vérifiait les 30 suggestions même quand l'appelant n'en garderait
    //    que 10, jetant ensuite les deux tiers du travail ;
    //  - rien ne bornait la durée, alors que chaque vérification coûte une
    //    seconde de quota MusicBrainz, plus un appel Spotify.
    //
    // Mieux vaut un lot un peu plus court qu'une génération qui meurt à 300 s
    // sans rien enregistrer.
    if (anchored.length >= wanted) break;
    if (Date.now() > deadline) break;

    // La vérification est la seule phase dont l'avancement soit connu d'avance :
    // une suggestion, un pas. C'est aussi la plus longue après le modèle.
    checked += 1;
    if (progress?.mark) {
      const { grounding, persist } = progress.mark;
      const share = checked / Math.max(1, ordered.length);
      progress.report({
        type: "step",
        at: grounding + (persist - grounding) * share,
        label: `Checking each suggestion really exists`,
        done: checked,
        total: ordered.length,
      });
    }

    const artistKey = suggestion.artist.toLowerCase().trim();
    if (seenArtists.has(artistKey)) {
      rejects.duplicateArtist += 1;
      continue;
    }

    // Trois issues, pas deux. MusicBrainz peut dire « ce morceau n'existe pas »
    // — c'est le garde-fou anti-hallucination, on écarte. Mais il peut aussi ne
    // pas répondre du tout, et confondre les deux reviendrait à rejeter toutes
    // les suggestions dès que le service faiblit, ce qui condamne la génération
    // entière. En cas de panne, c'est Spotify qui tranche : un morceau qu'on y
    // retrouve sous le même artiste et le même titre n'est pas une invention.
    const existsInMusicBrainz = await withDeadline(
      existsAsRecording(suggestion.artist, suggestion.title),
      `MusicBrainz ${suggestion.artist} — ${suggestion.title}`,
      MUSICBRAINZ_TIMEOUT_MS,
    );
    if (existsInMusicBrainz === false) {
      rejects.notInMusicBrainz += 1;
      continue;
    }
    if (existsInMusicBrainz === null) rejects.musicBrainzSilent += 1;

    let track: SpotifyTrack | null = null;
    try {
      track = await withDeadline(
        findOnSpotify(userId, suggestion.artist, suggestion.title),
        `Spotify ${suggestion.artist} — ${suggestion.title}`,
        SPOTIFY_TIMEOUT_MS,
      );
    } catch {
      // L'appel lui-même a échoué : le morceau n'est pas en cause.
      rejects.spotifyUnreachable += 1;
      spent++;
      continue;
    }

    spent++;
    if (!track) {
      rejects.notOnSpotify += 1;
      continue;
    }

    // Un morceau déjà entendu n'a rien d'une découverte.
    if (profile.knownTrackIds.has(track.id)) {
      rejects.alreadyKnown += 1;
      continue;
    }

    // Déjà proposé il y a moins de dix jours — sous cet identifiant ou sous
    // une réédition du même titre : y revenir donnerait le sentiment que les
    // sélections tournent en rond, le défaut que ce produit existe pour
    // corriger.
    if (
      progress?.exclude &&
      isRecentRepeat(
        progress.exclude,
        track.id,
        track.name,
        (track.artists ?? []).map((a) => a.id),
      )
    ) {
      rejects.recentlyRecommended += 1;
      continue;
    }

    await upsertTracks([track]);
    seenArtists.add(artistKey);

    anchored.push({
      trackId: track.id,
      reason: suggestion.reason,
      familiarity: suggestion.familiarity,
      exploration:
        suggestion.familiarity === "lointain"
          ? 1
          : suggestion.familiarity === "adjacent"
            ? 0.5
            : 0,
    });
  }

  return { anchored, rejects };
}

/**
 * Met le décompte en mots.
 *
 * Un lot vide accompagné d'un « aucune recommandation n'a pu être produite »
 * ne dit rien : l'utilisateur ne sait pas si le modèle a inventé des morceaux,
 * si Spotify ne les retrouve pas, ou s'il les connaît déjà — trois pannes qui
 * appellent trois gestes différents. La cause remonte donc jusqu'à l'écran.
 */
function explainRejects(suggested: number, r: RejectCounts): string {
  // Le quota écrase tout le reste : quand il est épuisé, les autres décomptes
  // ne sont que ses symptômes, et le seul conseil utile est l'heure de retour.
  if (r.spotifyQuota > 0) {
    return quotaMessage(limiters.spotify.pausedForMs);
  }

  const parts: string[] = [];
  if (r.spotifyUnreachable)
    parts.push(`${r.spotifyUnreachable} Spotify search failures`);
  if (r.notOnSpotify) parts.push(`${r.notOnSpotify} not found on Spotify`);
  if (r.alreadyKnown) parts.push(`${r.alreadyKnown} already in your library`);
  if (r.notInMusicBrainz) parts.push(`${r.notInMusicBrainz} don't exist`);
  if (r.recentlyRecommended)
    parts.push(`${r.recentlyRecommended} suggested less than 10 days ago`);
  if (r.duplicateArtist) parts.push(`${r.duplicateArtist} duplicate artists`);

  const detail = parts.length > 0 ? parts.join(", ") : "none could be checked";
  const silent = r.musicBrainzSilent
    ? ` MusicBrainz was unreachable for ${r.musicBrainzSilent} of them.`
    : "";

  return `Claude suggested ${suggested} tracks but none could be kept: ${detail}.${silent}`;
}

/**
 * Vérifie l'existence d'un enregistrement dans MusicBrainz.
 *
 * C'est le garde-fou contre les hallucinations : MusicBrainz est une base
 * communautaire ouverte, indépendante de tout catalogue commercial, et un
 * morceau inventé n'y figure pas.
 */
export async function existsAsRecording(
  artist: string,
  title: string,
): Promise<boolean | null> {
  await limiters.musicbrainz.acquire();

  const query = `recording:"${escapeLucene(title)}" AND artist:"${escapeLucene(artist)}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&limit=1&fmt=json`;

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": env().MUSICBRAINZ_USER_AGENT },
      cache: "no-store",
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as {
      recordings?: Array<{ score?: number }>;
    };

    const best = payload.recordings?.[0];
    // MusicBrainz note la correspondance sur 100. En dessous de 90, il s'agit
    // généralement d'un morceau différent qui partage quelques mots.
    return Boolean(best && (best.score ?? 0) >= 90);
  } catch {
    // `null` et non `false` : le service n'a pas répondu, il n'a donc pas dit
    // que le morceau n'existait pas. Confondre les deux revenait à rejeter
    // toutes les suggestions dès que MusicBrainz faiblissait — mesuré en
    // juillet 2026, où il dépassait le délai à presque chaque appel et
    // condamnait toute génération IA. L'ancrage retombe alors sur Spotify.
    return null;
  }
}

/** Retrouve le morceau sur Spotify pour le rendre jouable. */
async function findOnSpotify(
  userId: string,
  artist: string,
  title: string,
): Promise<SpotifyTrack | null> {
  // Deux requêtes, dans cet ordre. La recherche par champs est la plus
  // précise, mais elle échoue sur les titres que Spotify affuble d'un
  // qualificatif — « - 2013 Remaster », « (feat. …) » — que le modèle ignore.
  // La recherche libre les rattrape.
  const attempts = [
    `track:${title} artist:${artist}`,
    `${artist} ${title}`,
  ];

  for (const query of attempts) {
    try {
      // Plusieurs résultats, et non un seul : le premier renvoyé par Spotify
      // est souvent une reprise ou un homonyme, et s'arrêter là faisait
      // écarter des morceaux qui figuraient bien au catalogue.
      const found = await spotifyFetch<{ tracks?: { items?: SpotifyTrack[] } }>(
        userId,
        `/search?q=${encodeURIComponent(query)}&type=track&limit=5`,
      );

      const wanted = normalise(artist);
      const match = (found?.tracks?.items ?? []).find(
        (candidate) =>
          candidate?.id &&
          (candidate.artists ?? []).some((a) => {
            const name = normalise(a.name);
            return name.includes(wanted) || wanted.includes(name);
          }),
      );

      if (match) return match;
    } catch (cause) {
      // Une requête qui échoue ne condamne pas la suivante, mais elle ne doit
      // pas se confondre avec « ce morceau n'existe pas » : un 403 ou un quota
      // épuisé rejetterait ainsi des suggestions parfaitement valables, sans
      // rien laisser paraître.
      console.warn(
        `[ai] recherche Spotify en échec (${artist} — ${title}) :`,
        cause instanceof Error ? cause.message : cause,
      );
      throw cause;
    }
  }

  return null;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Échappe les caractères spéciaux de la syntaxe Lucene utilisée par MusicBrainz. */
function escapeLucene(value: string): string {
  return value.replace(/(["\\+\-!(){}[\]^~*?:/])/g, "\\$1");
}
