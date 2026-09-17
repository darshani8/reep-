#!/usr/bin/env node
/**
 * Encode one captured segment to MP4 and lay its narration onto it.
 *
 *   node tools/demo/mix-narration.mjs <out-dir> <segment>
 *
 * Reads <out-dir>/<segment>.webm and <out-dir>/narration/<segment>.json (the
 * recorder's log of when each spoken line appeared, and which clip says it).
 * Each clip starts at its logged time; a clip that would run into the next one
 * is sped up a little (never more than 1.3x) rather than cut. A segment with
 * no narration gets a silent track, so every MP4 has the same audio shape and
 * render.sh can concatenate them without re-encoding.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const [outDir, segment] = process.argv.slice(2);
if (!outDir || !segment) { console.error('usage: mix-narration.mjs <out-dir> <segment>'); process.exit(2); }
const video = path.join(outDir, `${segment}.webm`);
const target = path.join(outDir, `${segment}.mp4`);
const log = path.join(outDir, 'narration', `${segment}.json`);
const clips = path.join(outDir, 'narration', 'clips');

const probe = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
const videoSeconds = probe(video);
const VIDEO = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '25', '-pix_fmt', 'yuv420p', '-r', '25', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];
const AUDIO = ['-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '1'];

let items = [];
if (fs.existsSync(log)) {
  items = JSON.parse(fs.readFileSync(log, 'utf8')).items
    .map((it) => ({ ...it, path: path.join(clips, it.file) }))
    .filter((it) => fs.existsSync(it.path))
    .sort((a, b) => a.at - b.at);
}

let args;
if (items.length === 0) {
  args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-map', '0:v', '-map', '1:a', '-shortest', ...VIDEO, ...AUDIO, '-movflags', '+faststart', target];
} else {
  const inputs = ['-i', video];
  const chains = [];
  const labels = [];
  items.forEach((it, i) => {
    inputs.push('-i', it.path);
    const dur = probe(it.path);
    const next = items[i + 1];
    const room = next ? (next.at - it.at) / 1000 - 0.35 : Infinity;
    const tempo = room > 0 && dur > room ? Math.min(1.3, dur / room) : 1;
    const delay = Math.max(0, Math.round(it.at));
    chains.push(`[${i + 1}:a]${tempo > 1 ? `atempo=${tempo.toFixed(3)},` : ''}adelay=${delay}|${delay}[a${i}]`);
    labels.push(`[a${i}]`);
  });
  const graph = `${chains.join(';')};${labels.join('')}amix=inputs=${items.length}:normalize=0:duration=longest,apad=whole_dur=${videoSeconds.toFixed(3)}[mix]`;
  args = ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '0:v', '-map', '[mix]',
    '-t', videoSeconds.toFixed(3), ...VIDEO, ...AUDIO, '-movflags', '+faststart', target];
}
const run = spawnSync('ffmpeg', args, { stdio: 'inherit' });
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(`${segment}.mp4 · ${items.length} spoken lines`);
