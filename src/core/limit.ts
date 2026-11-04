/**
 * `fn` over every item, at most `limit` at once, results in the items' order. The first
 * rejection rejects the whole map and starts no further call; calls already started
 * still run to their end.
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	const lane = async () => {
		while (!failed && next < items.length) {
			const i = next++;
			try {
				out[i] = await fn(items[i] as T, i);
			} catch (e) {
				failed = true;
				throw e;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane),
	);
	return out;
}
