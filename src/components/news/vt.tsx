import * as React from "react";

type VTProps = {
  name?: string;
  children: React.ReactNode;
};

/**
 * `ViewTransition` existe dans le React canary embarqué par l'App Router
 * (cf. node_modules/next/dist/docs/01-app/02-guides/view-transitions.md) mais
 * pas encore dans @types/react ni forcément sous le même nom selon le canal.
 * On le résout à l'exécution, avec un passe-plat en secours : sans lui, la
 * navigation fonctionne à l'identique, simplement sans animation.
 */
const reactAvecVT = React as unknown as {
  ViewTransition?: React.ComponentType<VTProps>;
  unstable_ViewTransition?: React.ComponentType<VTProps>;
};

export const VT: React.ComponentType<VTProps> =
  reactAvecVT.ViewTransition ??
  reactAvecVT.unstable_ViewTransition ??
  (({ children }) => <>{children}</>);
