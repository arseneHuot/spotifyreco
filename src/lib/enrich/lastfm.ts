import "server-only";

import { env } from "@/lib/env";
import { limiters, sleep } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TablesInsert } from "@/lib/supabase/database.types";

/**
 * Last.fm — couche sémantique du moteur.
 *
 * Deux apports qu'aucune autre source ouverte ne couvre aussi bien :
 *  - les tags communautaires ("shoegaze", "melancholic", "90s"), qui décrivent
 *    la *perception* d'un morceau là où MusicBrainz ne décrit que des faits ;
 *  - une similarité entre artistes, seul remplaçant crédible de
 *    `/artists/{id}/related-artists` que Spotify a supprimé.
 *
 * Les identifiants Spotify ne servent que de clé de jointure : rien de ce qui
 * vient de Spotify n'est envoyé ici, et le modèle n'apprend que sur ces
 * features ouvertes. C'est la condition posée par la Developer Policy.
 *
 * ── APPARIEMENT PAR NOM : LA FAIBLESSE ASSUMÉE DU PIPELINE ────────────────
 * Last.fm n'indexe pas les identifiants Spotify. Le seul pont disponible est
 * le nom d'artiste, et il est ambigu à trois titres :
 *
 *  1. Homonymie franche. « Nova », « Boston », « Eden », « Bliss » désignent
 *     plusieurs groupes sans rapport ; Last.fm les fusionne sous une seule
 *     page. On récupère alors les tags d'un artiste pour un autre, sans aucun
 *     signal d'erreur — la réponse est parfaitement valide.
 *  2. Orthographe. Casse, accents, « & » contre « and », suffixes de
 *     réédition : le moindre écart renvoie une page vide ou, pire, une page
 *     voisine. `autocorrect=1` rattrape les fautes courantes en s'appuyant sur
 *     la table de corrections de Last.fm, mais peut aussi rediriger un
 *     artiste obscur vers un homonyme populaire.
 *  3. Popularité. Sur un nom partagé, Last.fm privilégie l'entité la plus
 *     écoutée : l'artiste de niche est systématiquement le perdant, et c'est
 *     précisément celui que le moteur a le plus d'intérêt à décrire finement.
 *
 * Conséquence : les données Last.fm sont traitées comme un signal *bruité*.
 * Elles sont stockées avec `source='lastfm'` pour rester distinguables et
 * pondérables en aval, et ne doivent jamais primer sur une correspondance
 * établie par MBID. Le jour où `artists.mb_artist_mbid` sera peuplé, il faudra
 * passer le paramètre `mbid` plutôt que `artist` : c'est le seul appariement
 * réellement fiable qu'expose cette API.
 */

const API_BASE = "https://ws.audioscrobbler.com/2.0/";

/** Valeur de `tags.source` / `artist_similarity.source` pour cette origine. */
const SOURCE = "lastfm";

const MAX_RETRIES = 2;

/**
 * Codes d'erreur applicatifs transitoires (cf. https://www.last.fm/api/errorcodes) :
 * 8 « Operation failed », 11 « Service Offline », 16 « temporarily unavailable ».
 * Le 29 (« Rate Limit Exceded ») est traité à part, il impose une pause.
 */
const RETRYABLE_ERROR_CODES = new Set([8, 11, 16]);
const RATE_LIMIT_ERROR_CODE = 29;

/**
 * Codes qui condamnent la clé : 10 « Invalid API key », 26 « API Key Suspended ».
 * Réessayer ne fait que consommer du quota, on coupe la source pour le reste
 * du processus.
 */
const FATAL_KEY_ERROR_CODES = new Set([10, 26]);

/** Pause appliquée au limiteur quand Last.fm signale un dépassement de débit. */
const RATE_LIMIT_PAUSE_MS = 15_000;

/**
 * Last.fm renvoie jusqu'à 100 tags par entité, triés par count décroissant.
 * La traîne est composée de tags d'organisation personnelle (« seen live »,
 * « albums I own », « favorite ») qui ne décrivent pas la musique et
 * ajouteraient surtout du bruit dans l'espace de features.
 */
const MAX_TAGS_PER_ENTITY = 30;

/** Nombre d'artistes similaires demandés (le défaut de l'API est 100). */
const SIMILAR_LIMIT = 50;

/**
 * L'échelle de `count` est absolue, de 0 à 100 : sur `artist.getTopTags` le tag
 * dominant vaut conventionnellement 100, mais l'exemple officiel de
 * `track.getTopTags` plafonne à 97. On divise donc par 100 plutôt que de
 * renormaliser sur le maximum local — sinon un artiste tagué trois fois par
 * deux personnes obtiendrait le même poids qu'un artiste massivement
 * caractérisé, ce qui fausserait toute comparaison entre entités.
 */
