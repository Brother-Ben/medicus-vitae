// See https://svelte.dev/docs/kit/types#app.d.ts
import type { SessionInfo } from '#lib/server/auth.js';
import type { Role } from '#lib/server/instance.js';

declare global {
	const __APP_VERSION__: string;

	namespace App {
		interface Locals {
			session: SessionInfo | null;
			role: Role;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
