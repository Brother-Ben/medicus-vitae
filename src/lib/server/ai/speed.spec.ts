// M4 speed check (spec 5): retrieval at 10,000 / 50,000 / 100,000 passages
// (95th percentile, warmed, including embedding the question with the local
// model), and review saves while a large book is being indexed. Slow and
// needs the embedding model, so it only runs when asked:
//
//   CORTEX_BENCH=1 npx vitest --run src/lib/server/ai/speed.spec.ts
//
// Results are printed and written to <data dir>/speed-check.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = process.env.CORTEX_BENCH === '1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bench-'));
process.env.CORTEX_DATA_DIR = dir;
process.env.CORTEX_ENV_LOADED = '1';

const WORDS =
	'enzyme substrate inhibitor kinetics vmax km glycolysis pyruvate citrate mitochondria membrane potential sodium potassium pump aldosterone nephron collecting duct osmolarity hemoglobin oxygen affinity bohr effect buffer acid base equilibrium entropy enthalpy gibbs lens focal length refraction circuit resistance capacitor current voltage neuron synapse action potential receptor ligand dna replication transcription translation ribosome codon mutation allele dominant recessive hardy weinberg population sociology identity stigma memory encoding retrieval conditioning reinforcement'.split(
		' '
	);

function sentence(rand: () => number) {
	const n = 12 + Math.floor(rand() * 14);
	return Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ') + '.';
}

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function pct(xs: number[], p: number) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

