// Merges Instagram's separate DASH video and audio tracks into one MP4, without re-encoding.
//
// Both inputs are fragmented MP4s (ftyp, moov, sidx, then moof+mdat pairs) whose fragments address
// their samples relative to their own moof (default-base-is-moof). So the merge only has to:
//   - build one moov holding both tracks (audio renumbered to track 2, its movie-level durations
//     rescaled to the video's movie timescale), with a trex per track,
//   - copy every moof+mdat pair unchanged except for its sequence number and (audio) track id,
//     interleaved by decode time so players don't have to jump around the file.
// The optional sidx index is dropped.

interface Box {
  type: string;
  start: number;
  end: number;
  /** Where the payload starts (after the size/type header). */
  body: number;
}

function readBoxes(data: Uint8Array, start = 0, end = data.length): Box[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const boxes: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = view.getUint32(p);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) throw new Error('Corrupt MP4');
    const type = String.fromCharCode(data[p + 4], data[p + 5], data[p + 6], data[p + 7]);
    boxes.push({ type, start: p, end: p + size, body: p + header });
    p += size;
  }
  return boxes;
}

function child(data: Uint8Array, parent: Box, type: string): Box {
  const found = readBoxes(data, parent.body, parent.end).find((b) => b.type === type);
  if (!found) throw new Error(`Missing ${type} box`);
  return found;
}

/** Follows a path of box types from a parent, e.g. ['mdia', 'mdhd']. */
function path(data: Uint8Array, parent: Box, types: string[]): Box {
  return types.reduce((box, type) => child(data, box, type), parent);
}

function copy(data: Uint8Array, box: Box): Uint8Array {
  return data.slice(box.start, box.end);
}

