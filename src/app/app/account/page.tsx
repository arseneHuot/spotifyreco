import Link from "next/link";
import { redirect } from "next/navigation";

import { deleteAccount, signOut } from "@/app/app/account/actions";
import { formatDate } from "@/lib/format";
import { getAccountSummary } from "@/lib/spotify/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) redirect("/");

  const account = await getAccountSummary(user.id);

  const [listens, ratings, saved] = await Promise.all([
    supabase
      .from("listens")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id),
    supabase
      .from("ratings")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id),
    supabase
      .from("saved_tracks")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id),
  ]);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
      <Link href="/app" className="text-sm text-muted hover:text-foreground">
        ← Back
      </Link>

      <h1 className="mt-6 text-2xl font-semibold">My account</h1>

      <section className="mt-8 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-medium">Linked Spotify account</h2>
        <dl className="mt-3 space-y-1.5 text-sm">
          <Row label="User ID" value={account?.spotifyUserId ?? "—"} />
          <Row
            label="Plan"
            value={account?.product ?? "unknown"}
          />
          <Row
            label="Authorized on"
            value={account ? formatDate(account.authorizedAt) : "—"}
          />
          <Row
            label="Reconnect before"
            value={account ? formatDate(account.reauthDueAt) : "—"}
          />
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Spotify access tokens are encrypted and readable only by the server.
          You can revoke access at any time from your Spotify account
          settings.
        </p>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-medium">Collected data</h2>
        <dl className="mt-3 space-y-1.5 text-sm">
          <Row label="Listens" value={String(listens.count ?? 0)} />
          <Row label="Ratings" value={String(ratings.count ?? 0)} />
          <Row label="Liked tracks" value={String(saved.count ?? 0)} />
        </dl>
      </section>

      <section className="mt-6 flex flex-wrap gap-3">
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium transition hover:bg-surface-hover"
          >
            Sign out
          </button>
        </form>
      </section>

      <section className="mt-10 rounded-lg border border-negative/30 bg-negative/5 p-5">
        <h2 className="font-medium text-negative">Delete my account</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Permanently deletes your account, your listens, your ratings and
          your Spotify tokens. This cannot be undone and takes effect
          immediately.
        </p>
        <form action={deleteAccount} className="mt-4">
          <button
            type="submit"
            className="rounded-full bg-negative px-4 py-2 text-sm font-medium text-background transition hover:opacity-90"
          >
            Delete permanently
          </button>
        </form>
      </section>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-mono text-xs">{value}</dd>
    </div>
  );
}