const COUNT_SCALE = 100;

/** Taille des lots d'écriture et de lecture Postgres (limite de longueur d'URL PostgREST). */
const DB_CHUNK = 500;

/** Pas de pagination de l'index de noms. Un plafond serveur plus bas est absorbé. */
const ARTIST_INDEX_PAGE = 1000;

/**
 * Budgets par défaut d'une exécution, calés sur ceux de `musicbrainz.ts`.
 *
 * Un artiste coûte deux requêtes, et le limiteur impose 220 ms entre chacune :
 * ~0,45 s par artiste. Sans plafond, un lot de quelques milliers d'artistes
 * dépasserait la coupure à 300 s des fonctions Vercel — et comme tout est
 * persisté à la fin, la totalité du travail serait perdue. On rend donc la main
 * avant la coupure ; l'exécution suivante reprendra le reste du lot.
 */
const DEFAULT_MAX_ARTISTS = 200;
const DEFAULT_DEADLINE_MS = 240_000;

let missingKeyWarned = false;
let outageWarned = false;
let sourceDisabled = false;

/**
 * Une panne de Last.fm se traduit par des tableaux vides, indiscernables d'un
 * artiste sans tags : sans trace, un job rendrait `{ tagged: 0 }` en donnant
 * l'impression d'avoir travaillé. On le signale donc — une seule fois, car un
 * lot de plusieurs centaines d'artistes émettrait sinon autant de lignes.
 */
function warnOutageOnce(reason: string): void {
  if (outageWarned) return;
  outageWarned = true;
  console.warn(`[lastfm] source indisponible (${reason}) : résultats incomplets.`);
}

export type WeightedTag = { name: string; weight: number };
export type SimilarArtist = { name: string; match: number };

/**
 * Renvoie la clé, ou `null` si Last.fm n'est pas configuré.
 *
 * La clé est facultative par conception : le moteur doit tourner sans elle, en
 * mode dégradé (pas de tags, pas de similarité — mais MusicBrainz, ListenBrainz
 * et ReccoBeats continuent d'alimenter le profil). L'avertissement n'est émis
 * qu'une fois, sans quoi un job d'enrichissement de plusieurs milliers
 * d'artistes noierait les logs.
 */
function apiKey(): string | null {
  if (sourceDisabled) return null;

  const key = env().LASTFM_API_KEY?.trim();
  if (!key) {
    if (!missingKeyWarned) {
      missingKeyWarned = true;
      console.warn(
        "[lastfm] LASTFM_API_KEY absente : tags et similarité désactivés (mode dégradé).",
      );
    }
    return null;
  }
  return key;
}

/**
 * Last.fm sérialise son XML en JSON sans schéma : une liste d'un seul élément
 * perd ses crochets et devient un objet nu. Un artiste avec un unique tag
 * casserait donc tout code qui suppose un tableau.
 */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/**
 * Les champs numériques arrivent tantôt en nombre (`count` des *.getTopTags),
 * tantôt en chaîne (`match` de artist.getSimilar, « 0.618 »). `parseFloat` est
 * obligatoire ici : `parseInt` tronquerait toutes les similarités à 0 ou 1.
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Les tags sont du texte libre : « Shoegaze », « shoegaze » et « SHOEGAZE »
 * sont le même concept mais violeraient l'unicité `tags(name, source)` sous
 * trois lignes distinctes, et fragmenteraient le signal en trois.
 */
function normalizeTagName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase();
  if (!name || name.length > 100) return null;
  return name;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Appel brut à l'API. Renvoie `null` dès que la réponse est inexploitable :
 * une source d'enrichissement indisponible dégrade le service, elle ne le
 * casse pas — l'appelant traite l'absence comme « pas de données ».
 */
