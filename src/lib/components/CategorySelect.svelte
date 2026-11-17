<script lang="ts">
	import { CATEGORIES, CATEGORY_SHORT, SECTIONS, SKILLS } from '#lib/aamc.js';

	let {
		value = $bindable(null),
		id,
		includeSkills = false,
		allowCars = true,
		placeholder = 'No category'
	}: {
		value?: string | null;
		id: string;
		includeSkills?: boolean;
		allowCars?: boolean;
		placeholder?: string;
	} = $props();

	const groups = $derived([
		...SECTIONS.filter((s) => s.code !== 'CARS').map((s) => ({
			label: s.short,
			options: CATEGORIES.filter((c) => c.section === s.code).map((c) => ({ code: c.code, label: `${c.code} ${CATEGORY_SHORT[c.code]}` }))
		})),
		...(allowCars
			? [{ label: 'CARS', options: SKILLS.filter((k) => k.kind === 'CARS').map((k) => ({ code: k.code, label: `${k.code} ${k.name}` })) }]
			: []),
		...(includeSkills
			? [{ label: 'Scientific reasoning', options: SKILLS.filter((k) => k.kind === 'SIRS').map((k) => ({ code: k.code, label: `${k.code} ${k.name}` })) }]
			: [])
	]);
</script>

<select {id} class="select" value={value ?? ''} onchange={(e) => (value = (e.currentTarget as HTMLSelectElement).value || null)}>
	<option value="">{placeholder}</option>
	{#each groups as g (g.label)}
		<optgroup label={g.label}>
			{#each g.options as o (o.code)}
				<option value={o.code}>{o.label}</option>
			{/each}
		</optgroup>
	{/each}
</select>
