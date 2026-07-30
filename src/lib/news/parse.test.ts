import { describe, expect, it } from "vitest";

import { decodeEntities, decodeXmlBuffer, parseFeed } from "./parse";

const rssItem = (body: string) =>
  `<?xml version="1.0"?><rss><channel><item>${body}</item></channel></rss>`;

describe("parseFeed (RSS 2.0)", () => {
  it("extrait titre, lien, description et date d'un item classique", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>Un titre</title>
         <link>https://exemple.fr/article</link>
         <description>Le r&eacute;sum&eacute;.</description>
         <pubDate>Mon, 27 Jul 2026 08:30:00 +0200</pubDate>`,
      ),
    );
    expect(item.title).toBe("Un titre");
    expect(item.link).toBe("https://exemple.fr/article");
    expect(item.description).toBe("Le résumé.");
    expect(item.publishedAt).toBe("2026-07-27T06:30:00.000Z");
  });

  it("gère les CDATA et retire le HTML des descriptions", () => {
    const [item] = parseFeed(
      rssItem(
        `<title><![CDATA[Titre « chic » &amp; net]]></title>
         <link>https://exemple.fr/a</link>
         <description><![CDATA[<p>Du <strong>gras</strong>&nbsp;!</p>]]></description>`,
      ),
    );
    expect(item.title).toBe("Titre « chic » & net");
    expect(item.description).toBe("Du gras !");
  });

  it("décode le HTML doublement échappé des descriptions", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>T</title><link>https://exemple.fr/b</link>
         <description>&lt;p&gt;Texte &amp;eacute;chapp&amp;eacute;&lt;/p&gt;</description>`,
      ),
    );
    expect(item.description).toBe("Texte échappé");
  });

  it("trouve l'image en media:content, enclosure ou img inline", () => {
    const media = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/1</link>
         <media:content url="https://img.e.fr/a.jpg" width="640"/>`,
      ),
    )[0];
    expect(media.image).toBe("https://img.e.fr/a.jpg");

    const enclosure = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/2</link>
         <enclosure url="https://img.e.fr/b.jpg" type="image/jpeg" length="1"/>`,
      ),
    )[0];
    expect(enclosure.image).toBe("https://img.e.fr/b.jpg");

    const inline = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/3</link>
         <description><![CDATA[<img src="https://img.e.fr/c.jpg" />texte]]></description>`,
      ),
    )[0];
    expect(inline.image).toBe("https://img.e.fr/c.jpg");
  });

  it("lit l'URL en texte d'un enclosure non standard (La Tribune)", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/lt</link>
         <enclosure>https://img.e.fr/tribune.jpg</enclosure>
         <pubDate>2026-07-28T12:24:35+02:00</pubDate>`,
      ),
    );
    expect(item.image).toBe("https://img.e.fr/tribune.jpg");
    expect(item.publishedAt).toBe("2026-07-28T10:24:35.000Z");
  });

  it("ignore les enclosures non-image", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/4</link>
         <enclosure url="https://e.fr/pod.mp3" type="audio/mpeg" length="1"/>`,
      ),
    );
    expect(item.image).toBeNull();
  });

  it("écarte les items sans titre ou sans lien", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Sans lien</title></item>
      <item><link>https://e.fr/sans-titre</link></item>
      <item><title>Complet</title><link>https://e.fr/ok</link></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Complet");
  });

  it("tolère une date invalide sans rejeter l'item", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/5</link><pubDate>n'importe quoi</pubDate>`,
      ),
    );
    expect(item.publishedAt).toBeNull();
  });
});