async function lastfmRequest(
  params: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const key = apiKey();
  if (!key) return null;

  const query = new URLSearchParams({ ...params, api_key: key, format: "json" });
  const url = `${API_BASE}?${query.toString()}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiters.lastfm.acquire();

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": env().MUSICBRAINZ_USER_AGENT },
        cache: "no-store",
      });
    } catch (cause) {
      // Panne réseau ou DNS : on retente, puis on abandonne silencieusement.
      if (attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      console.warn(`[lastfm] ${params.method} injoignable :`, cause);
      return null;
    }

    if (response.status === 429) {
      limiters.lastfm.pauseFor(RATE_LIMIT_PAUSE_MS);
      if (attempt < MAX_RETRIES) continue;
      warnOutageOnce("HTTP 429 après retries");
      return null;
    }

    if (response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      warnOutageOnce(`HTTP ${response.status} après retries`);
      return null;
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Last.fm sert parfois une page HTML d'erreur avec un statut 200.
      console.warn(`[lastfm] ${params.method} : réponse non-JSON.`);
      return null;
    }

    if (typeof body !== "object" || body === null) return null;
    const payload = body as Record<string, unknown>;

    // L'enveloppe d'erreur ({ error, message }) peut accompagner un statut 200
    // aussi bien qu'un 4xx : on la teste toujours, jamais le seul `response.ok`.
    const errorCode = toFiniteNumber(payload.error);
    if (errorCode !== null) {
      const message = typeof payload.message === "string" ? payload.message : "";

      if (FATAL_KEY_ERROR_CODES.has(errorCode)) {
        // Inutile d'insister : chaque appel suivant échouerait de la même
        // façon. Un redémarrage du processus réactivera la source.
        sourceDisabled = true;
        console.warn(`[lastfm] clé refusée (${errorCode} ${message}) : source désactivée.`);
        return null;
      }

      if (errorCode === RATE_LIMIT_ERROR_CODE) {
        limiters.lastfm.pauseFor(RATE_LIMIT_PAUSE_MS);
        if (attempt < MAX_RETRIES) continue;
        warnOutageOnce("code 29 (rate limit) après retries");
        return null;
      }

      if (RETRYABLE_ERROR_CODES.has(errorCode)) {
        if (attempt < MAX_RETRIES) {
          await sleep(2 ** attempt * 500);
          continue;
        }
        warnOutageOnce(`code ${errorCode} (${message}) après retries`);
        return null;
      }

      // Code 6 en particulier : sert autant à « paramètre manquant » qu'à
      // « Artist not found ». Dans les deux cas il n'y a rien à récupérer.
      return null;
    }

    return payload;
  }

  return null;
}

/**
 * Convertit un bloc `toptags` en tags pondérés sur [0, 1].
 *
 * Les tags de count nul sont écartés : ils correspondent à des associations
 * marginales qui n'apporteraient qu'un poids nul en base.
 */
function parseTopTags(payload: Record<string, unknown> | null): WeightedTag[] {
  if (!payload) return [];

  const container = payload.toptags;
  if (typeof container !== "object" || container === null) return [];

  const raw = toArray((container as Record<string, unknown>).tag);
  const tags: WeightedTag[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const name = normalizeTagName(record.name);
    if (!name || seen.has(name)) continue;

    const count = toFiniteNumber(record.count);
    if (count === null || count <= 0) continue;

    seen.add(name);
    tags.push({ name, weight: clamp01(count / COUNT_SCALE) });

    if (tags.length >= MAX_TAGS_PER_ENTITY) break;
  }

  return tags;
}

/**
 * Tags communautaires d'un artiste, pondérés sur [0, 1].
 *
 * Renvoie un tableau vide si Last.fm n'est pas configuré, si l'artiste est
 * inconnu, ou si l'API est en panne — jamais d'exception.
 */
export async function fetchArtistTags(artistName: string): Promise<WeightedTag[]> {
  const artist = artistName?.trim();
  if (!artist) return [];

  const payload = await lastfmRequest({
    method: "artist.getTopTags",
    artist,
    autocorrect: "1",
  });

  return parseTopTags(payload);
}

/**
 * Tags communautaires d'un morceau, pondérés sur [0, 1].
 *
 * Beaucoup moins dense que pour les artistes : seuls les titres très écoutés
 * sont tagués individuellement, et un morceau inconnu renvoie simplement une
 * liste vide (Last.fm répond alors soit un `toptags` sans clé `tag`, soit
 * l'erreur applicative 6 « Track not found »). L'appelant doit donc considérer
 * le tableau vide comme le cas nominal, pas comme une anomalie.
 */
export async function fetchTrackTags(
  artistName: string,
  trackName: string,
): Promise<WeightedTag[]> {
  const artist = artistName?.trim();
  const track = trackName?.trim();
  if (!artist || !track) return [];

  const payload = await lastfmRequest({
    method: "track.getTopTags",
    artist,
    track,
    autocorrect: "1",
  });

  return parseTopTags(payload);
}

/**
 * Artistes similaires, avec un score de proximité sur [0, 1].
 *
 * `match` vaut 1 pour le voisin le plus proche puis décroît ; il arrive en
 * chaîne décimale dans le JSON.
 */
export async function fetchSimilarArtists(artistName: string): Promise<SimilarArtist[]> {
  const artist = artistName?.trim();
  if (!artist) return [];

  const payload = await lastfmRequest({
    method: "artist.getSimilar",
    artist,
    autocorrect: "1",
    limit: String(SIMILAR_LIMIT),
  });
  if (!payload) return [];

  const container = payload.similarartists;
  if (typeof container !== "object" || container === null) return [];

  const raw = toArray((container as Record<string, unknown>).artist);
  const results: SimilarArtist[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;

    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;

    const match = toFiniteNumber(record.match);
    if (match === null || match <= 0) continue;

    seen.add(dedupeKey);
    results.push({ name, match: clamp01(match) });
  }

  return results;
}

/**
 * Index nom (minuscule) → identifiant Spotify de tous les artistes connus.
 *
 * On charge la table entière plutôt que d'interroger nom par nom, pour deux
 * raisons concrètes :
 *  - PostgREST n'a pas de filtre `in` insensible à la casse, et il n'existe pas
 *    d'index fonctionnel sur `lower(name)` (ajouter une migration est hors du
 *    périmètre de ce module) ;
 *  - la solution de repli, `or=(name.ilike.A,name.ilike.B,…)`, se casse sur les
 *    noms contenant une virgule ou une parenthèse — « Sunn O))) », « Crosby,
 *    Stills & Nash » — qui sont interprétés comme de la syntaxe de filtre.
 *
 * Un doublon de casse dans le catalogue fait gagner le dernier lu ; c'est sans
 * conséquence, les deux lignes désignent le même artiste.
 */
async function loadArtistNameIndex(
  admin: ReturnType<typeof createAdminClient>,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();

  // PostgREST plafonne le nombre de lignes servies (`db-max-rows`, 1000 par
  // défaut chez Supabase, souvent abaissé au durcissement de l'API). On avance
  // donc du nombre de lignes *réellement reçues* et on ne s'arrête que sur une
  // page vide : une page courte signifie « le serveur a tronqué », pas « fin de
  // table ». Avancer du pas demandé sauterait alors des artistes en silence —
  // leurs liens de similarité disparaîtraient sans la moindre erreur.
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from("artists")
      .select("id, name")
      .order("id", { ascending: true })
      .range(from, from + ARTIST_INDEX_PAGE - 1);

    if (error) throw new Error(`lecture artists : ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) index.set(row.name.trim().toLowerCase(), row.id);
    from += data.length;
  }

  return index;
}

