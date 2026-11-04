type Settings = {
	permissions?: { allow?: string[]; deny?: string[]; [k: string]: unknown };
	[k: string]: unknown;
};

export function mergeDenies(settings: Settings, denies: string[]): Settings {
	const deny = [...new Set([...(settings.permissions?.deny ?? []), ...denies])];
	return { ...settings, permissions: { ...settings.permissions, deny } };
}
