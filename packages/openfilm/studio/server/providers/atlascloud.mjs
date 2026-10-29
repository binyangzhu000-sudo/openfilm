// @ts-check
/**
 * Atlas Cloud with the person's own key: pictures (FLUX.2 Pro) and video with sound (Seedance 2.0, Seedance 2.0 Fast).
 * Its media API is asynchronous (https://www.atlascloud.ai/docs): a request is posted to /api/v1/model/generateImage
 * or /generateVideo with the model's id and its fields, which answers a prediction id; the prediction at
 * /api/v1/model/prediction/<id> is asked after until it is `completed` (its files in `outputs`, on Atlas Cloud's
 * storage, downloaded here) or `failed`. Key as a bearer token. Pictures a model is given go inline, as data: URIs.
 */
import { RATIO_SIZE, billedBy, call, clamp, dataUri, download, extOf, landing, list, madePicture, modelOf, needed, notes, number, serviceUrl, sleep, text } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider @typedef {import('./contract.mjs').RunContext} RunContext */

const NAME = 'Atlas Cloud';
/** the models it makes each kind of media with, the default first (each model's page on atlascloud.ai/models) */
const MODELS = {
  image: [{ id: 'black-forest-labs/flux-2-pro', name: 'FLUX.2 [pro]' }],
  video: [{ id: 'seedance-2.0-fast', name: 'Seedance 2.0 Fast' }, { id: 'seedance-2.0', name: 'Seedance 2.0' }],
};

/**
 * Each video model's endpoints (from a prompt, from a first frame, from reference pictures), the resolution it is asked
 * for, and the shapes and lengths it makes.
 * @type {Record<string, { name: string, text: string, image: string, reference: string, resolution: string, ratios: string[], seconds: [number, number] }>}
 */
const VIDEO = {
  'seedance-2.0-fast': {
    name: 'Seedance Fast', text: 'bytedance/seedance-2.0-fast/text-to-video', image: 'bytedance/seedance-2.0-fast/image-to-video', reference: 'bytedance/seedance-2.0-fast/reference-to-video',
    resolution: '720p', ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], seconds: [4, 15],
  },
  'seedance-2.0': {
    name: 'Seedance', text: 'bytedance/seedance-2.0/text-to-video', image: 'bytedance/seedance-2.0/image-to-video', reference: 'bytedance/seedance-2.0/reference-to-video',
    resolution: '1080p', ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], seconds: [4, 15],
  },
};

/** How long to wait between asking after a prediction (tests make it short). */
export const polling = { ms: { image: 2000, video: 5000 } };

