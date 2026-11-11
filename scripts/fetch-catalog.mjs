#!/usr/bin/env node
/**
 * 抓取塞壬唱片公开曲库，生成静态数据快照 public/data/catalog.json
 *
 * 线上曲库已改为运行时同步（worker/catalog.mjs + server/catalog.mjs），
 * 这个脚本现在只负责「铺底快照 / 离线兜底 / 对齐检查」：
 *   node scripts/fetch-catalog.mjs           重建快照
 *   node scripts/fetch-catalog.mjs --check   只比对官方与快照，有差异时退出码 1
 *
 * 需要代理时: MSR_PROXY=socks5h://127.0.0.1:10808 node scripts/fetch-catalog.mjs
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'https://monster-siren.hypergryph.com';
const PROXY = process.env.MSR_PROXY || '';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/catalog.json');
const CONCURRENCY = Number(process.env.MSR_CONCURRENCY || 8);
const CHECK_ONLY = process.argv.includes('--check');

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

/** 只比对、不落盘：用于「线上曲库是否真的追平官方」的验收 */
async function checkOnly() {
  console.log('拉取官方专辑列表…');
  const list = await get('/api/albums');
  let snapshot = null;
  try {
    snapshot = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    console.log('（本地还没有快照，无法比对）');
    process.exitCode = 1;
    return;
  }
  const local = new Map((snapshot.albums || []).map((a) => [String(a.cid), a]));
  const official = new Map(list.map((a) => [String(a.cid), a]));
  const added = [...official.keys()].filter((cid) => !local.has(cid));
  const removed = [...local.keys()].filter((cid) => !official.has(cid));
  const renamed = [...official.keys()].filter(
    (cid) => local.has(cid) && local.get(cid).name !== official.get(cid).name,
  );

  const localSongs = (snapshot.albums || []).reduce((n, a) => n + (a.songs?.length || 0), 0);
  console.log(
    `快照：${local.size} 张 / ${localSongs} 首（生成于 ${snapshot.generatedAt || '未知'}）`,
  );
  console.log(`官方：${official.size} 张`);

  for (const cid of added) {
    let songs = '?';
    try {
      const detail = await get(`/api/album/${cid}/detail`);
      songs = (detail.songs || []).length;
    } catch {
      /* 拿不到详情就只报名字 */
    }
    console.log(`  + ${cid}  ${official.get(cid).name}  (${songs} 首)`);
  }
  for (const cid of removed) console.log(`  - ${cid}  ${local.get(cid).name}`);
  for (const cid of renamed) console.log(`  ~ ${cid}  ${local.get(cid).name} → ${official.get(cid).name}`);

  if (!added.length && !removed.length && !renamed.length) {
    console.log('✓ 快照与官方一致');
    return;
  }
  console.log(`差异：新增 ${added.length} / 下架 ${removed.length} / 改名 ${renamed.length}`);
  console.log('（线上由运行时同步自行追平，这里只检查静态兜底快照是否需要重建）');
  process.exitCode = 1;
}

async function main() {
  if (CHECK_ONLY) {
    await checkOnly();
    return;
  }
  console.log('拉取专辑列表…');
  const list = await get('/api/albums');
  console.log(`共 ${list.length} 张专辑`);

  const albums = await mapLimit(list, CONCURRENCY, async (album) => {
    let detail = null;
    for (let attempt = 0; attempt < 3 && !detail; attempt++) {
      try {
        detail = await get(`/api/album/${album.cid}/detail`);
      } catch {
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
        /* 空数组也是 truthy：详情里偶发的空 artistes 不能覆盖列表接口给的名单 */
        artistes: a.detail.artistes?.length ? a.detail.artistes : a.artistes?.length ? a.artistes : [],
        songs: (a.detail.songs || []).map((s) => {
          const info = songData[s.cid];
          return {
            cid: s.cid,
            name: s.name,
            /* 与 buildAlbum 同规：空 artists 不能覆盖详情/上一级来源 */
            artistes: (info?.artists?.length ? info.artists : s.artistes?.length ? s.artistes : []).join(' / '),
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
