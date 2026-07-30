/**
 * Origine publique de l'application.
 *
 * `request.nextUrl.origin` ne vaut rien derrière un proxy : il reflète
 * l'adresse d'écoute du processus, pas celle que voit l'utilisateur. Vercel
 * réécrit les en-têtes pour masquer le problème ; Railway non — et le retour
 * OAuth partait vers `https://localhost:8080`, où personne n'écoute.
 *
 * `NEXT_PUBLIC_SITE_URL` est la source de vérité : c'est elle qui doit
 * correspondre aux Redirect URLs déclarées côté Supabase. Le repli sur
 * l'origine de la requête ne sert qu'au développement local, où la variable
 * peut différer du port réellement utilisé.
 */
export function publicOrigin(requestOrigin: string): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (!configured) return requestOrigin;
  // Sans cette normalisation, une barre oblique finale dans la variable
  // produirait des URL en `//auth/callback`, que Supabase refuserait.
  return configured.replace(/\/+$/, "");
}
