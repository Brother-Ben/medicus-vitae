import { defineConfig } from 'drizzle-kit';

// Used only by `npm run db:generate` to turn schema changes into SQL migrations.
// The app applies migrations itself at startup (src/lib/server/db/index.ts).
export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: { url: 'file:./data/drizzle-kit-scratch.sqlite' },
	verbose: true,
	strict: true
});
