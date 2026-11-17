import { CATEGORY_SHORT } from '#lib/aamc.js';
import { booksForNotes, notesFiles, writtenNotes } from '#lib/server/notes.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('app:notes');
	const notes = writtenNotes();
	const files = notesFiles();
	const books = booksForNotes();
	// Categories that appear on any note or linked chapter, for the category filter.
	const codes = [...new Set([...notes.flatMap((n) => n.aamcCodes), ...files.flatMap((f) => f.links.flatMap((l) => l.aamcCodes))])].sort();
	return {
		notes,
		files,
		books,
		categories: codes.map((c) => ({ code: c, name: CATEGORY_SHORT[c] ?? c }))
	};
};
