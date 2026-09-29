import { io, type Socket } from 'socket.io-client';
import {
  SOCKET_EVENTS,
  isAuthSocketError,
  type NotificationEvent,
  type NotificationReadEvent,
  type TaskChangedEvent,
  type TaskDeletedEvent,
} from '@tm/shared';
import { getAccessToken, refreshSession } from './api';

/**
 * The realtime connection.
 *
 * It goes to the same origin as everything else, through the dev proxy in
 * development and Nginx in production, so there is no second host to configure
 * and no cross-origin cookie to worry about.
 */

let socket: Socket | null = null;
/** Guards against refreshing repeatedly when the server keeps refusing us. */
let retriedAfterRefresh = false;

export interface SocketHandlers {
  onTaskChanged(event: TaskChangedEvent): void;
  onTaskDeleted(event: TaskDeletedEvent): void;
  /** Fired after a reconnect, so the caller can refetch what it missed. */
  onReconnect(): void;
  onNotification(event: NotificationEvent): void;
  /** Another tab of this person's read something; the bell must agree. */
  onNotificationRead(event: NotificationReadEvent): void;
  /** The server closed us out: the session is gone. */
  onSessionRevoked(): void;
}

export function connectSocket(handlers: SocketHandlers): Socket {
  if (socket?.connected) return socket;
  socket?.close();

  socket = io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    withCredentials: true,
    // A callback, not a fixed value: it runs again on every reconnect, so the
    // socket always presents the current token rather than the one that was in
    // memory when the page loaded.
    auth: (cb) => cb({ token: getAccessToken() }),
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  });

  socket.on('connect', () => {
    retriedAfterRefresh = false;
  });

  socket.on('connect_error', (error: Error) => {
    if (!isAuthSocketError(error.message)) return; // A network problem; let it retry.
    if (retriedAfterRefresh) return; // Already tried; stop hammering the server.

    retriedAfterRefresh = true;
    void refreshSession().then((ok) => {
      // The auth callback picks up the new token on the next attempt.
      if (ok) socket?.connect();
    });
  });

  socket.io.on('reconnect', () => {
    // Rather than replaying what was missed, ask for the current state once.
    handlers.onReconnect();
  });

  socket.on(SOCKET_EVENTS.taskChanged, handlers.onTaskChanged);
  socket.on(SOCKET_EVENTS.taskDeleted, handlers.onTaskDeleted);
  socket.on(SOCKET_EVENTS.notificationNew, handlers.onNotification);
  socket.on(SOCKET_EVENTS.notificationRead, handlers.onNotificationRead);
  socket.on(SOCKET_EVENTS.sessionRevoked, handlers.onSessionRevoked);

  return socket;
}

export function disconnectSocket(): void {
  socket?.close();
  socket = null;
  retriedAfterRefresh = false;
}

export function getSocket(): Socket | null {
  return socket;
}
