import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

/**
 * Depuis Next.js 16, le middleware s'appelle « Proxy » : le fichier est
 * `proxy.ts` et la fonction exportée `proxy`. Le comportement est inchangé.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  /**
   * On exclut les assets statiques et les images : les faire passer par le
   * proxy déclencherait une validation de session inutile à chaque fichier.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)",
  ],
};
