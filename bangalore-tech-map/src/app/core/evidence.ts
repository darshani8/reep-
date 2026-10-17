/** One run of an evidence sentence: plain text, or a label with the link it stands for. */
export interface EvidenceSegment {
  text: string;
  url: string | null;
}

/**
 * A web address, or a bare OpenStreetMap object reference such as `way/391787112`. Most offices found
 * in the OSM extract cite the object rather than a URL, and the reference is just as checkable once it
 * is a link. The address alternative comes first, so an openstreetmap.org URL stays one link.
 */
const LINK_RE = /(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])|(?<![\w/])((?:node|way|relation)\/\d+)\b/g;

/** Splits an evidence sentence into text and links, for rendering without innerHTML. */
export function evidenceSegments(source: string): EvidenceSegment[] {
  const out: EvidenceSegment[] = [];
  let last = 0;
  for (const m of source.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: source.slice(last, start), url: null });
    if (m[1]) {
      let host = m[1];
      try {
        host = new URL(m[1]).hostname.replace(/^www\./, '');
      } catch {
        /* keep the raw address as the label */
      }
      out.push({ text: host, url: m[1] });
    } else {
      out.push({ text: m[2], url: `https://www.openstreetmap.org/${m[2]}` });
    }
    last = start + m[0].length;
  }
  if (last < source.length) out.push({ text: source.slice(last), url: null });
  return out;
}
