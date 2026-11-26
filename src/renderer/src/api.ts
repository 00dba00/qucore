import type { StudioApi } from '../../shared/types'

declare global {
  interface Window {
    api: StudioApi
  }
}

/** Desktop: preload izlaže window.api. Web verzija će ovdje podmetnuti HTTP implementaciju. */
export const api: StudioApi = window.api
