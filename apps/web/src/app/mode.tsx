import { createContext, useContext } from 'react';
import type { AppMode } from '../api/client';

export interface ModeApi {
  mode: AppMode;
  /** Whether this build/device can run standalone (the Android app). */
  canSwitch: boolean;
  /** Switch modes: closes the current library cleanly, then reloads the app. */
  switchMode(mode: AppMode): Promise<void>;
}

const Ctx = createContext<ModeApi>({ mode: 'server', canSwitch: false, switchMode: async () => undefined });

export const ModeProvider = Ctx.Provider;

export function useMode(): ModeApi {
  return useContext(Ctx);
}
