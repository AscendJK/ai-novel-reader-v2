import { create } from "zustand";
import type { ProviderConfig } from "@/api/types";
import { sharedDB as db } from "@/db/database";

interface APIState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  loaded: boolean;
  addProvider: (config: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  updateProvider: (id: string, config: Partial<ProviderConfig>) => void;
  setActiveProvider: (id: string | null) => void;
  getActiveProvider: () => ProviderConfig | undefined;
  loadFromDB: () => Promise<void>;
}

function userKeys() {
  const user = localStorage.getItem("sync-username") || "_anonymous";
  return { providers: `api-providers:${user}`, active: `api-active-provider:${user}` };
}

async function persist(providers: ProviderConfig[], activeId: string | null) {
  const k = userKeys();
  try {
    await Promise.all([
      db.settings.put({ key: k.providers, value: providers }),
      db.settings.put({ key: k.active, value: activeId }),
    ]);
  } catch (e) {
    console.error("[api-store] persist failed, retrying:", e);
    try {
      await new Promise((r) => setTimeout(r, 100));
      await Promise.all([
        db.settings.put({ key: k.providers, value: providers }),
        db.settings.put({ key: k.active, value: activeId }),
      ]);
    } catch (e2) {
      console.error("[api-store] persist retry failed:", e2);
    }
  }
}

export const useAPIStore = create<APIState>((set, get) => ({
  providers: [],
  activeProviderId: null,
  loaded: false,

  loadFromDB: async () => {
    try {
      const k = userKeys();
      const [providersRecord, activeRecord] = await Promise.all([
        db.settings.get(k.providers),
        db.settings.get(k.active),
      ]);
      const providers = (providersRecord?.value as ProviderConfig[]) || [];
      const activeId = (activeRecord?.value as string | null) ?? null;
      set({ providers, activeProviderId: activeId, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  addProvider: (config) =>
    set((s) => {
      // Replace if same id exists, otherwise append
      const filtered = s.providers.filter((p) => p.id !== config.id);
      const providers = [...filtered, config];
      const activeId = s.activeProviderId || config.id;
      persist(providers, activeId);
      return { providers, activeProviderId: activeId };
    }),

  removeProvider: (id) =>
    set((s) => {
      const providers = s.providers.filter((p) => p.id !== id);
      const activeId = s.activeProviderId === id ? (providers[0]?.id || null) : s.activeProviderId;
      persist(providers, activeId);
      return { providers, activeProviderId: activeId };
    }),

  updateProvider: (id, config) =>
    set((s) => {
      const providers = s.providers.map((p) => (p.id === id ? { ...p, ...config } : p));
      persist(providers, s.activeProviderId);
      return { providers };
    }),

  setActiveProvider: (id) => {
    const { providers } = get();
    if (id && !providers.some((p) => p.id === id)) return;
    persist(providers, id);
    set({ activeProviderId: id });
  },

  getActiveProvider: () => {
    const { providers, activeProviderId } = get();
    return providers.find((p) => p.id === activeProviderId);
  },
}));
