import Link from "next/link";
import { redirect } from "next/navigation";

import { isSpotifyConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * Messages d'erreur du retour OAuth.
 *
 * `not_allowlisted` mérite une explication détaillée : c'est le symptôme le
 * plus déroutant du mode développement de Spotify. La connexion réussit, puis
 * tous les appels API répondent 403 — sans explication, l'utilisateur conclut
 * que l'application est cassée.
 */
const ERROR_MESSAGES: Record<string, { title: string; detail: string }> = {
  not_allowlisted: {
    title: "This Spotify account isn't allowed yet",
    detail:
      "Spotify caps the app at 5 accounts, each declared by hand in the developer dashboard. Ask the administrator to add your Spotify account's email address, then try again.",
  },
  no_tokens: {
    title: "Spotify authorization was incomplete",
    detail:
      "Spotify didn't return an access token. That happens when the consent screen is skipped — try again to force it.",
  },
  profile_unavailable: {
    title: "Couldn't read your Spotify profile",
    detail:
      "Sign-in went through, but the Spotify API didn't answer. Try again in a moment.",
  },
  missing_code: {
    title: "Sign-in was interrupted",
    detail: "Spotify's response came back incomplete. Start the sign-in again.",
  },
  // Spotify renvoie `access_denied` aussi bien quand l'utilisateur clique sur
  // « Annuler » que lorsque son compte n'est pas déclaré dans l'allowlist du
  // mode développement. Le message doit couvrir les deux, sinon il envoie sur
  // une fausse piste.
  access_denied: {
    title: "Spotify didn't grant access",
    detail:
      "Two possible causes: either access was declined on the consent screen (you have to click “Agree”), or your Spotify account's email isn't on the list of allowed accounts — what counts is the address you sign in to Spotify with, which isn't always your usual one.",
  },
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) redirect("/app");

  const spotifyReady = isSpotifyConfigured();
  const { error } = await searchParams;
  const message = error
    ? (ERROR_MESSAGES[error] ?? {
        title: "Sign-in failed",
        detail: error,
      })
    : null;

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6 sm:py-16">
      <div className="w-full max-w-xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
          NextTrack
        </p>

        <h1 className="mt-4 text-4xl font-semibold leading-tight sm:text-5xl">
          Recommendations that don&apos;t go in circles.
        </h1>

        <p className="mt-5 text-lg leading-relaxed text-muted">
          NextTrack reads your listening history and your liked tracks, then
          learns from your 0-5 ratings to build a selection that stays true to
          your taste — and keeps surprising you.
        </p>

        {message && (
          <div
            role="alert"
            className="mt-8 rounded-lg border border-negative/30 bg-negative/10 p-4"
          >
            <p className="font-medium text-negative">{message.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {message.detail}
            </p>
          </div>
        )}

        <div className="mt-10">
          {spotifyReady ? (
            <>
              <Link
                href="/auth/login"
                className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 font-medium text-background transition hover:bg-accent-strong"
                prefetch={false}
              >
                Sign in with Spotify
              </Link>

              <p className="mt-4 text-sm text-muted">
                A <strong className="text-foreground">Premium</strong> Spotify
                account is required, and your account has to be allowed
                beforehand.
              </p>
            </>
          ) : (
            <div className="rounded-lg border border-border bg-surface p-5">
              <p className="font-medium">Setup unfinished</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                The Spotify app hasn&apos;t been configured yet. Create it in
                the developer dashboard, then copy the Client ID and Client
                Secret into{" "}
                <code className="font-mono text-xs text-foreground">
                  .env.local
                </code>
                .
              </p>
            </div>
          )}
        </div>

        <hr className="my-10 border-border" />

        <dl className="grid gap-6 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-medium">Your listening, measured</dt>
            <dd className="mt-1 text-muted">
              The time actually spent on each track, not just a list of what
              went by.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Your ratings count</dt>
            <dd className="mt-1 text-muted">
              0 for what you hate, 5 for the very best. The engine learns from
              what you reject too.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Variety guaranteed</dt>
            <dd className="mt-1 text-muted">
              Part of every selection is set aside for discovery, even when your
              taste is sharply defined.
            </dd>
          </div>
        </dl>

        <p className="mt-10 text-xs leading-relaxed text-muted">
          NextTrack isn&apos;t affiliated with Spotify. Your data stays on your
          instance and can be deleted at any time.
        </p>
      </div>
    </main>
  );
}
