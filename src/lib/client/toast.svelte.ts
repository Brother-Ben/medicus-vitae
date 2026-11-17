import { untrack } from 'svelte';

export interface ToastAction {
	label: string;
	run: () => void | Promise<void>;
}

export interface Toast {
	id: number;
	message: string;
	kind: 'info' | 'error';
	action?: ToastAction;
}

let nextId = 1;

export const toasts = $state<Toast[]>([]);

export function toast(message: string, kind: Toast['kind'] = 'info', ms = 3500) {
	const id = nextId++;
	// Untracked so calling this from an effect doesn't make the effect depend on the list.
	untrack(() => toasts.push({ id, message, kind }));
	setTimeout(() => dismiss(id), kind === 'error' ? ms + 2500 : ms);
	return id;
}

/** A notice with one button (usually Undo). It stays a little longer so there's time to press it. */
export function toastAction(message: string, action: ToastAction, ms = 9000) {
	const id = nextId++;
	untrack(() => toasts.push({ id, message, kind: 'info', action }));
	setTimeout(() => dismiss(id), ms);
	return id;
}

export function dismiss(id: number) {
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1);
}

export function toastError(err: unknown) {
	toast(err instanceof Error ? err.message : String(err), 'error');
}
