import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { config } from '../config';
import { EMBEDDING_MODEL } from './index-db';

// Talks to the embedding worker (server/embed-worker.js). Two workers: one for
// indexing, which stops when idle, and one for search queries, so a question
// never waits behind a batch of book passages.

type Pending = { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void };

export interface EmbedStatus {
	state: 'idle' | 'loading' | 'ready' | 'error';
	/** 0–1 while the model downloads the first time. */
	download: number | null;
	error: string | null;
}

class EmbedWorker {
	private worker: Worker | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private idleTimer: NodeJS.Timeout | null = null;
	status: EmbedStatus = { state: 'idle', download: null, error: null };

	constructor(
		private readonly idleMs: number,
		private readonly threads: number
	) {}

	private start() {
		fs.mkdirSync(config.paths.models, { recursive: true });
		const m = EMBEDDING_MODEL;
		const w = new Worker(config.paths.embedWorker, {
			workerData: {
				model: m.id,
				revision: m.revision,
				dtype: m.dtype,
				pooling: m.pooling,
				cacheDir: config.paths.models,
				allowRemote: process.env.CORTEX_MODEL_DOWNLOAD !== 'off',
				threads: this.threads
			},
			resourceLimits: { maxOldGenerationSizeMb: 1024 }
		});
		this.status = { state: 'loading', download: null, error: null };
		w.on('message', (msg: { type: string; id?: number; data?: Float32Array; dims?: number; message?: string; progress?: number }) => {
			if (msg.type === 'ready') this.status = { state: 'ready', download: null, error: null };
			else if (msg.type === 'progress') this.status = { ...this.status, download: typeof msg.progress === 'number' ? msg.progress / 100 : null };
			else if (msg.type === 'result' || msg.type === 'error') {
				const p = this.pending.get(msg.id!);
				this.pending.delete(msg.id!);
				if (!p) return;
				if (msg.type === 'error') {
					this.status = { state: 'error', download: null, error: msg.message ?? 'Embedding failed' };
					p.reject(new Error(msg.message ?? 'Embedding failed'));
				} else {
					const dims = msg.dims!;
					const all = msg.data!;
					const out: Float32Array[] = [];
					for (let i = 0; i < all.length / dims; i++) out.push(all.slice(i * dims, (i + 1) * dims));
					p.resolve(out);
				}
				this.armIdle();
			}
		});
		const fail = (err: Error) => {
			this.status = { state: 'error', download: null, error: err.message };
			for (const p of this.pending.values()) p.reject(err);
			this.pending.clear();
			this.worker = null;
		};
		w.on('error', fail);
		w.on('exit', (code) => {
			if (this.worker === w) fail(new Error(`The embedding worker stopped (code ${code}).`));
		});
		this.worker = w;
	}

	private armIdle() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (!this.idleMs || this.pending.size) return;
		this.idleTimer = setTimeout(() => void this.stop(), this.idleMs);
		this.idleTimer.unref();
	}

	embed(texts: string[]): Promise<Float32Array[]> {
		if (!texts.length) return Promise.resolve([]);
		if (!this.worker) this.start();
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker!.postMessage({ type: 'embed', id, texts });
		});
	}

	/**
	 * Asks the worker to exit once its current batch is done (terminating it in the
	 * middle of a model run can crash the process). Forced only if it doesn't.
	 */
	stop(): Promise<void> {
		const w = this.worker;
		this.worker = null;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.status.state !== 'error') this.status = { state: 'idle', download: null, error: null };
		if (!w) return Promise.resolve();
		return new Promise((resolve) => {
			const force = setTimeout(() => void w.terminate().finally(resolve), 20_000);
			force.unref();
			w.once('exit', () => {
				clearTimeout(force);
				for (const p of this.pending.values()) p.reject(new Error('Embedding stopped.'));
				this.pending.clear();
				resolve();
			});
			w.postMessage({ type: 'stop' });
		});
	}
}

const indexing = new EmbedWorker(5 * 60_000, 0);
const queries = new EmbedWorker(30 * 60_000, 1);

/** Embeddings for passages (no query prefix). */
export function embedPassages(texts: string[]) {
	return indexing.embed(texts.map((t) => t.slice(0, 4000)));
}

/** Embedding for a search query. */
export async function embedQuery(text: string): Promise<Float32Array> {
	const [v] = await queries.embed([EMBEDDING_MODEL.queryPrefix + text.slice(0, 2000)]);
	return v;
}

export function embedStatus(): EmbedStatus {
	if (indexing.status.state === 'loading' || indexing.status.state === 'error') return indexing.status;
	return queries.status.state === 'idle' ? indexing.status : queries.status;
}

export function stopEmbedding(): Promise<void> {
	return Promise.all([indexing.stop(), queries.stop()]).then(() => undefined);
}

export function vectorBuffer(v: Float32Array) {
	return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
