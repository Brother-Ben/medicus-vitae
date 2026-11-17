<script lang="ts" generics="T extends string">
	import type { LayoutItem } from '#lib/appearance.js';
	import Icon from './Icon.svelte';

	// Show, hide and reorder a list (the menu, the Today sections): a switch per
	// row, up/down buttons, and drag and drop with a pointer.

	let {
		items,
		meta,
		label,
		onchange
	}: {
		items: LayoutItem<T>[];
		meta: Record<string, { name: string; hint?: string; icon?: string; note?: string }>;
		label: string;
		onchange: (next: LayoutItem<T>[]) => void;
	} = $props();

	let dragging = $state<number | null>(null);
	let over = $state<number | null>(null);

	function move(from: number, to: number) {
		if (to < 0 || to >= items.length || from === to) return;
		const next = items.map((i) => ({ ...i }));
		const [it] = next.splice(from, 1);
		next.splice(to, 0, it);
		onchange(next);
	}

	function toggle(i: number, visible: boolean) {
		onchange(items.map((it, k) => (k === i ? { ...it, visible } : { ...it })));
	}
</script>

<ul class="layout-list" aria-label={label}>
	{#each items as item, i (item.id)}
		{@const m = meta[item.id] ?? { name: item.id }}
		<li
			class:off={!item.visible}
			class:over={over === i && dragging !== null && dragging !== i}
			draggable="true"
			ondragstart={(e) => {
				dragging = i;
				e.dataTransfer?.setData('text/plain', String(i));
				if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
			}}
			ondragover={(e) => {
				e.preventDefault();
				over = i;
			}}
			ondragleave={() => {
				if (over === i) over = null;
			}}
			ondrop={(e) => {
				e.preventDefault();
				if (dragging !== null) move(dragging, i);
				dragging = null;
				over = null;
			}}
			ondragend={() => {
				dragging = null;
				over = null;
			}}
		>
			<span class="grip" aria-hidden="true">⋮⋮</span>
			{#if m.icon}<span class="row-icon"><Icon name={m.icon} size={16} /></span>{/if}
			<div class="text">
				<div class="name">{m.name}</div>
				{#if m.hint || m.note}<div class="hint">{m.hint ?? ''}{m.note ? (m.hint ? ' · ' : '') + m.note : ''}</div>{/if}
			</div>
			<div class="ctrl">
				<button type="button" class="icon-btn plain sm" aria-label="Move {m.name} up" disabled={i === 0} onclick={() => move(i, i - 1)}><Icon name="arrow-up" size={15} /></button>
				<button type="button" class="icon-btn plain sm" aria-label="Move {m.name} down" disabled={i === items.length - 1} onclick={() => move(i, i + 1)}><Icon name="arrow-down" size={15} /></button>
				<input type="checkbox" class="switch" aria-label="Show {m.name}" checked={item.visible} onchange={(e) => toggle(i, (e.currentTarget as HTMLInputElement).checked)} />
			</div>
		</li>
	{/each}
</ul>

<style>
	.layout-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	li {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0.5rem 0.375rem 0.625rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		cursor: grab;
	}
	li:last-child {
		border-bottom: 0;
	}
	li.over {
		box-shadow: inset 0 2px 0 var(--accent);
	}
	li.off .name,
	li.off .row-icon {
		color: var(--text-3);
	}
	.grip {
		color: var(--text-3);
		font-size: 0.75rem;
		letter-spacing: -2px;
		user-select: none;
	}
	.row-icon {
		display: inline-flex;
		color: var(--text-2);
	}
	.text {
		flex: 1 1 auto;
		min-width: 0;
	}
	.name {
		font-weight: 600;
	}
	.hint {
		font-size: 0.75rem;
		color: var(--text-3);
	}
	.ctrl {
		display: flex;
		align-items: center;
		gap: 0.125rem;
	}
	.ctrl .switch {
		margin-left: 0.5rem;
	}
</style>
