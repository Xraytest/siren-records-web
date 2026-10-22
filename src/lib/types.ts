export interface AlbumSongRef {
  cid: string
  name: string
  artistes: string
  albumCid?: string
  albumName?: string
  albumCover?: string
  sourceUrl?: string
  lyricUrl?: string
}

export interface Album {
  cid: string
  name: string
  intro: string
  belong: string
  coverUrl: string
  coverDeUrl: string
  artistes: string[]
  songs: AlbumSongRef[]
}

export interface Song {
  cid: string
  name: string
  artistes: string
  albumCid: string
  albumName: string
  albumCover: string
  sourceUrl: string
  lyricUrl: string
}

export interface Catalog {
  generatedAt: string
  source: string
  albums: Album[]
}

export interface User {
  id: string
  name: string
  handle: string
  bio: string
  salt: string
  hash: string
  createdAt: number
}

export interface Session {
  userId: string
  since: number
}

export interface Playlist {
  id: string
  name: string
  description: string
  tags: string[]
  coverSongCid: string | null
  songs: string[]
  createdAt: number
  updatedAt: number
  publishedAt: number | null
  publishCode: string | null
}

export interface FeedItem {
  code: string
  name: string
  description: string
  authorName: string
  authorId: string
  songCount: number
  cover: string | null
  tags: string[]
  at: number
}

export interface SharePayload {
  v: 1
  t: 'siren-playlist'
  name: string
  desc: string
  author: string
  tags: string[]
  cover: string | null
  songs: string[]
  at: number
}

export interface LyricLine {
  time: number
  text: string
}
