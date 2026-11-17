import { error } from '@sveltejs/kit';
import { carsPrefs, getPassage } from '#lib/server/cars.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, depends }) => {
	depends('app:cars-passage');
	const p = getPassage(params.id);
	if (!p) error(404, 'Passage not found');
	return {
		passage: {
			id: p.passage.id,
			title: p.passage.title,
			source: p.passage.source,
			sourceUrl: p.passage.sourceUrl,
			topic: p.passage.topic,
			publishedOn: p.passage.publishedOn,
			paragraphs: p.passage.body.split(/\n{2,}/),
			wordCount: p.passage.wordCount,
			method: p.passage.method
		},
		questions: p.questions.map((q) => ({ id: q.id, stem: q.stem, choices: q.choices, answer: q.answer, explanation: q.explanation, skill: q.skill })),
		attempts: p.attempts.map((a) => ({ id: a.id, finishedAt: a.finishedAt, seconds: a.seconds, readingSeconds: a.readingSeconds, correct: a.correct, scored: a.scored, total: a.total, answers: a.answers })),
		layout: carsPrefs().layout
	};
};
