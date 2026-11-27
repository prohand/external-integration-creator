// -----------------------------------------------------------------------------
// Store categories (manifest `categories`) and the mapping from the tracker's
// own categories ("Heating & cooling", "Energy / Vehicles"...).
// -----------------------------------------------------------------------------

export const STORE_CATEGORIES = [
  { key: 'climate', label: 'Chauffage et climatisation' },
  { key: 'lighting', label: 'Éclairage, prises et volets' },
  { key: 'energy', label: 'Énergie' },
  { key: 'security', label: 'Sécurité et caméras' },
  { key: 'multimedia', label: 'Multimédia' },
  { key: 'appliances', label: 'Électroménager et jardin' },
  { key: 'environment', label: 'Météo et environnement' },
  { key: 'protocols', label: 'Protocoles et passerelles' },
  { key: 'network', label: 'Réseau et présence' },
  { key: 'notifications', label: 'Messagerie et notifications' },
  { key: 'assistants', label: 'Assistants vocaux' },
  { key: 'services', label: 'Services et vie quotidienne' },
  { key: 'transport', label: 'Transports' },
  { key: 'vehicles', label: 'Véhicules' },
  { key: 'servers', label: 'Serveurs et informatique' },
  { key: 'leisure', label: 'Loisirs' },
];

export const STORE_CATEGORY_KEYS = STORE_CATEGORIES.map((c) => c.key);

const TRACKER_TO_STORE = {
  'heating & cooling': 'climate',
  'lighting, plugs & covers': 'lighting',
  energy: 'energy',
  'cameras & security': 'security',
  multimedia: 'multimedia',
  'appliances & garden': 'appliances',
  'weather & environment': 'environment',
  'protocols & hubs': 'protocols',
  'network & presence': 'network',
  'messaging & notifications': 'notifications',
  'voice assistants': 'assistants',
  'services & daily life': 'services',
  transport: 'transport',
  vehicles: 'vehicles',
  'servers & it': 'servers',
  leisure: 'leisure',
};

/**
 * "Energy / Vehicles" -> ["energy", "vehicles"]. Unknown labels are ignored,
 * store keys are accepted as-is, at most 3 categories are returned.
 */
export function mapTrackerCategories(raw) {
  const out = [];
  for (const part of String(raw ?? '').split('/')) {
    const label = part.trim().toLowerCase();
    const key = TRACKER_TO_STORE[label] ?? (STORE_CATEGORY_KEYS.includes(label) ? label : null);
    if (key && !out.includes(key)) out.push(key);
  }
  return out.slice(0, 3);
}