type EnrichOptions = {
  /** Plafond d'artistes interrogés en une exécution. */
  maxArtists?: number;
  /** Temps maximal consacré au lot, pour rendre la main avant la coupure. */
  deadlineMs?: number;
};

/**
 * Enrichit un lot d'artistes : tags communautaires et voisinage.
 *
 * Retourne le nombre d'artistes ayant reçu au moins un tag (`tagged`) et le
 * nombre de liens de similarité écrits (`similar`).
 *
 * Le lot est tronqué au budget (`maxArtists`, `deadlineMs`) : les artistes non
 * traités sont simplement laissés à l'exécution suivante, qui les retrouvera
 * dans la même liste. Sans clé Last.fm, renvoie `{ tagged: 0, similar: 0 }`
 * sans rien tenter.
 */
export async function enrichArtistsFromLastfm(
  artistIds: string[],
  options: EnrichOptions = {},
): Promise<{ tagged: number; similar: number }> {
  const maxArtists = options.maxArtists ?? DEFAULT_MAX_ARTISTS;
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const ids = [...new Set(artistIds.filter(Boolean))];
  if (ids.length === 0 || maxArtists <= 0 || !apiKey()) return { tagged: 0, similar: 0 };

  const admin = createAdminClient();

  const artists: Array<{ id: string; name: string }> = [];
  for (const batch of chunk(ids, DB_CHUNK)) {
    const { data, error } = await admin.from("artists").select("id, name").in("id", batch);
    if (error) throw new Error(`lecture artists : ${error.message}`);
    if (data) artists.push(...data);
    if (artists.length >= maxArtists) break;
  }
  if (artists.length === 0) return { tagged: 0, similar: 0 };

  const tagsByArtist = new Map<string, WeightedTag[]>();
  const similarByArtist = new Map<string, SimilarArtist[]>();

  for (const artist of artists.slice(0, maxArtists)) {
    if (Date.now() > deadline) break;
    // La clé peut avoir été refusée en cours de route : tous les appels suivants
    // renverraient vide. On sort pour aller écrire ce qui a déjà été obtenu.
    if (!apiKey()) break;

    // Une entrée fautive ne doit pas emporter le lot : le job d'enrichissement
    // traite des milliers d'artistes et doit toujours progresser.
    try {
      const tags = await fetchArtistTags(artist.name);
      if (tags.length > 0) tagsByArtist.set(artist.id, tags);

      const similar = await fetchSimilarArtists(artist.name);
      if (similar.length > 0) similarByArtist.set(artist.id, similar);
    } catch (cause) {
      console.warn(`[lastfm] enrichissement de ${artist.id} abandonné :`, cause);
    }
  }

  const tagged = await persistArtistTags(admin, tagsByArtist);
  const similar = await persistSimilarity(admin, similarByArtist);

  return { tagged, similar };
}

