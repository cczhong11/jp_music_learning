import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import KuroshiroModule from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

const readingEngine = new KuroshiroModule.default();
const readingEngineReady = readingEngine.init(new KuromojiAnalyzer());

const supportedAudioTypes = new Map([
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
]);

export function createServer({ dataDir, translator = translateLyricsWithOpenAI, nasMusicDir = process.env.NAS_MUSIC_DIR || "/music" }) {
  const store = createStore(dataDir, translator, nasMusicDir);

  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/") {
        return sendHtml(response, libraryPage());
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, store.health());
      }

      if (request.method === "GET" && url.pathname === "/api/songs") {
        return sendJson(response, 200, store.listSongs());
      }

      const songMatch = url.pathname.match(/^\/api\/songs\/([\w-]+)$/);
      if (request.method === "GET" && songMatch) {
        await store.ensureReadings(songMatch[1]);
        const song = store.getSong(songMatch[1]);
        return song ? sendJson(response, 200, song) : sendJson(response, 404, { error: "Song was not found." });
      }

      if (request.method === "DELETE" && songMatch) {
        store.deleteSong(songMatch[1]);
        return sendJson(response, 200, { ok: true });
      }

      const translateSongMatch = url.pathname.match(/^\/api\/songs\/([\w-]+)\/translate$/);
      if (request.method === "POST" && translateSongMatch) {
        return sendJson(response, 200, await store.translateSong(translateSongMatch[1]));
      }

      const mediaMatch = url.pathname.match(/^\/api\/songs\/([\w-]+)\/media$/);
      if (request.method === "GET" && mediaMatch) {
        const media = store.getSongMedia(mediaMatch[1]);
        if (!media) return sendJson(response, 404, { error: "Song media was not found." });
        return streamMedia(request, response, media);
      }

      if (request.method === "POST" && url.pathname === "/api/songs") {
        const fields = await readMultipartForm(request);
        const song = await store.addSong(fields);
        return sendJson(response, 201, song);
      }

      if (request.method === "GET" && url.pathname === "/api/nas/songs") {
        return sendJson(response, 200, store.listNasSongs());
      }
      if (request.method === "POST" && url.pathname === "/api/nas/import") {
        return sendJson(response, 201, await store.importNasSongs(await readJson(request)));
      }

      const progressMatch = url.pathname.match(/^\/api\/lyrics\/([\w-]+)\/practice$/);
      if (request.method === "POST" && progressMatch) {
        return sendJson(response, 200, store.recordPractice(progressMatch[1]));
      }

      const lyricMatch = url.pathname.match(/^\/api\/lyrics\/([\w-]+)$/);
      if (request.method === "PATCH" && lyricMatch) {
        return sendJson(response, 200, store.updateLyric(lyricMatch[1], await readJson(request)));
      }

      if (request.method === "GET" && url.pathname === "/api/preferences") {
        return sendJson(response, 200, store.getPreferences());
      }
      if (request.method === "PUT" && url.pathname === "/api/preferences") {
        return sendJson(response, 200, store.savePreferences(await readJson(request)));
      }

      if (request.method === "POST" && url.pathname === "/api/recordings") {
        return sendJson(response, 201, store.addRecording(await readMultipartForm(request)));
      }
      const recordingMatch = url.pathname.match(/^\/api\/recordings\/([\w-]+)\/media$/);
      if (request.method === "GET" && recordingMatch) {
        const media = store.getRecordingMedia(recordingMatch[1]);
        return media ? streamMedia(request, response, media) : sendJson(response, 404, { error: "Recording was not found." });
      }
      const recordingsMatch = url.pathname.match(/^\/api\/lyrics\/([\w-]+)\/recordings$/);
      if (request.method === "GET" && recordingsMatch) return sendJson(response, 200, store.listRecordings(recordingsMatch[1]));
      const recordingDeleteMatch = url.pathname.match(/^\/api\/recordings\/([\w-]+)$/);
      if (request.method === "DELETE" && recordingDeleteMatch) {
        store.deleteRecording(recordingDeleteMatch[1]);
        return sendJson(response, 200, { ok: true });
      }

      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error.status ?? (error instanceof InputError ? 400 : 500);
      return sendJson(response, status, { error: error.message });
    }
  });
}

