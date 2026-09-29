import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import {
  SOCKET_ERROR_CODES,
  SOCKET_EVENTS,
  rooms,
  type TaskChangedEvent,
  type TaskDeletedEvent,
} from '@tm/shared';
import { allowedOrigins } from '../config/env';
import { db } from '../db/client';
import { projects, teamMembers, teams } from '../db/schema';
import { verifyAccessToken } from '../lib/jwt';
import { logger } from '../lib/logger';
import { events } from '../lib/events';
import { can } from '../modules/permissions/authorize';
import type { Actor } from '../middleware/authenticate';
import { users } from '../db/schema';

/**
 * The realtime gateway.
 *
 * Two rules shape everything here. The token is verified at the handshake, not
 * trusted from a message; and rooms are chosen by the server from what the user
 * may actually see, never from a name the client asks for.
 */

let io: SocketServer | null = null;

interface SocketData {
  actor: Actor;
  /** Which project rooms this socket joined, for logging. */
  projectIds: string[];
}

function socketActor(socket: Socket): Actor | null {
  return (socket.data as Partial<SocketData>).actor ?? null;
}

/**
 * Work out every room this user is entitled to, by asking the permission rules
 * about each project rather than by taking the client's word for anything.
 */
async function roomsFor(actor: Actor): Promise<string[]> {
  const joined: string[] = [rooms.user(actor.id)];

  const teamIds = [...new Set([...actor.teamIds, ...actor.ledTeamIds])];

  // A super admin sees every team; everyone else only their own.
  const teamRows =
    actor.role === 'SUPER_ADMIN'
      ? await db.select({ id: teams.id }).from(teams)
      : teamIds.length > 0
        ? await db.select({ id: teams.id }).from(teams).where(inArray(teams.id, teamIds))
        : [];

  const visibleTeamIds = teamRows.map((t) => t.id);
  if (visibleTeamIds.length === 0) return joined;

  const projectRows = await db
    .select({ id: projects.id, teamId: projects.teamId })
    .from(projects)
    .where(and(inArray(projects.teamId, visibleTeamIds), isNull(projects.archivedAt)));

  for (const teamId of visibleTeamIds) {
    // authorize() decides, not the loop: the same rule the HTTP routes use.
    if (can(actor, 'project.view', { kind: 'project', teamId })) {
      joined.push(rooms.team(teamId));
    }
  }

  for (const project of projectRows) {
    if (can(actor, 'project.view', { kind: 'project', teamId: project.teamId })) {
      joined.push(rooms.project(project.id));
    }
  }

  return joined;
}

/** Rebuild the actor from the database, so a stale token cannot widen access. */
async function authenticateSocket(token: string): Promise<Actor> {
  const claims = verifyAccessToken(token);

  const [row] = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, claims.sub))
    .limit(1);

  if (!row || !row.isActive) {
    throw new Error(SOCKET_ERROR_CODES.unauthenticated + ': this account is not active');
  }

  const memberRows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, row.id));

  const ledRows = await db.select({ id: teams.id }).from(teams).where(eq(teams.leadId, row.id));
  const ledTeamIds = ledRows.map((t) => t.id);

  return {
    id: row.id,
    role: row.role,
    teamIds: [...new Set([...memberRows.map((m) => m.teamId), ...ledTeamIds])],
    ledTeamIds,
  };
}

export function createRealtimeGateway(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    path: '/socket.io',
    cors: { origin: allowedOrigins, credentials: true },
    // A reconnecting client re-runs the handshake, so a revoked token is caught.
    connectionStateRecovery: { maxDisconnectionDuration: 0 },
  });

  io.use((socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const token = typeof auth?.token === 'string' ? auth.token : null;

    if (!token) {
      next(new Error(SOCKET_ERROR_CODES.unauthenticated + ': no token'));
      return;
    }

    authenticateSocket(token)
      .then((actor) => {
        (socket.data as SocketData).actor = actor;
        next();
      })
      .catch(() => {
        // The message reaches the client, which uses it to decide whether to
        // refresh and retry rather than reconnecting in a loop.
        next(new Error(SOCKET_ERROR_CODES.unauthenticated + ': invalid token'));
      });
  });

  io.on('connection', (socket) => {
    const actor = socketActor(socket);
    if (!actor) {
      socket.disconnect(true);
      return;
    }

    roomsFor(actor)
      .then(async (joined) => {
        await socket.join(joined);
        (socket.data as SocketData).projectIds = joined;
        logger.debug({ userId: actor.id, rooms: joined.length }, 'Socket connected.');
      })
      .catch((error: unknown) => {
        logger.error({ err: error, userId: actor.id }, 'Could not join rooms; closing socket.');
        socket.disconnect(true);
      });

    socket.on('disconnect', (reason) => {
      logger.debug({ userId: actor.id, reason }, 'Socket disconnected.');
    });
  });

  registerEventForwarding();

  return io;
}