describe("parseFeed (Atom)", () => {
  it("extrait les entrées avec lien en attribut href", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Entrée Atom</title>
          <link rel="alternate" href="https://e.fr/atom"/>
          <summary>Résumé atom</summary>
          <published>2026-07-27T10:00:00Z</published>
        </entry>
      </feed>`;
    const [item] = parseFeed(xml);
    expect(item.title).toBe("Entrée Atom");
    expect(item.link).toBe("https://e.fr/atom");
    expect(item.description).toBe("Résumé atom");
    expect(item.publishedAt).toBe("2026-07-27T10:00:00.000Z");
  });
});

describe("decodeEntities", () => {
  it("décode entités numériques, hexadécimales et nommées", () => {
    expect(decodeEntities("&#233;t&#xE9; &eacute;chu &amp; fini")).toBe(
      "été échu & fini",
    );
  });

  it("laisse intactes les entités inconnues", () => {
    expect(decodeEntities("&inconnue;")).toBe("&inconnue;");
  });

  it("laisse intactes les entités hors plage Unicode au lieu de lever", () => {
    // Sans garde-fou, String.fromCodePoint lève et emporte tout le flux.
    expect(decodeEntities("a&#x110000;b")).toBe("a&#x110000;b");
    expect(decodeEntities("a&#9999999999;b")).toBe("a&#9999999999;b");
    expect(decodeEntities("a&#xD800;b")).toBe("a&#xD800;b");
  });
});

describe("robustesse du découpage", () => {
  it("survit à une entité hors plage sans perdre les autres items", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Titre &#x110000; piégé</title><link>https://e.fr/1</link></item>
      <item><title>Titre sain</title><link>https://e.fr/2</link></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(2);
    expect(items[1].title).toBe("Titre sain");
  });

  it("reste linéaire sur des balises jamais refermées", () => {
    const xml = "<item><title>x</title>".repeat(50_000); // ~1 Mo
    const t0 = performance.now();
    expect(parseFeed(xml)).toHaveLength(0);
    // Le découpage par regex paresseuse mettait ~3 s ici.
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it("borne le nombre d'items d'un flux démesuré", () => {
    const item = "<item><title>T</title><link>https://e.fr/x</link></item>";
    expect(parseFeed(item.repeat(1000)).length).toBeLessThanOrEqual(400);
  });

  it("écarte les liens non http(s)", () => {
    const items = parseFeed(
      rssItem(
        `<title>Piégé</title><link>javascript:alert(1)</link>`,
      ),
    );
    expect(items).toHaveLength(0);
  });

  it("écarte une image en URL non http(s)", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/ok</link>
         <media:content url="javascript:alert(1)"/>`,
      ),
    );
    expect(item.image).toBeNull();
  });
});

describe("fidélité du texte", () => {
  it("respecte la casse des entités nommées accentuées", () => {
    expect(decodeEntities("&Eacute;cole et &eacute;t&eacute;")).toBe(
      "École et été",
    );
  });

  it("décode aussi les entités hexadécimales en X majuscule", () => {
    expect(decodeEntities("&#X41;")).toBe("A");
  });

  it("garde les chevrons de comparaison des titres économiques", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>Croissance &lt;2 % mais &gt;3 % pour 2027</title>
         <link>https://e.fr/c</link>`,
      ),
    );
    expect(item.title).toBe("Croissance <2 % mais >3 % pour 2027");
  });
});

describe("choix de l'image", () => {
  it("ignore un media:content vidéo et prend l'image suivante", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/d</link>
         <media:content url="https://e.fr/clip.mp4" type="video/mp4" medium="video"/>
         <media:content url="https://img.e.fr/vignette.jpg" medium="image"/>`,
      ),
    );
    expect(item.image).toBe("https://img.e.fr/vignette.jpg");
  });

  it("ramène une URL relative au protocole en https", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/e</link>
         <media:content url="//img.e.fr/a.jpg"/>`,
      ),
    );
    expect(item.image).toBe("https://img.e.fr/a.jpg");
  });

  it("retombe sur l'img de la description si media:content est inutilisable", () => {
    const [item] = parseFeed(
      rssItem(
        `<title>T</title><link>https://e.fr/f</link>
         <media:content url="data:image/gif;base64,AAAA"/>
         <description><![CDATA[<img src="https://img.e.fr/b.jpg">]]></description>`,
      ),
    );
    expect(item.image).toBe("https://img.e.fr/b.jpg");
  });
});

describe("decodeXmlBuffer", () => {
  it("décode l'ISO-8859-1 déclaré dans le Content-Type", () => {
    const latin1 = new Uint8Array([0xe9, 0x74, 0xe9]); // "été"
    expect(
      decodeXmlBuffer(latin1.buffer, "text/xml; charset=ISO-8859-1"),
    ).toBe("été");
  });

  it("décode l'ISO-8859-1 déclaré dans le prologue XML", () => {
    const prologue = `<?xml version="1.0" encoding="ISO-8859-1"?><rss>`;
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(prologue.replace("<rss>", "")),
      0xe9,
    ]);
    expect(decodeXmlBuffer(bytes.buffer, "text/xml")).toContain("é");
  });

  it("laisse l'UTF-8 intact par défaut", () => {
    const bytes = new TextEncoder().encode("déjà ✓");
    expect(decodeXmlBuffer(bytes.buffer, null)).toBe("déjà ✓");
  });
});
