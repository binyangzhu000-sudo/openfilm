import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import atlascloud, { polling } from './atlascloud.mjs';

const KEY = 'apikey-test-0123456789abcdef';
/** A fake Atlas Cloud on 127.0.0.1: `reply` answers each request; `seen` keeps them. */
let server, base;
let reply = () => [404, {}];
const seen = [];

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const call = { method: req.method, url: new URL(req.url, 'http://x'), headers: req.headers, body: Buffer.concat(chunks) };
    seen.push(call);
    const [status, body, type = 'application/json'] = await reply(call);
    res.writeHead(status, { 'content-type': type }).end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENFILM_ATLASCLOUD_URL = base;
  polling.ms = { image: 5, video: 5 };
});
after(() => server.close());

const ctx = (files = {}, signal = new AbortController().signal) => ({ key: KEY, root: '/project', signal, say: () => {}, read: async (p) => files[p] });

function png(w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/**
 * One prediction: posted at /api/v1/model/<endpoint>, `processing` for `ready - 1` asks, then `completed` with its
 * file in `outputs` (or what `done` says).
 */
function predictions(endpoint, done, ready = 3) {
  let asks = 0;
  return (call) => {
    if (call.method === 'POST' && call.url.pathname === `/api/v1/model/${endpoint}`) {
      return [200, { code: 200, data: { id: 'p1', status: 'processing', urls: { get: `${base}/api/v1/model/prediction/p1` } } }];
    }
    if (call.url.pathname === '/api/v1/model/prediction/p1') {
      asks += 1;
      return [200, { code: 200, data: asks < ready ? { id: 'p1', status: 'processing' } : { id: 'p1', status: 'completed', outputs: [`${base}/files/out.png`], error: '', ...done } }];
    }
    if (call.url.pathname === '/files/out.png') return [200, png(1536, 864), 'image/png'];
    if (call.url.pathname === '/files/out.mp4') return [200, Buffer.from('mp4'), 'video/mp4'];
    return [404, {}];
  };
}

test('a picture: posted with the key as a bearer, asked after until completed, its file downloaded without the key', async () => {
  reply = predictions('generateImage', {});
  const result = await atlascloud.run('image', { out: 'hero', prompt: 'a brass key', ratio: '16:9', quality: 'high', transparent: true }, ctx());
  const submit = seen.find((c) => c.method === 'POST');
  assert.equal(submit.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(submit.body), { model: 'black-forest-labs/flux-2-pro/text-to-image', prompt: 'a brass key', size: '1536*864', output_format: 'png' });
  assert.equal(seen.filter((c) => c.url.pathname === '/api/v1/model/prediction/p1').length, 3);
  assert.ok(seen.filter((c) => c.url.pathname === '/api/v1/model/prediction/p1').every((c) => c.headers.authorization === `Bearer ${KEY}`));
  assert.equal(seen.find((c) => c.url.pathname === '/files/out.png').headers.authorization, undefined);
  assert.equal(result.files[0].path, 'assets/image/hero.png');
  assert.deepEqual([result.index[0].w, result.index[0].h], [1536, 864]);
  assert.deepEqual(result.index[0].from, { mode: 'generate', prompt: 'a brass key', provider: 'atlascloud', model: 'black-forest-labs/flux-2-pro' });
  assert.equal(result.receipt.notes.length, 2);
  assert.match(result.cost.note, /Atlas Cloud/);
});

test('a ratio it has no size for is said, before anything is sent', async () => {
  seen.length = 0;
  await assert.rejects(atlascloud.run('image', { out: 'x', prompt: 'y', ratio: '7:3' }, ctx()), /--ratio is one of/);
  assert.equal(seen.length, 0);
});

test('a video from a prompt: Seedance 2.0 Fast at 720p with sound, the length within 4 to 15 s, the shape it makes', async () => {
  seen.length = 0;
  reply = predictions('generateVideo', { outputs: [`${base}/files/out.mp4`] });
  const result = await atlascloud.run('video', { out: 'shot', prompt: 'a slow push', duration: 2, 'aspect-ratio': '2:3' }, ctx());
  const input = JSON.parse(seen.find((c) => c.method === 'POST').body);
  assert.deepEqual(input, { model: 'bytedance/seedance-2.0-fast/text-to-video', prompt: 'a slow push', duration: 4, resolution: '720p', generate_audio: true, ratio: '9:16' });
  assert.equal(result.files[0].path, 'assets/video/shot.mp4');
  assert.equal(result.index[0].dur, 4);
  assert.equal(result.index[0].hasAudio, true);
  assert.equal(result.receipt.notes.length, 2);
  /* no shape asked: the model's own (adaptive is left out) */
  seen.length = 0;
  await atlascloud.run('video', { out: 'shot', prompt: 'x' }, ctx());
  const plain = JSON.parse(seen.find((c) => c.method === 'POST').body);
  assert.equal('ratio' in plain, false);
  assert.equal(plain.duration, 5);
});

test('a video from a first and last frame: the image-to-video endpoint, the pictures inline', async () => {
  seen.length = 0;
  reply = predictions('generateVideo', { outputs: [`${base}/files/out.mp4`] });
  const files = { 'assets/image/a.png': new Uint8Array(png(16, 9)), 'assets/image/b.png': new Uint8Array(png(16, 9)) };
  const result = await atlascloud.run('video', { out: 'shot', prompt: 'morph', duration: 20, 'first-frame': 'assets/image/a.png', 'last-frame': 'assets/image/b.png' }, ctx(files));
  const input = JSON.parse(seen.find((c) => c.method === 'POST').body);
  assert.equal(input.model, 'bytedance/seedance-2.0-fast/image-to-video');
  assert.equal(input.duration, 15);
  assert.match(input.image, /^data:image\/png;base64,/);
  assert.match(input.last_image, /^data:image\/png;base64,/);
  assert.deepEqual(result.index[0].from.firstFrame, 'assets/image/a.png');
  assert.equal(result.receipt.notes.length, 1);
});

test('a video from reference pictures, with the model the person chose: Seedance 2.0 at 1080p, at most 9 pictures', async () => {
  seen.length = 0;
  reply = predictions('generateVideo', { outputs: [`${base}/files/out.mp4`] });
  const refs = Array.from({ length: 11 }, (_, i) => `assets/image/r${i}.png`);
  const files = Object.fromEntries(refs.map((r) => [r, new Uint8Array(png(16, 9))]));
  const result = await atlascloud.run('video', { out: 'shot', prompt: 'walk', 'input-reference': refs }, { ...ctx(files), model: 'seedance-2.0' });
  const input = JSON.parse(seen.find((c) => c.method === 'POST').body);
  assert.equal(input.model, 'bytedance/seedance-2.0/reference-to-video');
  assert.equal(input.resolution, '1080p');
  assert.equal(input.reference_images.length, 9);
  assert.equal(result.receipt.model, 'bytedance/seedance-2.0/reference-to-video');
  assert.match(result.receipt.notes[0], /9 reference pictures/);
  /* a model it does not have is its first */
  seen.length = 0;
  await atlascloud.run('video', { out: 'x', prompt: 'y' }, { ...ctx(), model: 'gone' });
  assert.equal(JSON.parse(seen.find((c) => c.method === 'POST').body).model, 'bytedance/seedance-2.0-fast/text-to-video');
});

test('a prediction that failed says what Atlas Cloud said', async () => {
  reply = predictions('generateImage', { status: 'failed', outputs: [], error: 'prompt rejected by moderation' });
  await assert.rejects(atlascloud.run('image', { out: 'x', prompt: 'y' }, ctx()), /Atlas Cloud could not make it: prompt rejected by moderation/);
});

test('a prediction that completes without a file, and a request that is not taken', async () => {
  reply = predictions('generateImage', { outputs: [] });
  await assert.rejects(atlascloud.run('image', { out: 'x', prompt: 'y' }, ctx()), /answered without a file/);
  reply = () => [200, { code: 400, message: 'model not found', data: null }];
  await assert.rejects(atlascloud.run('image', { out: 'x', prompt: 'y' }, ctx()), /did not take the request: model not found/);
});

test('an HTTP error says what the service said; a key it refuses, a balance that is gone', async () => {
  reply = () => [400, { code: 400, message: 'size is not valid' }];
  await assert.rejects(atlascloud.run('image', { out: 'x', prompt: 'y' }, ctx()), /Atlas Cloud answered 400: size is not valid/);
  reply = () => [401, { code: 401, message: 'invalid api key' }];
  await assert.rejects(atlascloud.run('image', { out: 'x', prompt: 'y' }, ctx()), /did not accept your key/);
  reply = () => [402, { code: 402, msg: 'insufficient balance' }];
  await assert.rejects(atlascloud.run('video', { out: 'x', prompt: 'y' }, ctx()), (e) => e.code === 'balance' && /Atlas Cloud doesn't have enough balance/.test(e.message));
});

test('a cancelled run stops asking', async () => {
  seen.length = 0;
  reply = predictions('generateVideo', {}, Infinity);
  const stop = new AbortController();
  const run = atlascloud.run('video', { out: 'x', prompt: 'y' }, ctx({}, stop.signal));
  await new Promise((done) => setTimeout(done, 30));
  stop.abort();
  await assert.rejects(run);
  /* a request already on its way when it was stopped may still arrive: after that, none */
  await new Promise((done) => setTimeout(done, 50));
  const asked = seen.length;
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(seen.length, asked);
});

test('the key is never put in a sentence, and other kinds of media are refused', async () => {
  reply = () => [500, { message: `boom ${KEY}` }];
  await assert.rejects(atlascloud.run('image', { out: 'x', prompt: 'y' }, ctx()), (e) => !e.message.includes(KEY) && /500/.test(e.message));
  await assert.rejects(atlascloud.run('tts', {}, ctx()), /does not do tts/);
  assert.deepEqual([atlascloud.id, atlascloud.env, atlascloud.verbs], ['atlascloud', 'ATLASCLOUD_API_KEY', ['image', 'video']]);
});
