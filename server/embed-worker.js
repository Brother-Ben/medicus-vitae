// Embeds passages with the local model, in a worker thread so the server stays
// responsive. Started by src/lib/server/ai/embed.ts. The model is downloaded
// once into the models folder (or provided there ahead of time) and runs on the CPU.
//
// Messages in:  { type: 'embed', id, texts: string[] }
// Messages out: { type: 'ready' } | { type: 'progress', file, progress } |
//               { type: 'result', id, dims, data: Float32Array } | { type: 'error', id, message }

import os from 'node:os';
import { parentPort, workerData } from 'node:worker_threads';

const { model, revision, dtype, pooling, cacheDir, allowRemote, threads } = workerData;

let extractorPromise = null;

async function extractor() {
	if (!extractorPromise) {
		extractorPromise = (async () => {
			const tf = await import('@huggingface/transformers');
			tf.env.cacheDir = cacheDir;
			tf.env.localModelPath = cacheDir;
			tf.env.allowLocalModels = true;
			tf.env.allowRemoteModels = allowRemote !== false;
			const pipe = await tf.pipeline('feature-extraction', model, {
				revision,
				dtype,
				session_options: { intraOpNumThreads: threads || Math.max(1, Math.floor(os.cpus().length / 2)) },
				progress_callback: (p) => {
					if (p && p.status === 'progress') parentPort.postMessage({ type: 'progress', file: p.file, progress: p.progress });
				}
			});
			parentPort.postMessage({ type: 'ready' });
			return pipe;
		})();
		extractorPromise.catch(() => {
			extractorPromise = null;
		});
	}
	return extractorPromise;
}

// Stopping is cooperative: being terminated in the middle of a model run can
// crash the whole process, so the worker finishes the batch it's on and exits.
let busy = 0;
let stopping = false;

parentPort.on('message', async (msg) => {
	if (!msg) return;
	if (msg.type === 'stop') {
		stopping = true;
		if (!busy) process.exit(0);
		return;
	}
	if (msg.type !== 'embed') return;
	busy++;
	try {
		const pipe = await extractor();
		const out = await pipe(msg.texts, { pooling, normalize: true });
		const data = new Float32Array(out.data);
		parentPort.postMessage({ type: 'result', id: msg.id, dims: out.dims[out.dims.length - 1], data }, [data.buffer]);
	} catch (err) {
		parentPort.postMessage({ type: 'error', id: msg.id, message: err && err.message ? err.message : String(err) });
	} finally {
		busy--;
		if (stopping && !busy) process.exit(0);
	}
});
