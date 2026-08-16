import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServer } from "../src/app.js";

const lrc = ["[00:00.00]星座を眺めていた", "[00:04.00]夜が明けるまで"].join(String.fromCharCode(10));

function m4aFixture() {
  const bytes = new Uint8Array(1_000_001);
  bytes.set(new TextEncoder().encode("\u0000\u0000\u0000\u0018ftypM4A \u0000\u0000\u0000\u0000M4A isom"));
  return bytes;
}

test("user can upload an M4A song and find it in the song library", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jp-song-shadowing-"));
  const translationBatches = [];
  const server = createServer({
    dataDir,
    translator: async ({ title, artist, lines }) => {
      translationBatches.push({ title, artist, lines });
      return lines.map((line) => ({ id: line.id, translation: `中文：${line.text}` }));
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });

  const form = new FormData();
  form.set("title", "Orion");
  form.set("artist", "YOASOBI");
  form.set("audio", new Blob([m4aFixture()], { type: "audio/mp4" }), "01 Orion.m4a");
  form.set("lyrics", new Blob([lrc], { type: "text/plain" }), "orion.lrc");

  const upload = await fetch(`http://127.0.0.1:${port}/api/songs`, { method: "POST", body: form });
  assert.equal(upload.status, 201);
  const created = await upload.json();
  assert.equal(created.title, "Orion");
  assert.equal(created.artist, "YOASOBI");
  assert.equal(created.mediaType, "audio/mp4");
  assert.equal(created.lyricLineCount, 2);

  const media = await fetch(`http://127.0.0.1:${port}/api/songs/${created.id}/media`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "audio/mp4");
  assert.ok((await media.arrayBuffer()).byteLength > 1_000_000);

  const song = await fetch(`http://127.0.0.1:${port}/api/songs/${created.id}`).then((response) => response.json());
  assert.equal(song.lines.length, 2);
  assert.equal(song.lines[0].text, "星座を眺めていた");
  assert.match(song.lines[0].kana, /せいざ/);
  assert.match(song.lines[0].romaji, /seiza/);

  const translated = await fetch(`http://127.0.0.1:${port}/api/songs/${created.id}/translate`, { method: "POST" });
  assert.equal(translated.status, 200);
  assert.deepEqual(await translated.json(), { translatedLineCount: 2, skippedLineCount: 0 });
  assert.equal(translationBatches.length, 1);
  assert.equal(translationBatches[0].title, "Orion");
  assert.equal(translationBatches[0].artist, "YOASOBI");
  assert.equal(translationBatches[0].lines.length, 2);
  const translatedSong = await fetch(`http://127.0.0.1:${port}/api/songs/${created.id}`).then((response) => response.json());
  assert.equal(translatedSong.lines[0].translation, "中文：星座を眺めていた");

  const noOpTranslation = await fetch(`http://127.0.0.1:${port}/api/songs/${created.id}/translate`, { method: "POST" });
  assert.deepEqual(await noOpTranslation.json(), { translatedLineCount: 0, skippedLineCount: 2 });
  assert.equal(translationBatches.length, 1);

  const preferences = await fetch(`http://127.0.0.1:${port}/api/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speed: 0.75, gapSeconds: 1.5, showRomaji: true }),
  }).then((response) => response.json());
  assert.equal(preferences.speed, 0.75);
  assert.equal(preferences.gapSeconds, 1.5);
  assert.equal(preferences.showRomaji, 1);

  const annotation = await fetch(`http://127.0.0.1:${port}/api/lyrics/${song.lines[0].id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kana: "せいざをながめていた", romaji: "seiza o nagamete ita", translation: "凝望着星座" }),
  }).then((response) => response.json());
  assert.equal(annotation.translation, "凝望着星座");

  const progress = await fetch(`http://127.0.0.1:${port}/api/lyrics/${song.lines[0].id}/practice`, { method: "POST" }).then((response) => response.json());
  assert.equal(progress.practiceCount, 1);

  const recordingForm = new FormData();
  recordingForm.set("songId", created.id);
  recordingForm.set("lyricId", song.lines[0].id);
  recordingForm.set("audio", new Blob(["shadowing sample"], { type: "audio/webm" }), "shadowing.webm");
  const recording = await fetch(`http://127.0.0.1:${port}/api/recordings`, { method: "POST", body: recordingForm }).then((response) => response.json());
  assert.ok(recording.mediaUrl);
  const recordings = await fetch(`http://127.0.0.1:${port}/api/lyrics/${song.lines[0].id}/recordings`).then((response) => response.json());
  assert.equal(recordings.length, 1);
  await fetch(`http://127.0.0.1:${port}/api/recordings/${recording.id}`, { method: "DELETE" });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/lyrics/${song.lines[0].id}/recordings`).then((response) => response.json())).length, 0);

  const library = await fetch(`http://127.0.0.1:${port}/api/songs`);
  assert.equal(library.status, 200);
  const [listed] = await library.json();
  assert.equal(listed.id, created.id);
  assert.equal(listed.practicedLineCount, 1);
});