/** Écrit `tags` puis `artist_tags`. Renvoie le nombre d'artistes tagués. */
async function persistArtistTags(
  admin: ReturnType<typeof createAdminClient>,
  tagsByArtist: Map<string, WeightedTag[]>,
): Promise<number> {
  if (tagsByArtist.size === 0) return 0;

  const names = new Set<string>();
  for (const tags of tagsByArtist.values()) {
    for (const tag of tags) names.add(tag.name);
  }

  // `ignoreDuplicates` est laissé à false : on a besoin que PostgREST renvoie
  // aussi les lignes déjà présentes pour récupérer leur `id`.
  const tagIds = new Map<string, number>();
  for (const batch of chunk([...names], DB_CHUNK)) {
    const rows: TablesInsert<"tags">[] = batch.map((name) => ({ name, source: SOURCE }));

    const { data, error } = await admin
      .from("tags")
      .upsert(rows, { onConflict: "name,source" })
      .select("id, name");

    if (error) throw new Error(`upsert tags : ${error.message}`);
    for (const row of data ?? []) tagIds.set(row.name, row.id);
  }

  const links = new Map<string, TablesInsert<"artist_tags">>();
  let tagged = 0;

  for (const [artistId, tags] of tagsByArtist) {
    let written = false;
    for (const tag of tags) {
      const tagId = tagIds.get(tag.name);
      if (tagId === undefined) continue;

      // Deux libellés Last.fm distincts peuvent se normaliser vers le même
      // tag ; sans cette déduplication, Postgres refuse tout le lot avec
      // « ON CONFLICT DO UPDATE cannot affect row a second time ».
      links.set(`${artistId}\u0000${tagId}`, {
        artist_id: artistId,
        tag_id: tagId,
        weight: tag.weight,
      });
      written = true;
    }
    if (written) tagged++;
  }

  for (const batch of chunk([...links.values()], DB_CHUNK)) {
    const { error } = await admin
      .from("artist_tags")
      .upsert(batch, { onConflict: "artist_id,tag_id" });
    if (error) throw new Error(`upsert artist_tags : ${error.message}`);
  }

  return tagged;
}

/** Écrit `artist_similarity`. Renvoie le nombre de liens conservés. */
async function persistSimilarity(
  admin: ReturnType<typeof createAdminClient>,
  similarByArtist: Map<string, SimilarArtist[]>,
): Promise<number> {
  if (similarByArtist.size === 0) return 0;

  const nameIndex = await loadArtistNameIndex(admin);

  const rows = new Map<string, TablesInsert<"artist_similarity">>();

  for (const [artistId, similars] of similarByArtist) {
    for (const similar of similars) {
      // `artist_similarity` référence `artists(id)` des deux côtés : on ne peut
      // écrire un lien que vers un artiste déjà présent dans notre catalogue.
      // Les inconnus sont ignorés sans bruit plutôt que créés à la volée, car
      // nous n'avons pas leur identifiant Spotify — seulement un nom Last.fm.
      // Insérer une ligne `artists` avec un id inventé polluerait durablement
      // la table clé du catalogue et casserait toute jointure ultérieure. Ces
      // voisins seront rattrapés naturellement : dès qu'un tel artiste entre
      // dans le catalogue par une écoute, le prochain passage crée le lien.
      const similarId = nameIndex.get(similar.name.toLowerCase());
      if (!similarId) continue;

      // La contrainte CHECK interdit l'auto-référence, et deux orthographes
      // voisines peuvent résoudre vers le même artiste.
      if (similarId === artistId) continue;

      rows.set(`${artistId}\u0000${similarId}`, {
        artist_id: artistId,
        similar_artist_id: similarId,
        score: similar.match,
        source: SOURCE,
      });
    }
  }

  if (rows.size === 0) return 0;

  for (const batch of chunk([...rows.values()], DB_CHUNK)) {
    const { error } = await admin
      .from("artist_similarity")
      .upsert(batch, { onConflict: "artist_id,similar_artist_id,source" });
    if (error) throw new Error(`upsert artist_similarity : ${error.message}`);
  }

  return rows.size;
}