function createStore(dataDir, translator, nasMusicDir) {
  const mediaDir = join(dataDir, "media");
  const recordingsDir = join(dataDir, "recordings");
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(recordingsDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "learning.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL DEFAULT '',
      original_filename TEXT NOT NULL,
      media_filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      lyric_line_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
    ;
    CREATE TABLE IF NOT EXISTS lyrics (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      start_seconds REAL NOT NULL,
      text TEXT NOT NULL,
      kana TEXT NOT NULL DEFAULT '',
      romaji TEXT NOT NULL DEFAULT '',
      translation TEXT NOT NULL DEFAULT '',
      UNIQUE(song_id, position)
    );
    CREATE TABLE IF NOT EXISTS progress (
      lyric_id TEXT PRIMARY KEY,
      practice_count INTEGER NOT NULL DEFAULT 0,
      last_practiced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS preferences (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      speed REAL NOT NULL DEFAULT 1,
      gap_seconds REAL NOT NULL DEFAULT 1,
      lead_seconds REAL NOT NULL DEFAULT .15,
      tail_seconds REAL NOT NULL DEFAULT .25,
      show_romaji INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      lyric_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO preferences (singleton) VALUES (1)
  `);
  if (!db.prepare("PRAGMA table_info(songs)").all().some((column) => column.name === "source_path")) db.exec("ALTER TABLE songs ADD COLUMN source_path TEXT NOT NULL DEFAULT ''");

  const insert = db.prepare(`
    INSERT INTO songs (id, title, artist, original_filename, media_filename, media_type, source_path, lyric_line_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const list = db.prepare(`
    SELECT s.id, s.title, s.artist, s.original_filename AS originalFilename, s.media_type AS mediaType,
      s.lyric_line_count AS lyricLineCount, s.created_at AS createdAt,
      COALESCE(SUM(CASE WHEN p.practice_count > 0 THEN 1 ELSE 0 END), 0) AS practicedLineCount
    FROM songs s LEFT JOIN lyrics l ON l.song_id = s.id LEFT JOIN progress p ON p.lyric_id = l.id
    GROUP BY s.id ORDER BY s.created_at DESC
  `);

  return {
    listSongs() {
      return list.all();
    },
    health() {
      db.prepare("SELECT 1").get();
      return { ok: true, storage: existsSync(mediaDir), nasMusic: existsSync(nasMusicDir) };
    },
    getSong(id) {
      const song = db.prepare(`SELECT id, title, artist, media_type AS mediaType, lyric_line_count AS lyricLineCount FROM songs WHERE id = ?`).get(id);
      if (!song) return null;
      const lines = db.prepare(`SELECT l.id, l.position, l.start_seconds AS startSeconds, l.text, l.kana, l.romaji, l.translation, COALESCE(p.practice_count, 0) AS practiceCount, p.last_practiced_at AS lastPracticedAt FROM lyrics l LEFT JOIN progress p ON p.lyric_id = l.id WHERE l.song_id = ? ORDER BY l.position`).all(id);
      return { ...song, lines };
    },
    getSongMedia(id) {
      const media = db.prepare("SELECT media_filename AS filename, media_type AS type, source_path AS sourcePath FROM songs WHERE id = ?").get(id);
      if (!media) return null;
      if (media.sourcePath) {
        const path = resolveInsideRoot(nasMusicDir, media.sourcePath);
        return path && existsSync(path) ? { ...media, path, managed: false } : null;
      }
      return { ...media, path: join(mediaDir, media.filename), managed: true };
    },
    async addSong({ title, artist = "", audio, lyrics }) {
      if (!title?.trim()) throw new InputError("Song title is required.");
      if (!audio?.filename || !audio.data?.length) throw new InputError("An audio file is required.");
      if (!lyrics?.data?.length) throw new InputError("An LRC file is required.");

      const extension = extname(audio.filename).toLowerCase();
      const mediaType = supportedAudioTypes.get(extension);
      if (!mediaType) throw new InputError("Supported audio formats are M4A, MP3, and WAV.");

      const parsedLyrics = parseLrc(lyrics.data.toString("utf8"));
      const lyricLineCount = parsedLyrics.length;
      if (!lyricLineCount) throw new InputError("The LRC file must contain at least one timestamped lyric line.");

      const id = randomUUID();
      const mediaFilename = `${id}${extension}`;
      const temporaryPath = join(mediaDir, `${mediaFilename}.uploading`);
      const mediaPath = join(mediaDir, mediaFilename);
      writeFileSync(temporaryPath, audio.data);

      try {
        insert.run(id, title.trim(), artist.trim(), basename(audio.filename), mediaFilename, mediaType, "", lyricLineCount, new Date().toISOString());
        const addLyric = db.prepare("INSERT INTO lyrics (id, song_id, position, start_seconds, text, kana, romaji) VALUES (?, ?, ?, ?, ?, ?, ?)");
        const enrichedLyrics = await Promise.all(parsedLyrics.map(async (line) => ({ ...line, ...await generateReadings(line.text) })));
        for (const [position, line] of enrichedLyrics.entries()) addLyric.run(randomUUID(), id, position, line.startSeconds, line.text, line.kana, line.romaji);
        renameSync(temporaryPath, mediaPath);
      } catch (error) {
        throw error;
      }

      return list.all().find((song) => song.id === id);
    },
    listNasSongs() {
      const importedPaths = new Set(db.prepare("SELECT source_path AS sourcePath FROM songs WHERE source_path <> ''").all().map((row) => row.sourcePath.toLowerCase()));
      const importedFilenames = new Set(db.prepare("SELECT original_filename AS filename FROM songs").all().map((row) => row.filename.toLowerCase()));
      return scanNasMusic(nasMusicDir).map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        directory: candidate.directory,
        audioFilename: candidate.audioFilename,
        lrcFilename: candidate.lrcFilename,
        imported: importedPaths.has(candidate.audioRelativePath.toLowerCase()) || importedFilenames.has(candidate.audioFilename.toLowerCase()),
      }));
    },
    async importNasSongs({ ids, artist = "" }) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== "string")) throw new InputError("Select between 1 and 100 NAS songs to import.");
      const requestedIds = [...new Set(ids)];
      const candidates = new Map(scanNasMusic(nasMusicDir).map((candidate) => [candidate.id, candidate]));
      const importedPaths = new Set(db.prepare("SELECT source_path AS sourcePath FROM songs WHERE source_path <> ''").all().map((row) => row.sourcePath.toLowerCase()));
      const importedFilenames = new Set(db.prepare("SELECT original_filename AS filename FROM songs").all().map((row) => row.filename.toLowerCase()));
      let importedCount = 0, skippedCount = 0;
      for (const candidateId of requestedIds) {
        const candidate = candidates.get(candidateId);
        if (!candidate) throw new InputError("A selected NAS song is no longer available.");
        if (importedPaths.has(candidate.audioRelativePath.toLowerCase()) || importedFilenames.has(candidate.audioFilename.toLowerCase())) { skippedCount++; continue; }
        const parsedLyrics = parseLrc(readFileSync(candidate.lrcAbsolutePath, "utf8"));
        const enrichedLyrics = await Promise.all(parsedLyrics.map(async (line) => ({ ...line, ...await generateReadings(line.text) })));
        const songId = randomUUID();
        db.exec("BEGIN");
        try {
          insert.run(songId, candidate.title, String(artist).trim(), candidate.audioFilename, candidate.audioFilename, candidate.mediaType, candidate.audioRelativePath, enrichedLyrics.length, new Date().toISOString());
          const addLyric = db.prepare("INSERT INTO lyrics (id, song_id, position, start_seconds, text, kana, romaji) VALUES (?, ?, ?, ?, ?, ?, ?)");
          for (const [position, line] of enrichedLyrics.entries()) addLyric.run(randomUUID(), songId, position, line.startSeconds, line.text, line.kana, line.romaji);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        importedPaths.add(candidate.audioRelativePath.toLowerCase());
        importedFilenames.add(candidate.audioFilename.toLowerCase());
        importedCount++;
      }
      return { importedCount, skippedCount };
    },
    async ensureReadings(songId) {
      const lines = db.prepare("SELECT id, text FROM lyrics WHERE song_id = ? AND (kana = '' OR romaji = '') ORDER BY position").all(songId);
      const update = db.prepare("UPDATE lyrics SET kana = ?, romaji = ? WHERE id = ?");
      for (const line of lines) {
        if (!hasJapanese(line.text)) continue;
        const readings = await generateReadings(line.text);
        update.run(readings.kana, readings.romaji, line.id);
      }
    },
    updateLyric(id, patch) {
      const current = db.prepare("SELECT id, kana, romaji, translation FROM lyrics WHERE id = ?").get(id);
      if (!current) throw new InputError("Lyric line was not found.");
      const kana = typeof patch.kana === "string" ? patch.kana : current.kana;
      const romaji = typeof patch.romaji === "string" ? patch.romaji : current.romaji;
      const translation = typeof patch.translation === "string" ? patch.translation : current.translation;
      db.prepare("UPDATE lyrics SET kana = ?, romaji = ?, translation = ? WHERE id = ?").run(kana, romaji, translation, id);
      return db.prepare("SELECT id, kana, romaji, translation FROM lyrics WHERE id = ?").get(id);
    },
    async translateSong(id) {
      const song = db.prepare("SELECT id, title, artist FROM songs WHERE id = ?").get(id);
      if (!song) throw new InputError("Song was not found.");
      const allLines = db.prepare("SELECT id, position, text, translation FROM lyrics WHERE song_id = ? ORDER BY position").all(id);
      const lines = allLines.filter((line) => !line.translation.trim()).map(({ id: lineId, position, text }) => ({ id: lineId, position, text }));
      if (!lines.length) return { translatedLineCount: 0, skippedLineCount: allLines.length };

      const translations = await translator({ title: song.title, artist: song.artist, lines });
      if (!Array.isArray(translations) || translations.length !== lines.length) throw new ExternalServiceError("OpenAI returned an incomplete translation.");
      const expectedIds = new Set(lines.map((line) => line.id));
      const translatedById = new Map();
      for (const item of translations) {
        if (!item || !expectedIds.has(item.id) || translatedById.has(item.id) || typeof item.translation !== "string" || !item.translation.trim()) throw new ExternalServiceError("OpenAI returned invalid lyric translations.");
        translatedById.set(item.id, item.translation.trim());
      }

      const update = db.prepare("UPDATE lyrics SET translation = ? WHERE id = ? AND translation = ''");
      db.exec("BEGIN");
      try {
        for (const line of lines) update.run(translatedById.get(line.id), line.id);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { translatedLineCount: lines.length, skippedLineCount: allLines.length - lines.length };
    },
    recordPractice(id) {
      const lyric = db.prepare("SELECT l.id, l.song_id AS songId FROM lyrics l WHERE l.id = ?").get(id);
      if (!lyric) throw new InputError("Lyric line was not found.");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO progress (lyric_id, practice_count, last_practiced_at) VALUES (?, 1, ?) ON CONFLICT(lyric_id) DO UPDATE SET practice_count = practice_count + 1, last_practiced_at = excluded.last_practiced_at").run(id, now);
      return db.prepare("SELECT practice_count AS practiceCount, last_practiced_at AS lastPracticedAt FROM progress WHERE lyric_id = ?").get(id);
    },
    getPreferences() {
      return db.prepare("SELECT speed, gap_seconds AS gapSeconds, lead_seconds AS leadSeconds, tail_seconds AS tailSeconds, show_romaji AS showRomaji FROM preferences WHERE singleton = 1").get();
    },
    savePreferences(patch) {
      const current = this.getPreferences();
      const next = {
        speed: clampNumber(patch.speed, current.speed, .5, 1.5), gapSeconds: clampNumber(patch.gapSeconds, current.gapSeconds, 0, 5),
        leadSeconds: clampNumber(patch.leadSeconds, current.leadSeconds, 0, 2), tailSeconds: clampNumber(patch.tailSeconds, current.tailSeconds, 0, 2),
        showRomaji: typeof patch.showRomaji === "boolean" ? Number(patch.showRomaji) : current.showRomaji,
      };
      db.prepare("UPDATE preferences SET speed = ?, gap_seconds = ?, lead_seconds = ?, tail_seconds = ?, show_romaji = ? WHERE singleton = 1").run(next.speed, next.gapSeconds, next.leadSeconds, next.tailSeconds, next.showRomaji);
      return this.getPreferences();
    },
    deleteSong(id) {
      const media = this.getSongMedia(id);
      if (!media) throw new InputError("Song was not found.");
      db.exec("BEGIN");
      try {
        const recordings = db.prepare("SELECT filename FROM recordings WHERE song_id = ?").all(id);
        db.prepare("DELETE FROM recordings WHERE song_id = ?").run(id);
        db.prepare("DELETE FROM progress WHERE lyric_id IN (SELECT id FROM lyrics WHERE song_id = ?)").run(id);
        db.prepare("DELETE FROM lyrics WHERE song_id = ?").run(id);
        db.prepare("DELETE FROM songs WHERE id = ?").run(id);
        db.exec("COMMIT");
      if (media.managed) rmSync(media.path, { force: true });
        for (const recording of recordings) rmSync(join(recordingsDir, recording.filename), { force: true });
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    addRecording({ songId, lyricId, audio }) {
      if (!songId || !lyricId || !audio?.data?.length) throw new InputError("Song, lyric line, and recording are required.");
      const line = db.prepare("SELECT 1 FROM lyrics WHERE id = ? AND song_id = ?").get(lyricId, songId);
      if (!line) throw new InputError("Recording does not match a lyric line.");
      const id = randomUUID();
      const filename = `${id}.webm`;
      writeFileSync(join(recordingsDir, filename), audio.data);
      db.prepare("INSERT INTO recordings (id, song_id, lyric_id, filename, media_type, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, songId, lyricId, filename, "audio/webm", new Date().toISOString());
      return { id, lyricId, mediaUrl: `/api/recordings/${id}/media` };
    },
    listRecordings(lyricId) {
      return db.prepare("SELECT id, lyric_id AS lyricId, created_at AS createdAt FROM recordings WHERE lyric_id = ? ORDER BY created_at DESC").all(lyricId).map((recording) => ({ ...recording, mediaUrl: `/api/recordings/${recording.id}/media` }));
    },
    getRecordingMedia(id) {
      const recording = db.prepare("SELECT filename, media_type AS type FROM recordings WHERE id = ?").get(id);
      return recording && { ...recording, path: join(recordingsDir, recording.filename) };
    },
    deleteRecording(id) {
      const recording = this.getRecordingMedia(id);
      if (!recording) throw new InputError("Recording was not found.");
      db.prepare("DELETE FROM recordings WHERE id = ?").run(id);
      rmSync(recording.path, { force: true });
    },
  };
}

function resolveInsideRoot(root, relativePath) {
  const rootPath = resolve(root);
  const target = resolve(rootPath, relativePath);
  return target === rootPath || target.startsWith(`${rootPath}${sep}`) ? target : null;
}

function scanNasMusic(root) {
  if (!root || !existsSync(root)) return [];
  const rootPath = resolve(root);
  const pairs = new Map();
  const directories = [rootPath];
  let visitedEntries = 0;
  while (directories.length) {
    const directoryPath = directories.pop();
    let entries;
    try { entries = readdirSync(directoryPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visitedEntries > 50_000) throw new InputError("The NAS music folder contains too many files to scan safely.");
      const absolutePath = join(directoryPath, entry.name);
      if (entry.isDirectory()) { directories.push(absolutePath); continue; }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (extension !== ".lrc" && !supportedAudioTypes.has(extension)) continue;
      const directory = relative(rootPath, directoryPath).split(sep).join("/");
      const base = basename(entry.name, extension);
      const key = `${directory}/${base}`.toLowerCase();
      const pair = pairs.get(key) || { directory, base };
      if (extension === ".lrc") {
        pair.lrcFilename = entry.name;
        pair.lrcAbsolutePath = absolutePath;
      } else if (!pair.audioAbsolutePath) {
        pair.audioFilename = entry.name;
        pair.audioAbsolutePath = absolutePath;
        pair.audioRelativePath = relative(rootPath, absolutePath).split(sep).join("/");
        pair.mediaType = supportedAudioTypes.get(extension);
      }
      pairs.set(key, pair);
    }
  }
  return [...pairs.values()]
    .filter((pair) => pair.audioAbsolutePath && pair.lrcAbsolutePath)
    .map((pair) => ({ ...pair, id: Buffer.from(pair.audioRelativePath).toString("base64url"), title: pair.base.replace(/^[0-9]+[\s._-]+/, "") || pair.base }))
    .sort((a, b) => `${a.directory}/${a.audioFilename}`.localeCompare(`${b.directory}/${b.audioFilename}`));
}

function countTimedLyrics(text) {
  return text.split(/\r?\n/).filter((line) => /^\[\d{1,2}:\d{2}(?:\.\d{1,3})?\].+/.test(line.trim())).length;
}

function parseLrc(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\](.+)$/);
    if (match) lines.push({ startSeconds: Number(match[1]) * 60 + Number(match[2]), text: match[3].trim() });
  }
  if (!lines.length || lines.some((line, index) => index && line.startSeconds <= lines[index - 1].startSeconds)) throw new InputError("LRC timestamps must be strictly increasing.");
  return lines;
}

