import { evidenceSegments } from './evidence';

describe('evidenceSegments', () => {
  it('labels a web address with its host and keeps the trailing full stop as text', () => {
    expect(evidenceSegments('Listed at https://www.example.com/a/b.')).toEqual([
      { text: 'Listed at ', url: null },
      { text: 'example.com', url: 'https://www.example.com/a/b' },
      { text: '.', url: null },
    ]);
  });

  it('turns a bare OpenStreetMap reference into a link to the object', () => {
    expect(evidenceSegments('OSM maps it (way/391787112, node/12).')).toEqual([
      { text: 'OSM maps it (', url: null },
      { text: 'way/391787112', url: 'https://www.openstreetmap.org/way/391787112' },
      { text: ', ', url: null },
      { text: 'node/12', url: 'https://www.openstreetmap.org/node/12' },
      { text: ').', url: null },
    ]);
  });

  it('keeps an openstreetmap.org address as a single link', () => {
    const segs = evidenceSegments('See https://www.openstreetmap.org/node/9811266167 here');
    expect(segs.filter((s) => s.url)).toEqual([
      { text: 'openstreetmap.org', url: 'https://www.openstreetmap.org/node/9811266167' },
    ]);
  });

  it('leaves a word that merely ends in "way" alone', () => {
    expect(evidenceSegments('Highway/12 and relationship/3')).toEqual([{ text: 'Highway/12 and relationship/3', url: null }]);
  });

  it('returns plain text unchanged', () => {
    expect(evidenceSegments('No source.')).toEqual([{ text: 'No source.', url: null }]);
  });
});