/** Close every socket belonging to a user. Used on logout, revoke and deactivation. */
export async function disconnectUser(userId: string, reason: string): Promise<void> {
  if (!io) return;
  const sockets = await io.in(rooms.user(userId)).fetchSockets();
  for (const socket of sockets) {
    socket.emit(SOCKET_EVENTS.sessionRevoked, { reason });
    socket.disconnect(true);
  }
  if (sockets.length > 0) {
    logger.info({ userId, sockets: sockets.length, reason }, 'Closed sockets for a user.');
  }
}

function emitTaskChanged(payload: TaskChangedEvent): void {
  // The project room is the audience: everyone in it may already see the task.
  io?.to(rooms.project(payload.projectId)).emit(SOCKET_EVENTS.taskChanged, payload);
}

function registerEventForwarding(): void {
  const changed = (
    reason: TaskChangedEvent['reason'],
  ): ((event: {
    taskId: string;
    taskKey: string;
    projectId: string;
    teamId: string;
    updatedAt: Date;
    actorId: string | null;
    clientMutationId: string | null;
  }) => void) => {
    return (event) => {
      emitTaskChanged({
        taskId: event.taskId,
        taskKey: event.taskKey,
        projectId: event.projectId,
        teamId: event.teamId,
        // This kind of change does not carry a status; null tells the client to
        // refetch rather than trust a guess.
        status: null,
        assigneeId: null,
        reviewerId: null,
        updatedAt: event.updatedAt.toISOString(),
        actorId: event.actorId,
        clientMutationId: event.clientMutationId,
        reason,
      });
    };
  };

  events.on('task.created', (event) => {
    emitTaskChanged({
      taskId: event.taskId,
      taskKey: event.taskKey,
      projectId: event.projectId,
      teamId: event.teamId,
      // A new task with an owner starts Assigned, otherwise it waits in the backlog.
      status: event.assigneeId ? 'ASSIGNED' : 'BACKLOG',
      assigneeId: event.assigneeId,
      reviewerId: event.reviewerId,
      updatedAt: event.updatedAt.toISOString(),
      actorId: event.actorId,
      clientMutationId: event.clientMutationId,
      reason: 'created',
    });
  });

  events.on('task.transitioned', (event) => {
    emitTaskChanged({
      taskId: event.taskId,
      taskKey: event.taskKey,
      projectId: event.projectId,
      teamId: event.teamId,
      status: event.to,
      assigneeId: event.assigneeId,
      reviewerId: event.reviewerId,
      updatedAt: event.updatedAt.toISOString(),
      actorId: event.actorId,
      clientMutationId: event.clientMutationId,
      reason: 'transitioned',
    });
  });

  events.on('task.assigned', (event) => {
    emitTaskChanged({
      taskId: event.taskId,
      taskKey: event.taskKey,
      projectId: event.projectId,
      teamId: event.teamId,
      // Assigning can move a task out of the backlog, but not predictably from
      // here, so the client refetches.
      status: null,
      assigneeId: event.assigneeId,
      reviewerId: event.reviewerId,
      updatedAt: event.updatedAt.toISOString(),
      actorId: event.actorId,
      clientMutationId: event.clientMutationId,
      reason: 'assigned',
    });
  });

  events.on('task.updated', changed('updated'));
  events.on('task.progress', changed('progress'));
  events.on('comment.created', changed('commented'));

  events.on('task.deleted', (event) => {
    const payload: TaskDeletedEvent = {
      taskId: event.taskId,
      projectId: event.projectId,
      teamId: event.teamId,
      actorId: event.actorId,
      clientMutationId: event.clientMutationId,
      updatedAt: event.updatedAt.toISOString(),
    };
    io?.to(rooms.project(event.projectId)).emit(SOCKET_EVENTS.taskDeleted, payload);
  });
}

export function getRealtimeServer(): SocketServer | null {
  return io;
}

export async function closeRealtime(): Promise<void> {
  await io?.close();
  io = null;
}