/** @type {Provider} */
export default {
  id: 'atlascloud',
  name: NAME,
  env: 'ATLASCLOUD_API_KEY',
  keysUrl: 'https://console.atlascloud.ai/api-keys',
  billingUrl: 'https://console.atlascloud.ai/billing',
  verbs: ['image', 'video'],
  models: MODELS,
  async run(verb, args, ctx) {
    if (verb === 'image') {
      const prompt = needed(args, 'prompt');
      const ratio = text(args.ratio) || '3:2';
      const size = RATIO_SIZE[ratio];
      if (!size) throw new Error(`--ratio is one of ${Object.keys(RATIO_SIZE).join(', ')}.`);
      const model = modelOf(MODELS, 'image', ctx);
      const said = [...(args.transparent ? ['--transparent: FLUX.2 makes opaque pictures'] : []), ...(text(args.quality) === 'high' ? ['--quality high: FLUX.2 has one quality'] : [])];
      const url = await predict('generateImage', { model: `${model}/text-to-image`, prompt, size: `${size.width}*${size.height}`, output_format: 'png' }, ctx, polling.ms.image);
      const { bytes, type } = await download(NAME, url, ctx);
      const path = landing('image', args.out, extOf(type, 'png'));
      return { ...madePicture({ path, bytes, prompt, provider: 'atlascloud', model, notes: said }), cost: billedBy(NAME) };
    }
    if (verb === 'video') return video(args, ctx);
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};

/**
 * A clip with sound, of the lengths and shapes the chosen model makes: from the prompt, from a first (and last) frame,
 * or from up to 9 reference pictures.
 * @param {Record<string, unknown>} args @param {RunContext} ctx
 */
async function video(args, ctx) {
  const prompt = needed(args, 'prompt');
  const path = landing('video', args.out, 'mp4');
  const model = modelOf(MODELS, 'video', ctx);
  const spec = VIDEO[model];
  const said = [];
  const first = text(args['first-frame']);
  const last = text(args['last-frame']);
  let refs = list(args['input-reference']);
  if (refs.length > 9) { said.push(`${spec.name} takes 9 reference pictures: the rest were left out`); refs = refs.slice(0, 9); }
  if (!first && last) said.push(`${spec.name} needs a first frame with a last one: the last frame was left out`);
  if (first && refs.length) said.push('a first frame and reference pictures do not go together: the reference pictures were left out');

  const asked = number(args.duration) ?? 5;
  const seconds = clamp(Math.round(asked), ...spec.seconds);
  if (seconds !== asked) said.push(`${spec.name} makes ${spec.seconds[0]} to ${spec.seconds[1]} second clips: ${seconds} s`);
  const ratio = text(args['aspect-ratio']);
  const tall = ['9:21', '2:3', '3:4', '9:16'].includes(ratio);
  const aspect = !ratio || ratio === 'adaptive' ? null : spec.ratios.includes(ratio) ? ratio : tall ? '9:16' : ['4:3', '1:1'].includes(ratio) ? '1:1' : '16:9';
  if (aspect && aspect !== ratio) said.push(`${spec.name} makes ${spec.ratios.join(', ')} clips: ${aspect}`);

  const endpoint = first ? spec.image : refs.length ? spec.reference : spec.text;
  const input = {
    model: endpoint, prompt, duration: seconds, resolution: spec.resolution, generate_audio: true,
    ...(aspect ? { ratio: aspect } : {}),
    ...(first ? { image: await dataUri(first, ctx), ...(last ? { last_image: await dataUri(last, ctx) } : {}) }
      : refs.length ? { reference_images: await Promise.all(refs.map((r) => dataUri(r, ctx))) } : {}),
  };
  const url = await predict('generateVideo', input, ctx, polling.ms.video);
  const { bytes } = await download(NAME, url, ctx);
  const used = first ? { ...(last ? { lastFrame: last } : {}), firstFrame: first } : refs.length ? { refs } : {};
  return {
    files: [{ path, bytes }],
    index: [{ src: path, kind: 'video', dur: seconds, hasAudio: true, from: { mode: 'generate', prompt, provider: 'atlascloud', model: endpoint, resolution: spec.resolution, sec: seconds, ...used } }],
    receipt: { provider: 'atlascloud', model: endpoint, src: path, dur: seconds, hasAudio: true, resolution: spec.resolution, ...notes(said) },
    cost: billedBy(NAME),
  };
}

/**
 * One prediction: post it, ask after it every `every` ms until it is done, give back the address of its first file.
 * The prediction is asked after at the service's own address built from its id, so the key goes nowhere else.
 * @param {'generateImage' | 'generateVideo'} endpoint @param {Record<string, unknown>} input @param {RunContext} ctx @param {number} every
 */
async function predict(endpoint, input, ctx, every) {
  const headers = { authorization: `Bearer ${ctx.key}` };
  const base = `${serviceUrl('ATLASCLOUD', 'https://api.atlascloud.ai')}/api/v1/model`;
  const sent = await (await call(NAME, `${base}/${endpoint}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(input) }, ctx)).json();
  const id = text(sent?.data?.id);
  if (!id) throw new Error(`${NAME} did not take the request${text(sent?.message) ? `: ${text(sent.message)}` : '.'}`);
  for (;;) {
    const got = (await (await call(NAME, `${base}/prediction/${encodeURIComponent(id)}`, { headers }, ctx)).json())?.data;
    const status = text(got?.status).toLowerCase();
    if (status === 'completed' || status === 'succeeded') {
      const url = text(Array.isArray(got.outputs) ? got.outputs[0] : got.outputs);
      if (!url) throw new Error(`${NAME} answered without a file.`);
      return url;
    }
    if (status === 'failed' || status === 'timeout') throw new Error(`${NAME} could not make it: ${text(got?.error) || status}`);
    await sleep(every, ctx.signal);
  }
}
