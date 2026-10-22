#!/usr/bin/env node
/**
 * 抓取塞壬唱片公开曲库，生成静态数据快照 public/data/catalog.json
 * 用法: node scripts/fetch-catalog.mjs
 * 需要代理时: MSR_PROXY=socks5h://127.0.0.1:10808 node scripts/fetch-catalog.mjs
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'https://monster-siren.hypergryph.com';
const PROXY = process.env.MSR_PROXY || '';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/catalog.json');
const CONCURRENCY = Number(process.env.MSR_CONCURRENCY || 8);

function get(path) {
  return new Promise((resolvePromise, reject) => {
    const args = ['-sS', '--max-time', '45', '--retry', '3', '--retry-delay', '2'];
    if (PROXY) args.push('-x', PROXY);
    args.push(HOST + path);
    execFile('curl', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const json = JSON.parse(stdout);
        if (json.code !== 0) throw new Error(`code ${json.code} ${json.msg || ''}`);
        resolvePromise(json.data);
      } catch (e) {
        reject(new Error(`${path} 解析失败: ${e.message}`));
      }
    });
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await worker(items[i], i);
        done++;
        if (done % 25 === 0 || done === items.length) {
          process.stdout.write(`\r  进度 ${done}/${items.length}`);
        }
      }
    })
  );
  process.stdout.write('\n');
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('拉取专辑列表…');
  const list = await get('/api/albums');
  console.log(`共 ${list.length} 张专辑`);

  const albums = await mapLimit(list, CONCURRENCY, async (album) => {
    let detail = null;
    for (let attempt = 0; attempt < 3 && !detail; attempt++) {
      try {
        detail = await get(`/api/album/${album.cid}/detail`);
      } catch (e) {
        await sleep(800);
      }
    }
    return { ...album, detail };
  });

  const songIds = albums.flatMap((a) => (a.detail?.songs || []).map((s) => s.cid));
  console.log(`共 ${songIds.length} 首曲目，拉取音频地址…`);

  const songData = {};
  await mapLimit(songIds, CONCURRENCY, async (cid) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        songData[cid] = await get(`/api/song/${cid}`);
        return;
      } catch {
        await sleep(800);
      }
    }
    songData[cid] = null;
  });

  const catalog = {
    generatedAt: new Date().toISOString(),
    source: HOST,
    albums: albums
      .filter((a) => a.detail)
      .map((a) => ({
        cid: a.cid,
        name: a.name,
        intro: a.detail.intro || '',
        belong: a.detail.belong || '',
        coverUrl: a.detail.coverUrl || a.coverUrl,
        coverDeUrl: a.detail.coverDeUrl || '',
        artistes: a.detail.artistes || a.artistes || [],
        songs: (a.detail.songs || []).map((s) => {
          const info = songData[s.cid];
          return {
            cid: s.cid,
            name: s.name,
            artistes: (info?.artists || s.artistes || []).join(' / '),
            albumCid: a.cid,
            albumName: a.name,
            albumCover: a.detail.coverUrl || a.coverUrl,
            sourceUrl: info?.sourceUrl || '',
            lyricUrl: info?.lyricUrl || '',
            /* 音频与歌词直链随快照一同保存，前端可直接播放 */
          };
        }),
      })),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(catalog));
  const songs = catalog.albums.reduce((n, a) => n + a.songs.length, 0);
  const size = (JSON.stringify(catalog).length / 1024).toFixed(0);
  console.log(`完成：${catalog.albums.length} 专辑 / ${songs} 曲目 / ${size} KB → ${OUT}`);
}

main().catch((e) => {
  console.error('\n失败:', e.message);
  process.exit(1);
});