function clampNumber(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function hasJapanese(text) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

async function generateReadings(text) {
  if (!hasJapanese(text)) return { kana: "", romaji: "" };
  await readingEngineReady;
  const normalize = (value) => value.replace(/\s+/g, " ").replace(/\s*\/\s*/g, " / ").trim();
  return {
    kana: normalize(await readingEngine.convert(text, { to: "hiragana", mode: "spaced" })),
    romaji: normalize(await readingEngine.convert(text, { to: "romaji", mode: "spaced" })),
  };
}

async function translateLyricsWithOpenAI({ title, artist, lines }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ConfigurationError("OPENAI_API_KEY is not configured on the server.");
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna";
  const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model,
        store: false,
        instructions: "Translate Japanese song lyrics into natural, concise Simplified Chinese. Use the song title and artist only as context. Preserve imagery, tone, pronouns, punctuation, and repeated lines. Return exactly one translation for every supplied lyric ID. Do not add explanations, romanization, labels, or quotation marks that are not in the source.",
        input: JSON.stringify({ song: title, artist, lyrics: lines }),
        max_output_tokens: 12_000,
        text: {
          format: {
            type: "json_schema",
            name: "song_lyric_translations",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                translations: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: { id: { type: "string" }, translation: { type: "string" } },
                    required: ["id", "translation"],
                  },
                },
              },
              required: ["translations"],
            },
          },
        },
      }),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new ExternalServiceError("OpenAI translation timed out. Please try again.");
    throw new ExternalServiceError(`Could not reach OpenAI: ${error.message}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ExternalServiceError(payload.error?.message || `OpenAI request failed (${response.status}).`);
  const outputText = payload.output_text || payload.output?.flatMap((item) => item.content || []).find((content) => content.type === "output_text")?.text;
  if (!outputText) throw new ExternalServiceError("OpenAI returned no translation text.");
  try {
    return JSON.parse(outputText).translations;
  } catch {
    throw new ExternalServiceError("OpenAI returned translation data in an unexpected format.");
  }
}

async function readMultipartForm(request) {
  const contentType = request.headers["content-type"] ?? "";
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) throw new InputError("Expected a multipart form upload.");

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const boundary = Buffer.from(`--${boundaryMatch[1].replace(/^"|"$/g, "")}`);
  const divider = Buffer.concat([Buffer.from("\r\n"), boundary]);
  const fields = {};
  let position = body.indexOf(boundary) + boundary.length;

  while (position >= boundary.length && position < body.length) {
    if (body.subarray(position, position + 2).equals(Buffer.from("--"))) break;
    position += 2;
    const headersEnd = body.indexOf(Buffer.from("\r\n\r\n"), position);
    if (headersEnd === -1) break;
    const headers = body.subarray(position, headersEnd).toString("utf8");
    const name = headers.match(/name="([^"]+)"/i)?.[1];
    const filename = headers.match(/filename="([^"]*)"/i)?.[1];
    const dataStart = headersEnd + 4;
    const dataEnd = body.indexOf(divider, dataStart);
    if (dataEnd === -1) break;
    const data = body.subarray(dataStart, dataEnd);

    if (name) fields[name] = filename ? { filename, data } : data.toString("utf8");
    position = dataEnd + 2 + boundary.length;
  }

  return fields;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new InputError("Expected a JSON request body."); }
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendHtml(response, body) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function streamMedia(request, response, media) {
  const { size } = statSync(media.path);
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { "content-type": media.type, "content-length": size, "accept-ranges": "bytes" });
    return createReadStream(media.path).pipe(response);
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return sendJson(response, 416, { error: "Invalid media range." });
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) return sendJson(response, 416, { error: "Media range is not satisfiable." });

  response.writeHead(206, {
    "content-type": media.type,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
    "accept-ranges": "bytes",
  });
  return createReadStream(media.path, { start, end }).pipe(response);
}

function libraryPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>日语歌曲跟读</title><style>
:root{color-scheme:dark;--bg:#050b18;--panel:#0b1425;--panel2:#101b2f;--line:#26334a;--text:#f4f6ff;--muted:#909bb2;--purple:#9b7cff;--purple2:#6f55e8;--coral:#ff6d69}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 48% 20%,#14203b 0,#070e1c 36%,#030812 100%);color:var(--text);font:15px Inter,"Noto Sans SC","Noto Sans JP",system-ui,sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer;border:1px solid transparent;border-radius:10px;padding:11px 16px;background:linear-gradient(135deg,var(--purple2),var(--purple));color:white;transition:.18s ease}button:hover{transform:translateY(-1px);filter:brightness(1.08)}button:disabled{cursor:not-allowed;opacity:.45;transform:none;filter:none}button.secondary{background:#111c30;border-color:var(--line)}button.ghost{background:transparent;border-color:var(--line);color:#c8d0e2}.card{background:linear-gradient(145deg,rgba(17,27,47,.96),rgba(8,16,30,.96));border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 18px 50px rgba(0,0,0,.16)}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.stack{display:grid;gap:12px}.muted{color:var(--muted)}label{display:grid;gap:6px;color:#c8d0df}input,textarea,select{width:100%;background:#0b1425;color:white;border:1px solid var(--line);border-radius:9px;padding:10px 12px;outline:none}input:focus,textarea:focus,select:focus{border-color:var(--purple)}
body.library-page main{max-width:1040px;margin:auto;padding:42px 24px}body.library-page h1{font-size:32px;margin:0 0 22px}.library-page .card{padding:24px}.library-page form.stack,.library-page section.stack{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.library-page form.stack button,.library-page form.stack p,.library-page section.stack h2,.library-page section.stack button,.library-page section.stack p{grid-column:1/-1}
.nas-toolbar{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end}.nas-actions{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.nas-list{display:grid;gap:7px;max-height:420px;overflow:auto}.nas-item{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#0b1527}.nas-item.imported{opacity:.55}.nas-item input{width:18px;height:18px}.nas-path{display:block;color:var(--muted);font-size:12px;margin-top:4px}.nas-state{color:#9eabd0;font-size:13px}
body.practice-page{overflow:hidden}body.practice-page main{max-width:none;height:100vh;padding:0}.practice-shell{height:100vh;padding:12px;display:grid;grid-template-columns:270px minmax(520px,1fr) 280px;gap:12px}.practice-panel{min-width:0;background:linear-gradient(155deg,rgba(10,19,35,.97),rgba(5,12,24,.97));border:1px solid var(--line);border-radius:14px}.song-sidebar,.settings-panel{padding:20px;overflow:auto}.brand{display:flex;align-items:center;justify-content:space-between;font-size:19px;font-weight:750;margin:2px 0 22px}.search-box{margin-bottom:22px}.sidebar-caption{display:flex;justify-content:space-between;color:#c9d0df;margin-bottom:8px}.song-nav{display:grid;gap:4px}.song-nav-item{display:block;width:100%;padding:13px 11px;background:transparent;border:0;border-bottom:1px solid rgba(38,51,74,.65);text-align:left;color:#bac3d5}.song-nav-item:hover{transform:none;background:#101b30}.song-nav-item.active{background:linear-gradient(130deg,rgba(111,85,232,.24),rgba(22,34,58,.7));border:1px solid #354463;border-radius:11px;color:white}.song-nav-top{display:flex;justify-content:space-between;gap:8px}.mini-progress{height:3px;background:#1f2b40;border-radius:8px;margin-top:10px;overflow:hidden}.mini-progress i{display:block;height:100%;background:linear-gradient(90deg,var(--purple2),#b38cff)}.sidebar-import{width:100%;margin-top:18px}.progress-card{margin-top:24px;padding:16px;border:1px solid var(--line);border-radius:12px;background:#0c1729}.progress-ring{width:72px;height:72px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--purple) var(--value),#233047 0);position:relative;font-size:18px}.progress-ring:before{content:"";position:absolute;inset:8px;background:#0c1729;border-radius:50%}.progress-ring span{position:relative}
.practice-center{padding:20px 22px;overflow:auto}.center-head{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:14px}.song-title{font-size:24px;font-weight:730}.back-btn{font-size:24px;padding:7px 12px}.song-switcher{display:flex;gap:8px}.song-switcher button{white-space:nowrap}.view-tabs{max-width:430px;margin:0 auto 18px;padding:4px;display:grid;grid-template-columns:1fr 1fr;background:#0a1426;border:1px solid #202d43;border-radius:999px}.view-tabs button{border:0;border-radius:999px;background:transparent;color:#aeb8cc}.view-tabs button.active{color:#cdbfff;background:radial-gradient(circle,#2a2858,#101a30);box-shadow:inset 0 -2px #9b7cff}.phrase-card{position:relative;text-align:center;min-height:315px;padding:18px 34px 30px;display:flex;flex-direction:column;justify-content:flex-start;border:1px solid #26344b;border-radius:15px;background:radial-gradient(circle at 50% 45%,rgba(41,48,82,.45),rgba(9,17,32,.82));overflow:hidden}.phrase-meta{position:static;width:100%;display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;color:#a9b3c7;margin-bottom:24px}.phrase-actions{margin-left:auto}.phrase-badge{padding:8px 12px;border-radius:8px;background:rgba(120,99,220,.2);color:#cbbfff}.kana-display{font-size:18px;letter-spacing:.2em;color:#d8deec;margin:0 0 6px}.phrase-text{font-size:clamp(34px,4.4vw,64px);font-weight:650;line-height:1.25;letter-spacing:.035em;margin:0 auto 22px;max-width:1000px}.translation-display{width:100%;border-top:1px dashed #2c3a50;padding-top:20px;font-size:23px;color:#d8ddea}.romaji-display{margin-top:10px;font-size:18px;letter-spacing:.12em;font-style:italic;color:#7f8ba5}.sentence-nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;margin:12px 0 0}.sentence-nav button:first-child{justify-self:start}.sentence-nav button:last-child{justify-self:end}.sentence-position{color:#8f9bb2;font-variant-numeric:tabular-nums}.timeline-card{padding:15px;margin:12px 0 18px;border:1px solid var(--line);border-radius:14px;background:#091426}.timeline-meta{display:flex;justify-content:space-between;color:#aeb8c9;font-size:12px}.waveform{height:66px;display:flex;align-items:center;gap:2px;border-bottom:1px solid #27344a;overflow:hidden}.waveform span{flex:1;min-width:2px;border-radius:2px;background:#536078;opacity:.65}.waveform span.hot{background:linear-gradient(#a98cff,#7158e9);opacity:1}.control-row{display:grid;grid-template-columns:1.25fr 1fr .9fr .9fr 1.1fr;gap:12px}.control-row button,.control-row select{height:58px}.control-row .record-btn{background:linear-gradient(135deg,#a44144,#e96863);border-color:#ff817a}.control-hint{text-align:center;color:#68758e;font-size:13px;margin:14px 0 4px}.recording-stage{margin-top:18px;min-height:115px;padding:20px;display:flex;align-items:center;gap:20px;border:1px solid var(--line);border-radius:14px;background:#0b1629}.record-state{min-width:130px;font-size:18px}.record-state small{display:block;color:#96a1b7;margin-top:8px}.record-wave{display:flex;align-items:center;gap:3px;flex:1;height:58px}.record-wave i{width:3px;border-radius:4px;background:#ff716b}.record-list{display:grid;gap:8px;width:100%}.record-list .row{justify-content:space-between}.record-list audio{max-width:70%}
.settings-panel h2{margin:0 0 22px;font-size:18px}.setting-group{padding:19px 0;border-top:1px solid #202d42}.setting-group h3{margin:0 0 16px;font-size:14px}.setting-row{display:grid;grid-template-columns:1fr 120px;align-items:center;gap:12px;margin:12px 0}.switch-row{display:flex;align-items:center;justify-content:space-between;margin:16px 0}.toggle{width:48px;height:26px;padding:0;border:0;background:#253149;border-radius:99px;position:relative}.toggle:after{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;border-radius:50%;background:white;transition:.2s}.toggle.on{background:linear-gradient(90deg,#7558e5,#ab8cff)}.toggle.on:after{left:25px}.ai-translate{background:linear-gradient(135deg,#214c72,#7059df);border-color:#6984d7}.translation-status{min-height:22px;text-align:center;color:#9eabd0;margin:-8px 0 8px}.mode-option{display:flex;gap:10px;align-items:flex-start;margin:15px 0;color:#d6dced}.mode-option i{width:20px;height:20px;border:2px solid #67748e;border-radius:50%;margin-top:2px}.mode-option.active i{border:6px solid var(--purple)}.mode-option small{display:block;color:#7f8ba4;margin-top:2px}.full-lyrics{display:grid;gap:7px;max-height:calc(100vh - 150px);overflow:auto;padding-right:6px}.lyric-row{width:100%;text-align:left;background:#0e192b;border:1px solid transparent;color:#d5dbea;padding:13px 15px}.lyric-row:hover,.lyric-row.active{transform:none;border-color:#8069e8;background:#171f3b}.lyric-romaji,.lyric-translation{display:block;color:#7f8ba4;font-size:12px;margin-top:5px}.lyric-translation{color:#aeb9d2}
@media(max-width:1180px){body.practice-page{overflow:auto}body.practice-page main,.practice-shell{height:auto;min-height:100vh}.practice-shell{grid-template-columns:230px minmax(0,1fr)}.settings-panel{grid-column:2}.control-row{grid-template-columns:repeat(3,1fr)}}
@media(max-width:760px){body.library-page main{padding:20px 14px}.library-page form.stack,.library-page section.stack{grid-template-columns:1fr}.nas-toolbar{grid-template-columns:1fr}.nas-item{grid-template-columns:auto 1fr}.nas-state{grid-column:2}.practice-shell{display:block;padding:0}.practice-panel{border-radius:0;border-left:0;border-right:0}.song-sidebar{max-height:300px}.practice-center{padding:16px}.settings-panel{margin-top:10px}.center-head{align-items:flex-start;flex-wrap:wrap}.song-switcher{width:100%;display:grid;grid-template-columns:1fr 1fr}.song-switcher button:last-child{grid-column:1/-1}.phrase-card{min-height:280px;padding:16px 18px 24px}.phrase-meta{align-items:flex-start;margin-bottom:22px}.phrase-actions{width:100%;justify-content:flex-start;margin-left:0}.phrase-text{font-size:34px}.sentence-nav button{min-height:44px}.control-row{grid-template-columns:1fr 1fr}.control-row .record-btn{grid-column:1/-1}.recording-stage{align-items:flex-start;flex-wrap:wrap}.view-tabs{margin-top:12px}}
</style><main id="app"></main><script>
const app=document.querySelector('#app');let state={song:null,index:0,prefs:null,audio:null,looping:false,recorder:null,chunks:[],blob:null};
async function api(path,options){const response=await fetch(path,options);const type=response.headers.get('content-type')||'';const data=type.includes('json')?await response.json():null;if(!response.ok)throw new Error(data&&data.error||'请求失败');return data}
function node(tag,text){const x=document.createElement(tag);if(text!==undefined)x.textContent=text;return x}function button(text,fn,cls){const x=node('button',text);if(cls)x.className=cls;x.onclick=fn;return x}function clear(){app.replaceChildren()}function card(){const x=node('section');x.className='card';return x}
async function showLibrary(){
  if(state.keyHandler){document.removeEventListener('keydown',state.keyHandler);state.keyHandler=null}document.body.className='library-page';state.song=null;clear();app.append(node('h1','歌曲库'));
  const form=node('form');form.className='card stack';
  for(const [label,name,type,accept] of [['标题','title','text'],['歌手','artist','text'],['音频','audio','file','audio/mp4,.m4a,audio/mpeg,.mp3,audio/wav,.wav'],['LRC 歌词','lyrics','file','.lrc,text/plain']]){
    const l=node('label',label),input=document.createElement('input');input.name=name;input.type=type;if(accept)input.accept=accept;if(name==='title'||name==='audio'||name==='lyrics')input.required=true;l.append(input);form.append(l)
  }
  const message=node('p');form.append(button('上传歌曲',async e=>{e.preventDefault();try{const created=await api('/api/songs',{method:'POST',body:new FormData(form)});message.textContent='上传完成：'+created.title;form.reset();await renderSongs()}catch(error){message.textContent=error.message}}));form.append(message);app.append(form);

  const folderCard=card();folderCard.classList.add('stack');folderCard.append(node('h2','导入整个文件夹'));
  const folderLabel=node('label','选择包含同名音频和 LRC 的文件夹'),folderInput=document.createElement('input');folderInput.type='file';folderInput.multiple=true;folderInput.setAttribute('webkitdirectory','');folderInput.accept='.m4a,.mp3,.wav,.lrc,audio/mp4,audio/mpeg,audio/wav,text/plain';folderLabel.append(folderInput);folderCard.append(folderLabel);
  const batchArtistLabel=node('label','歌手（应用到本次导入的所有歌曲）'),batchArtist=document.createElement('input');batchArtist.placeholder='例如：YOASOBI';batchArtistLabel.append(batchArtist);folderCard.append(batchArtistLabel);
  const folderMessage=node('p');folderCard.append(button('导入文件夹',()=>importFolder(folderInput.files,batchArtist.value,folderMessage)),folderMessage);app.append(folderCard);

  const nasCard=card();nasCard.classList.add('nas-card');nasCard.append(node('h2','从 NAS 选择歌曲'));
  const nasDescription=node('p','扫描 Docker 只读挂载的音乐目录，只导入你勾选的歌曲，不复制音频文件。');nasDescription.className='muted';nasCard.append(nasDescription);
  const nasToolbar=node('div');nasToolbar.className='nas-toolbar';const nasFilterLabel=node('label','筛选歌曲'),nasFilter=document.createElement('input');nasFilter.placeholder='歌曲名、文件夹或文件名';nasFilterLabel.append(nasFilter);const nasArtistLabel=node('label','歌手（应用到本次选择）'),nasArtist=document.createElement('input');nasArtist.placeholder='例如：YOASOBI';nasArtistLabel.append(nasArtist);const scanNasButton=button('扫描 NAS',scanNasSongs,'secondary');nasToolbar.append(nasFilterLabel,nasArtistLabel,scanNasButton);nasCard.append(nasToolbar);
  const nasActions=node('div');nasActions.className='nas-actions';const selectVisibleButton=button('勾选当前结果',()=>{nasList.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(input=>input.checked=true)},'ghost'),clearNasButton=button('清除选择',()=>{nasList.querySelectorAll('input[type="checkbox"]').forEach(input=>input.checked=false)},'ghost'),importNasButton=button('导入选中的歌曲',importSelectedNasSongs);nasActions.append(selectVisibleButton,clearNasButton,importNasButton);nasCard.append(nasActions);const nasMessage=node('p','尚未扫描 NAS 音乐目录。');nasMessage.className='nas-state';const nasList=node('div');nasList.className='nas-list';nasCard.append(nasMessage,nasList);app.append(nasCard);let nasCandidates=[];
  nasFilter.oninput=renderNasCandidates;
  async function scanNasSongs(){scanNasButton.disabled=true;scanNasButton.textContent='扫描中…';nasMessage.textContent='正在扫描 NAS 中同名的音频和 LRC…';try{nasCandidates=await api('/api/nas/songs');renderNasCandidates()}catch(error){nasMessage.textContent='扫描失败：'+error.message}finally{scanNasButton.disabled=false;scanNasButton.textContent='重新扫描 NAS'}}
  function renderNasCandidates(){const query=nasFilter.value.trim().toLowerCase(),visible=nasCandidates.filter(candidate=>(candidate.title+' '+candidate.directory+' '+candidate.audioFilename).toLowerCase().includes(query));nasList.replaceChildren();for(const candidate of visible){const row=node('label');row.className='nas-item '+(candidate.imported?'imported':'');const check=document.createElement('input');check.type='checkbox';check.value=candidate.id;check.disabled=candidate.imported;const copy=node('span');copy.append(node('strong',candidate.title));const path=node('span',(candidate.directory?candidate.directory+'/':'')+candidate.audioFilename+' ＋ '+candidate.lrcFilename);path.className='nas-path';copy.append(path);row.append(check,copy,node('span',candidate.imported?'已导入':'可选择'));nasList.append(row)}const available=nasCandidates.filter(candidate=>!candidate.imported).length;nasMessage.textContent=nasCandidates.length?'找到 '+nasCandidates.length+' 组歌曲，'+available+' 组尚未导入；当前显示 '+visible.length+' 组。':'没有找到同名配对的音频和 LRC，请检查 NAS 挂载。'}
  async function importSelectedNasSongs(){const ids=[...nasList.querySelectorAll('input[type="checkbox"]:checked')].map(input=>input.value);if(!ids.length){nasMessage.textContent='请先勾选要导入的歌曲。';return}importNasButton.disabled=true;importNasButton.textContent='正在导入 '+ids.length+' 首…';try{const result=await api('/api/nas/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids,artist:nasArtist.value})});nasCandidates=await api('/api/nas/songs');renderNasCandidates();nasMessage.textContent='完成：只导入了所选的 '+result.importedCount+' 首，跳过 '+result.skippedCount+' 首。';await renderSongs()}catch(error){nasMessage.textContent='导入失败：'+error.message}finally{importNasButton.disabled=false;importNasButton.textContent='导入选中的歌曲'}}

  const list=card();list.append(node('h2','你的歌曲'));app.append(list);
  async function renderSongs(){list.replaceChildren(node('h2','你的歌曲'));const songs=await api('/api/songs');if(!songs.length)list.append(node('p','还没有歌曲。'));for(const song of songs){const row=node('div');row.className='row card';row.append(node('strong',song.title),node('span','— '+(song.artist||'未知歌手')),node('span',(song.practicedLineCount||0)+' / '+song.lyricLineCount+' 已练习'),button('练习',()=>location.hash='song/'+song.id));list.append(row)}return songs}
  async function importFolder(files,artist,status){
    if(!files.length){status.textContent='请先选择文件夹。';return}
    const pairs=new Map();
    for(const file of files){const path=file.webkitRelativePath||file.name,slash=path.lastIndexOf('/'),dir=slash>=0?path.slice(0,slash):'',dot=file.name.lastIndexOf('.');if(dot<0)continue;const base=file.name.slice(0,dot),extension=file.name.slice(dot).toLowerCase(),key=(dir+'/'+base).toLowerCase();const pair=pairs.get(key)||{base};if(['.m4a','.mp3','.wav'].includes(extension))pair.audio=file;if(extension==='.lrc')pair.lyrics=file;pairs.set(key,pair)}
    const ready=[...pairs.values()].filter(pair=>pair.audio&&pair.lyrics).sort((a,b)=>a.base.localeCompare(b.base));
    const unmatched=[...pairs.values()].filter(pair=>!pair.audio||!pair.lyrics).length;
    const existing=new Set((await api('/api/songs')).map(song=>song.originalFilename.toLowerCase()));let imported=0,skipped=0;
    for(const pair of ready){if(existing.has(pair.audio.name.toLowerCase())){skipped++;continue}status.textContent='正在导入 '+(imported+1)+' / '+ready.length+'：'+pair.base;const data=new FormData();data.set('title',pair.base.replace(/^[0-9]+ +/,''));data.set('artist',artist.trim());data.set('audio',pair.audio,pair.audio.name);data.set('lyrics',pair.lyrics,pair.lyrics.name);await api('/api/songs',{method:'POST',body:data});existing.add(pair.audio.name.toLowerCase());imported++}
    status.textContent='完成：导入 '+imported+' 首，跳过已存在 '+skipped+' 首，缺少配对 '+unmatched+' 个文件。';folderInput.value='';await renderSongs()
  }
  await renderSongs()
}
async function showPractice(id){state.song=await api('/api/songs/'+id);state.prefs=await api('/api/preferences');clear();const head=node('div');head.className='row';head.append(button('← 歌曲库',()=>location.hash='', 'secondary'),node('h1',state.song.title),node('span','— '+(state.song.artist||'')));app.append(head);const audio=document.createElement('audio');audio.controls=true;audio.src='/api/songs/'+id+'/media';audio.style.width='100%';state.audio=audio;app.append(audio);const controls=card();controls.append(node('h2','逐句练习'));const tools=node('div');tools.className='tools';let loopTimer=null;const stopLoop=()=>{state.looping=false;loop.textContent='开始循环';if(loopTimer){clearTimeout(loopTimer);loopTimer=null}};const loop=button('开始循环',()=>{state.looping=!state.looping;loop.textContent=state.looping?'停止循环':'开始循环';if(state.looping)playCurrent();else stopLoop()});tools.append(loop);for(const [key,label,min,max,step] of [['speed','速度',.5,1.5,.05],['gapSeconds','空白秒数',0,5,.25],['leadSeconds','句首缓冲',0,2,.05],['tailSeconds','句尾缓冲',0,2,.05]]){const l=node('label',label),input=document.createElement('input');input.type='number';input.min=min;input.max=max;input.step=step;input.value=state.prefs[key];input.onchange=()=>savePref(key,Number(input.value));l.append(input);tools.append(l)}const romajiLabel=node('label','显示罗马音');const check=document.createElement('input');check.type='checkbox';check.checked=Boolean(state.prefs.showRomaji);check.onchange=()=>savePref('showRomaji',check.checked).then(()=>renderLines());romajiLabel.append(check);tools.append(romajiLabel);controls.append(tools);app.append(controls);const current=card();current.id='current';app.append(current);const lines=card();lines.append(node('h2','歌词'));const list=node('div');list.className='lyrics';lines.append(list);app.append(lines);function selectLine(index){stopLoop();audio.pause();state.index=index;renderCurrent();renderLines();playCurrent()}function renderLines(){list.replaceChildren();state.song.lines.forEach((line,index)=>{const b=button((index+1)+'. '+line.text,()=>selectLine(index),'line '+(index===state.index?'active':''));list.append(b);if(state.prefs.showRomaji&&line.romaji)list.append(node('p',line.romaji))})}renderLines();renderCurrent();audio.addEventListener('timeupdate',onTime);function onTime(){const line=state.song.lines[state.index],next=state.song.lines[state.index+1];const rawEnd=next?next.startSeconds:audio.duration;const end=Math.min(audio.duration||rawEnd,rawEnd+state.prefs.tailSeconds);if(audio.currentTime>=end){audio.pause();api('/api/lyrics/'+line.id+'/practice',{method:'POST'}).catch(()=>{});if(state.looping)loopTimer=setTimeout(playCurrent,state.prefs.gapSeconds*1000)}}async function playCurrent(){const line=state.song.lines[state.index];audio.currentTime=Math.max(0,line.startSeconds-state.prefs.leadSeconds);audio.playbackRate=state.prefs.speed;try{await audio.play()}catch(error){alert(error.message)}}async function savePref(key,value){state.prefs=await api('/api/preferences',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...state.prefs,[key]:value})});audio.playbackRate=state.prefs.speed}function renderCurrent(){const line=state.song.lines[state.index];current.replaceChildren(node('h2','第 '+(state.index+1)+' 句'),node('p',line.text));if(line.kana)current.append(node('p','假名：'+line.kana));if(state.prefs.showRomaji&&line.romaji)current.append(node('p','罗马音：'+line.romaji));if(line.translation)current.append(node('p','中文：'+line.translation));const edit=button('编辑学习注释',()=>editLine(line),'secondary');const hear=button('播放这一句',playCurrent);const record=button('开始录音',toggleRecording);const actions=node('div');actions.className='row';actions.append(hear,record,edit);current.append(actions);showRecordings(line)}async function editLine(line){const box=card(),fields={};box.append(node('h3','编辑辅助文本'));for(const key of ['kana','romaji','translation']){const l=node('label',key==='kana'?'假名':key==='romaji'?'罗马音':'中文翻译'),input=document.createElement('textarea');input.value=line[key]||'';fields[key]=input;l.append(input);box.append(l)}box.append(button('保存注释',async()=>{Object.assign(line,await api('/api/lyrics/'+line.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({kana:fields.kana.value,romaji:fields.romaji.value,translation:fields.translation.value})}));renderCurrent();renderLines()}));current.append(box)}async function toggleRecording(){if(state.recorder&&state.recorder.state==='recording'){state.recorder.stop();return}const stream=await navigator.mediaDevices.getUserMedia({audio:true});state.chunks=[];state.recorder=new MediaRecorder(stream);state.recorder.ondataavailable=e=>state.chunks.push(e.data);state.recorder.onstop=()=>{stream.getTracks().forEach(t=>t.stop());state.blob=new Blob(state.chunks,{type:'audio/webm'});const p=node('div');p.className='row';const preview=document.createElement('audio');preview.controls=true;preview.src=URL.createObjectURL(state.blob);p.append(preview,button('保存录音',saveRecording));current.append(p)};state.recorder.start()}async function saveRecording(){const line=state.song.lines[state.index],form=new FormData();form.set('songId',state.song.id);form.set('lyricId',line.id);form.set('audio',state.blob,'shadowing.webm');await api('/api/recordings',{method:'POST',body:form});showRecordings(line)}async function showRecordings(line){const old=current.querySelector('.recordings');if(old)old.remove();const wrap=node('div');wrap.className='recordings';const recordings=await api('/api/lyrics/'+line.id+'/recordings');for(const recording of recordings){const row=node('div');row.className='row';const a=document.createElement('audio');a.controls=true;a.src=recording.mediaUrl;row.append(a,button('删除录音',async()=>{await api('/api/recordings/'+recording.id,{method:'DELETE'});showRecordings(line)},'secondary'));wrap.append(row)}current.append(wrap)}const remove=button('删除歌曲',async()=>{if(confirm('删除这首歌及所有录音、进度吗？')){await api('/api/songs/'+id,{method:'DELETE'});location.hash=''}},'secondary');app.append(remove)}
async function showPracticeV2(id){
  document.body.className='practice-page';
  const results=await Promise.all([api('/api/songs/'+id),api('/api/preferences'),api('/api/songs')]);
  const previousSongId=state.song&&state.song.id;state.song=results[0];state.prefs=results[1];const songs=results[2];state.index=previousSongId===id?Math.min(state.index||0,state.song.lines.length-1):0;state.looping=false;clear();
  const shell=node('div');shell.className='practice-shell';app.append(shell);
  const sidebar=node('aside');sidebar.className='practice-panel song-sidebar';
  const brand=node('div');brand.className='brand';brand.append(node('span','楽曲ライブラリ'),button('＋',()=>location.hash='','ghost'));sidebar.append(brand);
  const search=document.createElement('input');search.className='search-box';search.placeholder='曲名で検索';sidebar.append(search);
  const caption=node('div');caption.className='sidebar-caption';caption.append(node('span','我的歌曲'),node('span',songs.length+' 首'));sidebar.append(caption);
  const songNav=node('div');songNav.className='song-nav';sidebar.append(songNav);
  function renderSongNav(){const query=search.value.trim().toLowerCase();songNav.replaceChildren();for(const song of songs.filter(item=>(item.title+' '+(item.artist||'')).toLowerCase().includes(query))){const item=button('',()=>location.hash='song/'+song.id);item.className='song-nav-item '+(song.id===id?'active':'');const top=node('span');top.className='song-nav-top';const percent=song.lyricLineCount?Math.round((song.practicedLineCount||0)/song.lyricLineCount*100):0;top.append(node('span',song.title),node('span',percent+'%'));const progress=node('span');progress.className='mini-progress';const fill=node('i');fill.style.width=percent+'%';progress.append(fill);item.append(top,progress);songNav.append(item)}}
  search.oninput=renderSongNav;renderSongNav();
  const importButton=button('＋ 导入歌曲 / 文件夹',()=>location.hash='');importButton.className='secondary sidebar-import';sidebar.append(importButton);
  const learned=songs.reduce((sum,song)=>sum+(song.practicedLineCount||0),0),allLines=songs.reduce((sum,song)=>sum+song.lyricLineCount,0),overall=allLines?Math.round(learned/allLines*100):0;
  const progressCard=node('div');progressCard.className='progress-card';progressCard.append(node('strong','学习进度'));const progressRow=node('div');progressRow.className='row';progressRow.style.marginTop='14px';const ring=node('div');ring.className='progress-ring';ring.style.setProperty('--value',overall+'%');ring.append(node('span',overall+'%'));const progressText=node('div');progressText.append(node('div','已练习 '+learned+' 句'),node('small','共 '+allLines+' 句歌词'));progressRow.append(ring,progressText);progressCard.append(progressRow);sidebar.append(progressCard);shell.append(sidebar);

  const center=node('section');center.className='practice-panel practice-center';shell.append(center);
  const head=node('div');head.className='center-head';const headLeft=node('div');headLeft.className='row';const back=button('←',()=>location.hash='','ghost');back.className='ghost back-btn';headLeft.append(back,node('div',state.song.title));headLeft.lastChild.className='song-title';const songIndex=songs.findIndex(song=>song.id===id),headActions=node('div');headActions.className='song-switcher';const previousSong=button('← 上一首',()=>location.hash='song/'+songs[songIndex-1].id,'ghost'),nextSong=button('下一首 →',()=>location.hash='song/'+songs[songIndex+1].id,'ghost');previousSong.disabled=songIndex<=0;nextSong.disabled=songIndex<0||songIndex>=songs.length-1;const allButton=button('显示全部歌词',()=>setView('all'),'ghost');headActions.append(previousSong,nextSong,allButton);head.append(headLeft,headActions);center.append(head);
  const tabs=node('div');tabs.className='view-tabs';const practiceTab=button('练习',()=>setView('practice')),lyricsTab=button('歌词全体',()=>setView('all'));tabs.append(practiceTab,lyricsTab);center.append(tabs);const translationStatus=node('div');translationStatus.className='translation-status';center.append(translationStatus);
  const workspace=node('div');center.append(workspace);
  const audio=document.createElement('audio');audio.src='/api/songs/'+id+'/media';audio.preload='metadata';state.audio=audio;center.append(audio);audio.style.display='none';
  let loopTimer=null,currentView='practice',recordTimer=null,recordStartedAt=0;
  const range={start:state.index,end:Math.min(state.index+9,state.song.lines.length-1)};
  let activePlayback={end:0,lineIndexes:[]};
  const viewSettings={kana:true,romaji:Boolean(state.prefs.showRomaji),translation:true};
  function stopLoop(){state.looping=false;state.loopMode=null;if(loopTimer){clearTimeout(loopTimer);loopTimer=null}}
  function rangeEnd(index){const next=state.song.lines[index+1];if(next)return next.startSeconds+Number(state.prefs.tailSeconds||0);if(Number.isFinite(audio.duration))return audio.duration;return state.song.lines[index].startSeconds+6}
  function lineEnd(){return rangeEnd(state.index)}
  function playbackBounds(start,end){return {start:Math.max(0,state.song.lines[start].startSeconds-Number(state.prefs.leadSeconds||0)),end:rangeEnd(end)}}
  async function playRange(keepLoop=false){if(!keepLoop)stopLoop();const bounds=playbackBounds(range.start,range.end);activePlayback={end:bounds.end,lineIndexes:Array.from({length:range.end-range.start+1},(_,offset)=>range.start+offset)};audio.currentTime=bounds.start;audio.playbackRate=Number(state.prefs.speed||1);try{await audio.play()}catch(error){console.warn(error)}}
  async function playCurrent(keepLoop=false){if(!keepLoop)stopLoop();const bounds=playbackBounds(state.index,state.index);activePlayback={end:bounds.end,lineIndexes:[state.index]};audio.currentTime=bounds.start;audio.playbackRate=Number(state.prefs.speed||1);try{await audio.play()}catch(error){console.warn(error)}}
  function toggleLoop(mode){if(state.looping&&state.loopMode===mode){stopLoop();renderPractice();return}stopLoop();state.looping=true;state.loopMode=mode;mode==='range'?playRange(true):playCurrent(true);renderPractice()}
  function selectLine(index,play){if(index<0||index>=state.song.lines.length)return;stopLoop();audio.pause();state.index=index;setView('practice');if(play)playCurrent()}
  async function savePref(key,value){state.prefs=await api('/api/preferences',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...state.prefs,[key]:value})});audio.playbackRate=Number(state.prefs.speed||1)}
  function setView(view){currentView=view;practiceTab.className=view==='practice'?'active':'';lyricsTab.className=view==='all'?'active':'';allButton.textContent=view==='all'?'返回逐句练习':'显示全部歌词';allButton.onclick=()=>setView(view==='all'?'practice':'all');view==='practice'?renderPractice():renderAllLyrics()}
  function renderAllLyrics(){workspace.replaceChildren();const list=node('div');list.className='full-lyrics';state.song.lines.forEach((line,index)=>{const row=button((index+1)+'. '+line.text,()=>selectLine(index,true));row.className='lyric-row '+(index===state.index?'active':'');if(line.romaji){const roma=node('span',line.romaji);roma.className='lyric-romaji';row.append(roma)}if(line.translation){const translated=node('span','中文：'+line.translation);translated.className='lyric-translation';row.append(translated)}list.append(row)});workspace.append(list)}
  function buildWave(){const wave=node('div');wave.className='waveform';for(let i=0;i<84;i++){const bar=node('span');bar.style.height=(14+((i*17+state.index*11)%48))+'px';if(i>22&&i<66)bar.className='hot';wave.append(bar)}return wave}
  function formatTime(value){if(!Number.isFinite(value))return '0:00.00';const minutes=Math.floor(value/60),seconds=(value%60).toFixed(2).padStart(5,'0');return minutes+':'+seconds}
  function makeSelect(values,value,onchange){const select=document.createElement('select');for(const pair of values){const option=node('option',pair[1]);option.value=pair[0];select.append(option)}select.value=String(value);select.onchange=()=>onchange(Number(select.value),select);return select}
  function renderPractice(){workspace.replaceChildren();const line=state.song.lines[state.index];
    const phrase=node('section');phrase.className='phrase-card';const meta=node('div');meta.className='phrase-meta';const phraseActions=node('div');phraseActions.className='row phrase-actions';const missingTranslations=state.song.lines.filter(item=>!item.translation).length,translateButton=button(missingTranslations?'AI 一键翻译整首':'已全部翻译',()=>translateWholeSong(translateButton));translateButton.className='ai-translate';translateButton.disabled=!missingTranslations;phraseActions.append(button('编辑注释',()=>editLineV2(line),'ghost'),translateButton);meta.append(node('span','练习中的短句　'+(state.index+1)+' / '+state.song.lines.length),phraseActions);phrase.append(meta);
    if(viewSettings.kana&&line.kana){const kana=node('div',line.kana);kana.className='kana-display';phrase.append(kana)}const textLine=node('div',line.text);textLine.className='phrase-text';phrase.append(textLine);
    if(viewSettings.translation){const translation=node('div',line.translation||'中文翻译尚未添加');translation.className='translation-display '+(line.translation?'':'muted');phrase.append(translation)}if(viewSettings.romaji&&line.romaji){const romaji=node('div',line.romaji);romaji.className='romaji-display';phrase.append(romaji)}workspace.append(phrase);const sentenceNav=node('nav');sentenceNav.className='sentence-nav';sentenceNav.setAttribute('aria-label','句子导航');const previousLine=button('← 上一句',()=>selectLine(state.index-1,true),'ghost'),nextLine=button('下一句 →',()=>selectLine(state.index+1,true),'ghost');previousLine.disabled=state.index===0;nextLine.disabled=state.index===state.song.lines.length-1;const position=node('span',(state.index+1)+' / '+state.song.lines.length);position.className='sentence-position';sentenceNav.append(previousLine,position,nextLine);workspace.append(sentenceNav);
    const timeline=node('section');timeline.className='timeline-card';const tmeta=node('div');tmeta.className='timeline-meta';tmeta.append(node('span',formatTime(line.startSeconds)),node('span',formatTime(lineEnd())));timeline.append(tmeta,buildWave());const bottom=node('div');bottom.className='timeline-meta';bottom.style.marginTop='10px';bottom.append(node('span','播放位置　'+formatTime(audio.currentTime||line.startSeconds)),node('span','短句长度　'+Math.max(0,lineEnd()-line.startSeconds).toFixed(2)+' 秒'));timeline.append(bottom);workspace.append(timeline);
    const controls=node('div');controls.className='control-row';const play=button('▶　播放原曲',playCurrent,'secondary');play.className='secondary';const loop=button(state.looping?'停止 Loop':'↻　Loop',()=>{state.looping=!state.looping;loop.textContent=state.looping?'停止 Loop':'↻　Loop';if(state.looping)playCurrent()});loop.className=state.looping?'':'secondary';const speed=makeSelect([[.5,'0.5×'],[.75,'0.75×'],[1,'1.0×'],[1.25,'1.25×'],[1.5,'1.5×']],state.prefs.speed,async value=>{await savePref('speed',value)});const gap=makeSelect([[0,'无间隔'],[.5,'0.5 秒'],[1,'1 秒间隔'],[2,'2 秒间隔'],[3,'3 秒间隔']],state.prefs.gapSeconds,async value=>{await savePref('gapSeconds',value)});const record=button('●　Record',toggleRecordingV2);record.className='record-btn';controls.append(play,loop,speed,gap,record);workspace.append(controls);const hint=node('div','顺序：① 听原曲　→　② Loop 确认　→　③ 留出间隔练习　→　④ Record 录音　→　⑤ 对比');hint.className='control-hint';workspace.append(hint);const recording=node('section');recording.className='recording-stage';recording.id='recording-stage';workspace.append(recording);renderRecordingsV2(line,recording)}
  const renderPracticeBase=renderPractice;
  renderPractice=function(){renderPracticeBase();const sentenceLoop=workspace.querySelector('.control-row button:nth-child(2)');if(sentenceLoop){sentenceLoop.textContent=state.looping&&state.loopMode==='sentence'?'停止单句循环':'↻ 循环当前句';sentenceLoop.onclick=()=>toggleLoop('sentence')}renderRangeControls()}
  function renderRangeControls(){
    const panel=node('section');panel.className='range-controls';panel.style.cssText='display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;align-items:end;margin-top:14px;padding:14px;border:1px solid #273650;border-radius:12px;background:#0b1629';
    const title=node('div');title.append(node('strong','段落播放'),node('small','选择起止句，例如第 1 到第 10 句'));title.style.gridColumn='1/-1';panel.append(title);
    const makeRangeSelect=(labelText,value,onchange)=>{const label=node('label',labelText),select=document.createElement('select');state.song.lines.forEach((line,index)=>{const option=node('option','第 '+(index+1)+' 句');option.value=index;select.append(option)});select.value=String(value);select.onchange=()=>onchange(Number(select.value));label.append(select);return label};
    panel.append(makeRangeSelect('开始句',range.start,value=>{stopLoop();range.start=Math.min(value,range.end);renderPractice()}),makeRangeSelect('结束句',range.end,value=>{stopLoop();range.end=Math.max(value,range.start);renderPractice()}));
    const play=button('▶ 播放段落',playRange,'secondary');const loop=button(state.looping&&state.loopMode==='range'?'停止段落循环':'↻ 循环段落',()=>toggleLoop('range'),state.looping&&state.loopMode==='range'?'':'secondary');panel.append(play,loop);workspace.append(panel)
  }
  async function translateWholeSong(translateButton){translateButton.disabled=true;translateButton.textContent='OpenAI 翻译中…';translationStatus.textContent='正在翻译缺少中文的歌词，请不要关闭页面。';try{const result=await api('/api/songs/'+id+'/translate',{method:'POST'});state.song=await api('/api/songs/'+id);translationStatus.textContent=result.translatedLineCount?'完成：已翻译 '+result.translatedLineCount+' 句，保留原有翻译 '+result.skippedLineCount+' 句。':'这首歌已经全部翻译。';currentView==='practice'?renderPractice():renderAllLyrics()}catch(error){translationStatus.textContent='翻译失败：'+error.message;translateButton.disabled=false;translateButton.textContent='重试整首翻译'}}
  function editLineV2(line){const phrase=workspace.querySelector('.phrase-card'),old=phrase.querySelector('.annotation-editor');if(old){old.remove();return}const editor=node('div');editor.className='annotation-editor card';editor.style.textAlign='left';const fields={};for(const pair of [['kana','假名'],['romaji','罗马音'],['translation','中文翻译']]){const label=node('label',pair[1]),input=document.createElement('textarea');input.value=line[pair[0]]||'';fields[pair[0]]=input;label.append(input);editor.append(label)}const actions=node('div');actions.className='row';actions.append(button('保存',async()=>{Object.assign(line,await api('/api/lyrics/'+line.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({kana:fields.kana.value,romaji:fields.romaji.value,translation:fields.translation.value})}));renderPractice()}),button('取消',()=>editor.remove(),'ghost'));editor.append(actions);phrase.append(editor)}
  async function renderRecordingsV2(line,target){target.replaceChildren();const recordings=await api('/api/lyrics/'+line.id+'/recordings');if(!recordings.length){const stateText=node('div');stateText.className='record-state';stateText.append(node('strong','准备录音'),node('small','录音会保存在这首歌下面'));const idleWave=node('div');idleWave.className='record-wave';for(let i=0;i<42;i++){const bar=node('i');bar.style.height=(7+(i*13%24))+'px';bar.style.opacity='.22';idleWave.append(bar)}target.append(stateText,idleWave);return}const list=node('div');list.className='record-list';for(const recording of recordings){const row=node('div');row.className='row';const player=document.createElement('audio');player.controls=true;player.src=recording.mediaUrl;row.append(player,button('删除',async()=>{await api('/api/recordings/'+recording.id,{method:'DELETE'});renderRecordingsV2(line,target)},'ghost'));list.append(row)}target.append(list)}
  async function toggleRecordingV2(){const target=workspace.querySelector('#recording-stage');if(state.recorder&&state.recorder.state==='recording'){state.recorder.stop();return}const stream=await navigator.mediaDevices.getUserMedia({audio:true});state.chunks=[];state.recorder=new MediaRecorder(stream);recordStartedAt=Date.now();state.recorder.ondataavailable=event=>state.chunks.push(event.data);target.replaceChildren();const label=node('div');label.className='record-state';label.append(node('strong','● 录音中'),node('small','00:00'));const live=node('div');live.className='record-wave';for(let i=0;i<54;i++){const bar=node('i');bar.style.height=(10+(i*19%45))+'px';live.append(bar)}const stop=button('■',toggleRecordingV2);stop.className='record-btn';target.append(label,live,stop);recordTimer=setInterval(()=>{const elapsed=Math.floor((Date.now()-recordStartedAt)/1000);label.lastChild.textContent='00:'+String(elapsed).padStart(2,'0')},1000);state.recorder.onstop=()=>{clearInterval(recordTimer);stream.getTracks().forEach(track=>track.stop());state.blob=new Blob(state.chunks,{type:'audio/webm'});target.replaceChildren();const preview=document.createElement('audio');preview.controls=true;preview.src=URL.createObjectURL(state.blob);target.append(preview,button('保存这次录音',async()=>{const line=state.song.lines[state.index],form=new FormData();form.set('songId',state.song.id);form.set('lyricId',line.id);form.set('audio',state.blob,'shadowing.webm');await api('/api/recordings',{method:'POST',body:form});renderRecordingsV2(line,target)}))};state.recorder.start()}
  audio.addEventListener('timeupdate',()=>{if(audio.currentTime>=activePlayback.end){audio.pause();activePlayback.lineIndexes.forEach(index=>{const line=state.song.lines[index];api('/api/lyrics/'+line.id+'/practice',{method:'POST'}).catch(()=>{})});if(state.looping){const mode=state.loopMode||'sentence';loopTimer=setTimeout(()=>mode==='range'?playRange(true):playCurrent(true),Number(state.prefs.gapSeconds||0)*1000)}}});
  const settings=node('aside');settings.className='practice-panel settings-panel';settings.append(node('h2','设置'));
  const playback=node('div');playback.className='setting-group';playback.append(node('h3','播放设置'));const speedRow=node('label');speedRow.className='setting-row';speedRow.append(node('span','播放速度'),makeSelect([[.5,'0.5×'],[.75,'0.75×'],[1,'1.0×'],[1.25,'1.25×'],[1.5,'1.5×']],state.prefs.speed,value=>savePref('speed',value)));const gapRow=node('label');gapRow.className='setting-row';gapRow.append(node('span','练习间隔'),makeSelect([[0,'无'],[.5,'0.5 秒'],[1,'1 秒'],[2,'2 秒'],[3,'3 秒']],state.prefs.gapSeconds,value=>savePref('gapSeconds',value)));playback.append(speedRow,gapRow);settings.append(playback);
  function addNumberSetting(parent,labelText,key,min,max,step){const row=node('label');row.className='setting-row';const input=document.createElement('input');input.type='number';input.min=min;input.max=max;input.step=step;input.value=state.prefs[key];input.onchange=()=>savePref(key,Number(input.value));row.append(node('span',labelText),input);parent.append(row)}
  addNumberSetting(playback,'句首缓冲','leadSeconds',0,2,.05);addNumberSetting(playback,'句尾缓冲','tailSeconds',0,2,.05);
  const display=node('div');display.className='setting-group';display.append(node('h3','显示设置'));
  function addToggle(labelText,key,initial,onchange){const row=node('div');row.className='switch-row';const toggle=button('',()=>{viewSettings[key]=!viewSettings[key];toggle.className='toggle '+(viewSettings[key]?'on':'');toggle.setAttribute('aria-pressed',String(viewSettings[key]));onchange(viewSettings[key]);renderPractice()});toggle.className='toggle '+(initial?'on':'');toggle.setAttribute('aria-label',labelText);toggle.setAttribute('aria-pressed',String(initial));row.append(node('span',labelText),toggle);display.append(row)}
  addToggle('ふりがな','kana',viewSettings.kana,()=>{});addToggle('罗马字','romaji',viewSettings.romaji,value=>savePref('showRomaji',value));addToggle('译（中文）','translation',viewSettings.translation,()=>{});settings.append(display);
  const mode=node('div');mode.className='setting-group';mode.append(node('h3','练习模式'));for(const [title,sub,active] of [['通常模式','标准逐句练习',true],['Shadowing','稍后开放',false],['卡拉 OK','稍后开放',false]]){const option=node('div');option.className='mode-option '+(active?'active':'');if(!active)option.style.opacity='.55';option.append(node('i'));const copy=node('div');copy.append(node('span',title),node('small',sub));option.append(copy);mode.append(option)}settings.append(mode);shell.append(settings);
  if(state.keyHandler)document.removeEventListener('keydown',state.keyHandler);state.keyHandler=event=>{const tag=document.activeElement&&document.activeElement.tagName;if(['INPUT','TEXTAREA','SELECT'].includes(tag)||currentView!=='practice')return;if(event.key==='ArrowLeft'){event.preventDefault();selectLine(state.index-1,true)}if(event.key==='ArrowRight'){event.preventDefault();selectLine(state.index+1,true)}};document.addEventListener('keydown',state.keyHandler);
  setView('practice')
}
function route(){const match=location.hash.match(new RegExp('^#song/(.+)$'));match?showPracticeV2(match[1]).catch(error=>{clear();app.append(node('p',error.message))}):showLibrary().catch(error=>{clear();app.append(node('p',error.message))})}window.addEventListener('hashchange',route);route();
</script></main>`;
}

class InputError extends Error {}
class ExternalServiceError extends Error { status = 502 }
class ConfigurationError extends Error { status = 503 }
