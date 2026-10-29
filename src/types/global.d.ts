import type { PoolApi } from './api';

declare global {
  interface Window {
    __POOL_READY__?: boolean;
    __POOL_FRAME__?: number;
    __pool?: PoolApi;
  }
}

export {};
