/**
 * Squelette de filets : des rectangles hairline, pas de shimmer — la page se
 * dessine comme une maquette de journal en attendant la relève des flux.
 */
export default function Chargement() {
  return (
    <div aria-busy className="space-y-10 py-10">
      <div className="space-y-4">
        <div className="h-3 w-44 bg-filet-faible" />
        <div className="h-14 w-4/5 bg-filet-faible" />
        <div className="h-14 w-3/5 bg-filet-faible" />
        <div className="h-3 w-2/3 bg-filet-faible" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid grid-cols-1 gap-6 border-t border-filet-faible pt-8 lg:grid-cols-3">
          {[0, 1, 2].map((j) => (
            <div key={j} className="space-y-3">
              <div className="aspect-[3/2] w-full bg-filet-faible" />
              <div className="h-3 w-32 bg-filet-faible" />
              <div className="h-5 w-full bg-filet-faible" />
              <div className="h-5 w-2/3 bg-filet-faible" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
