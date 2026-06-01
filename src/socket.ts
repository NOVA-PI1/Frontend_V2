import { io, type Socket } from 'socket.io-client';
import type { BusEvent } from './types';

const socketUrl =
  import.meta.env.VITE_SOCKET_URL ??
  import.meta.env.VITE_API_BASE_URL ??
  'https://novabackend-production-663e.up.railway.app';

export function createSocket(): Socket {
  return io(socketUrl, {
    transports: ['websocket'],
    autoConnect: true,
  });
}

export function isBusEvent(payload: unknown): payload is BusEvent {
  return typeof payload === 'object' && payload !== null && 'session_id' in payload && 'type' in payload;
}