describe.skipIf(!run)('M4 speed check', () => {
	let m: {
		config: typeof import('../config');
		db: typeof import('../db');
		schema: typeof import('../db/schema');
		instance: typeof import('../instance');
		indexDb: typeof import('./index-db');
		retrieval: typeof import('./retrieval');
		embed: typeof import('./embed');
		cards: typeof import('../cards');
		indexer: typeof import('./indexer');
	};
	const results: Record<string, unknown> = { machine: `${os.cpus()[0]?.model ?? 'CPU'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB`, at: new Date().toISOString() };

	beforeAll(async () => {
		m = {
			config: await import('../config'),
			db: await import('../db'),
			schema: await import('../db/schema'),
			instance: await import('../instance'),
			indexDb: await import('./index-db'),
			retrieval: await import('./retrieval'),
			embed: await import('./embed'),
			cards: await import('../cards'),
			indexer: await import('./indexer')
		};
		m.config.ensureDataDirs();
		m.db.openLocalDatabase();
		await m.db.openMainDatabase();
		m.instance.ensureInstance();
		const now = Date.now();
		m.db.db().insert(m.schema.user).values({ id: 1, passwordHash: 'x', createdAt: now, updatedAt: now }).run();
	}, 120_000);

	const save = () => fs.writeFileSync(path.join(dir, '..', 'cortex-speed-check.json'), JSON.stringify(results, null, 2));

	afterAll(async () => {
		save();
		await m?.indexer.stopIndexer();
		m?.indexDb.closeIndexDb();
		m?.db.closeDatabases();
	});

	async function fillTo(n: number) {
		const db = m.indexDb.indexDb();
		const have = (db.prepare('SELECT count(*) AS n FROM chunk').get() as { n: number }).n;
		const rand = rng(have + 7);
		const ins = db.prepare(`INSERT INTO chunk (key, kind, provenance, doc_id, version_id, page, text_start, text_end, text, hash, embedded) VALUES (?, 'page', 'original', 'bench', 'bench-v', ?, 0, 100, ?, 'h', 1)`);
		const vec = db.prepare('INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)');
		const dims = m.indexDb.EMBEDDING_MODEL.dims;
		for (let i = have; i < n; i += 5000) {
			db.transaction(() => {
				for (let k = i; k < Math.min(n, i + 5000); k++) {
					const text = `${sentence(rand)} ${sentence(rand)} ${sentence(rand)} ${sentence(rand)}`;
					const id = Number(ins.run(`bench:${k}`, 1 + (k % 900), text).lastInsertRowid);
					// Stored vectors are random unit vectors: search cost doesn't depend on what they mean.
					const v = new Float32Array(dims);
					let norm = 0;
					for (let d = 0; d < dims; d++) {
						v[d] = rand() * 2 - 1;
						norm += v[d] * v[d];
					}
					for (let d = 0; d < dims; d++) v[d] /= Math.sqrt(norm);
					vec.run(BigInt(id), m.embed.vectorBuffer(v));
				}
			})();
		}
	}

	const QUESTIONS = [
		'What does a noncompetitive inhibitor do to Km?',
		'How does aldosterone change sodium reabsorption in the nephron?',
		'Why does the Bohr effect lower hemoglobin oxygen affinity?',
		'What sets the focal length of a converging lens?',
		'How is an action potential propagated along a neuron?',
		'What does Hardy-Weinberg equilibrium assume about a population?',
		'How do buffers resist changes in pH?',
		'What is the role of the ribosome in translation?'
	];

	for (const n of [10_000, 50_000, 100_000]) {
		it(`retrieval at ${n.toLocaleString('en-US')} passages`, async () => {
			await fillTo(n);
			for (const q of QUESTIONS.slice(0, 4)) await m.retrieval.retrieve(q); // warm up (loads the model the first time)
			const times: number[] = [];
			for (let i = 0; i < 40; i++) {
				const t = performance.now();
				await m.retrieval.retrieve(QUESTIONS[i % QUESTIONS.length] + (i > 7 ? ` ${WORDS[i]}` : ''));
				times.push(performance.now() - t);
			}
			results[`retrieval_${n}`] = { p50_ms: Math.round(pct(times, 50)), p95_ms: Math.round(pct(times, 95)), max_ms: Math.round(Math.max(...times)) };
			save();
			expect(pct(times, 95)).toBeLessThan(500);
		}, 600_000);
	}

	it('review saves stay quick while a large book is being indexed', async () => {
		// 30 cards to review, and a "book" of 1,500 pages waiting to be split and embedded.
		const now = Date.now();
		const cardIds: string[] = [];
		for (let i = 0; i < 30; i++) cardIds.push(...m.cards.createNote({ kind: 'basic', fields: { Front: `Q${i}`, Back: `A${i}` } }).cardIds);
		const d = m.db.db();
		d.insert(m.schema.document).values({ id: 'book', title: 'Big book', fileHash: 'b'.repeat(64), fileName: 'big.pdf', fileSize: 1, pageCount: 1500, status: 'ready', currentVersionId: 'book-v', createdAt: now, updatedAt: now }).run();
		d.insert(m.schema.documentVersion).values({ id: 'book-v', documentId: 'book', extractionVersion: 'bench', status: 'ready', pageCount: 1500, createdAt: now }).run();
		const rand = rng(99);
		const conn = m.db.sqlite();
		const insPage = conn.prepare('INSERT INTO doc_page (id, version_id, page_number, width, height, text, items, provenance) VALUES (?, ?, ?, 612, 792, ?, ?, ?)');
		conn.transaction(() => {
			for (let p = 1; p <= 1500; p++) {
				const text = Array.from({ length: 14 }, () => sentence(rand)).join(' ');
				insPage.run(`bp${p}`, 'book-v', p, text, JSON.stringify([[0, text.length, 0.1, 0.1, 0.9, 0.9]]), 'original');
			}
		})();
		m.indexer.resumeIndexer();
		m.indexer.requestIndex();
		const indexing = m.indexer.indexIdle();
		await new Promise((r) => setTimeout(r, 1500)); // let chunking and embedding get going
		const times: number[] = [];
		let seq = 0;
		for (const cardId of cardIds) {
			const c = m.cards.reviewCard(cardId)!;
			const t = performance.now();
			m.cards.submitReview({ cardId, rating: 3, eventId: c.eventId, timeTakenMs: 5000, deviceId: 'bench', deviceSeq: ++seq, baseRev: c.rev });
			times.push(performance.now() - t);
			await new Promise((r) => setTimeout(r, 120));
		}
		const state = { ...m.indexer.indexerState };
		const started = performance.now();
		await indexing;
		results.review_save_during_indexing = {
			p50_ms: Math.round(pct(times, 50) * 10) / 10,
			p95_ms: Math.round(pct(times, 95) * 10) / 10,
			max_ms: Math.round(Math.max(...times) * 10) / 10,
			indexer_phase_seen: state.phase,
			book_passages_embedded: m.indexDb.indexStats().embedded,
			indexing_finished_after_s: Math.round((performance.now() - started) / 1000)
		};
		save();
		expect(pct(times, 95)).toBeLessThan(200);
	}, 900_000);
});