function concat(type: string, parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Field accessors for full boxes (1 byte version + 3 bytes flags after the 8 byte header).
// A box copied on its own has its header at offset 0.
const viewOf = (box: Uint8Array) => new DataView(box.buffer, box.byteOffset, box.byteLength);
const version = (box: Uint8Array) => box[8];

function readUint(view: DataView, offset: number, wide: boolean): number {
  return wide ? Number(view.getBigUint64(offset)) : view.getUint32(offset);
}

function writeUint(view: DataView, offset: number, wide: boolean, value: number): void {
  if (wide) view.setBigUint64(offset, BigInt(Math.round(value)));
  else view.setUint32(offset, Math.min(Math.round(value), 0xffffffff));
}

/** mvhd/mdhd: timescale and duration (same layout for both). */
function timing(box: Uint8Array): { timescale: number; duration: number } {
  const v = viewOf(box);
  const wide = version(box) === 1;
  const timescale = v.getUint32(wide ? 28 : 20);
  return { timescale, duration: readUint(v, wide ? 32 : 24, wide) };
}

interface Track {
  data: Uint8Array;
  movieTimescale: number;
  movieDuration: number;
  mediaTimescale: number;
  trak: Box;
  mvhd: Box;
  mehd: Box | null;
  trex: Box;
  ftyp: Box;
  fragments: { moof: Box; mdat: Box }[];
}

function parseTrack(data: Uint8Array): Track {
  const top = readBoxes(data);
  const find = (type: string) => {
    const box = top.find((b) => b.type === type);
    if (!box) throw new Error(`Missing ${type} box`);
    return box;
  };
  const moov = find('moov');
  const mvhd = child(data, moov, 'mvhd');
  const trak = child(data, moov, 'trak');
  const mvex = child(data, moov, 'mvex');
  const movie = timing(copy(data, mvhd));
  const fragments: Track['fragments'] = [];
  top.forEach((box, i) => {
    if (box.type === 'moof' && top[i + 1]?.type === 'mdat') fragments.push({ moof: box, mdat: top[i + 1] });
  });
  if (fragments.length === 0) throw new Error('Not a fragmented MP4');
  return {
    data,
    movieTimescale: movie.timescale,
    movieDuration: movie.duration,
    mediaTimescale: timing(copy(data, path(data, trak, ['mdia', 'mdhd']))).timescale,
    trak,
    mvhd,
    mehd: readBoxes(data, mvex.body, mvex.end).find((b) => b.type === 'mehd') ?? null,
    trex: child(data, mvex, 'trex'),
    ftyp: find('ftyp'),
    fragments,
  };
}

/** Copy of the audio trak with its track id and movie-timescale durations rewritten. */
function retimedTrak(track: Track, trackId: number, scale: number): Uint8Array {
  const out = copy(track.data, track.trak);
  const shift = track.trak.start;
  const at = (box: Box) => new DataView(out.buffer, box.start - shift, box.end - box.start);

  const tkhd = child(track.data, track.trak, 'tkhd');
  const tv = at(tkhd);
  const wide = out[tkhd.start - shift + 8] === 1;
  tv.setUint32(wide ? 28 : 20, trackId);
  writeUint(tv, wide ? 36 : 28, wide, readUint(tv, wide ? 36 : 28, wide) * scale);

  // Edit list segment durations are in the movie timescale too.
  const edts = readBoxes(track.data, track.trak.body, track.trak.end).find((b) => b.type === 'edts');
  const elst = edts && readBoxes(track.data, edts.body, edts.end).find((b) => b.type === 'elst');
  if (elst) {
    const ev = at(elst);
    const ewide = out[elst.start - shift + 8] === 1;
    const count = ev.getUint32(12);
    const entrySize = ewide ? 20 : 12;
    for (let i = 0; i < count; i++) {
      const offset = 16 + i * entrySize;
      writeUint(ev, offset, ewide, readUint(ev, offset, ewide) * scale);
    }
  }
  return out;
}

/** Merges a fragmented-MP4 video track and audio track into one playable MP4. */
export function mergeTracks(videoData: Uint8Array, audioData: Uint8Array): Blob {
  const video = parseTrack(videoData);
  const audio = parseTrack(audioData);
  const scale = video.movieTimescale / audio.movieTimescale;

  const mvhd = copy(video.data, video.mvhd);
  const mv = viewOf(mvhd);
  const wide = version(mvhd) === 1;
  writeUint(mv, wide ? 32 : 24, wide, Math.max(video.movieDuration, audio.movieDuration * scale));
  mv.setUint32(mvhd.length - 4, 3); // next_track_ID

  const mvexParts: Uint8Array[] = [];
  if (video.mehd) {
    const mehd = copy(video.data, video.mehd);
    const hv = viewOf(mehd);
    const hwide = version(mehd) === 1;
    const audioFragmentDuration = audio.mehd
      ? readUint(viewOf(copy(audio.data, audio.mehd)), 12, version(copy(audio.data, audio.mehd)) === 1) * scale
      : 0;
    writeUint(hv, 12, hwide, Math.max(readUint(hv, 12, hwide), audioFragmentDuration));
    mvexParts.push(mehd);
  }
  const audioTrex = copy(audio.data, audio.trex);
  viewOf(audioTrex).setUint32(12, 2);
  mvexParts.push(copy(video.data, video.trex), audioTrex);

  const moov = concat('moov', [
    mvhd,
    copy(video.data, video.trak),
    retimedTrak(audio, 2, scale),
    concat('mvex', mvexParts),
  ]);

  // Fragments from both tracks, ordered by decode time.
  const fragments = [
    ...video.fragments.map((f) => ({ ...f, track: video, trackId: 1 })),
    ...audio.fragments.map((f) => ({ ...f, track: audio, trackId: 2 })),
  ].map((f) => {
    const moof = copy(f.track.data, f.moof);
    const traf = child(moof, readBoxes(moof)[0], 'traf');
    const tfdt = child(moof, traf, 'tfdt');
    const time = readUint(viewOf(moof), tfdt.start + 12, moof[tfdt.start + 8] === 1) / f.track.mediaTimescale;
    if (f.trackId !== 1) viewOf(moof).setUint32(child(moof, traf, 'tfhd').start + 12, f.trackId);
    return { moof, mdat: f.track.data.subarray(f.mdat.start, f.mdat.end), time, trackId: f.trackId };
  });
  fragments.sort((a, b) => a.time - b.time || a.trackId - b.trackId);

  const parts: Uint8Array[] = [copy(video.data, video.ftyp), moov];
  fragments.forEach((f, i) => {
    const mfhd = child(f.moof, readBoxes(f.moof)[0], 'mfhd');
    viewOf(f.moof).setUint32(mfhd.start + 12, i + 1); // sequence_number
    parts.push(f.moof, f.mdat);
  });
  return new Blob(parts as BlobPart[], { type: 'video/mp4' });
}
