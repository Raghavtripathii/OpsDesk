import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { listViews } from '../domain/itemQuery.js';
import { itemKinds, itemPriorities, itemStatuses } from '../domain/items.js';
import { AppError } from '../errors.js';
import { authenticate, currentUser } from '../middleware/authenticate.js';
import { limitSchema } from '../pagination.js';
import {
  addComment,
  claimItem,
  createItem,
  getItem,
  listItemsForUser,
  listTimeline,
} from '../services/itemService.js';

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

const listQuerySchema = z.object({
  view: z.enum(listViews).default('all'),
  teamId: z.coerce.number().int().positive().optional(),
  status: z.string().transform(splitList).pipe(z.array(z.enum(itemStatuses)).max(10)).optional(),
  priority: z.string().transform(splitList).pipe(z.array(z.enum(itemPriorities)).max(10)).optional(),
  kind: z.string().transform(splitList).pipe(z.array(z.enum(itemKinds)).max(10)).optional(),
  ownerId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: limitSchema,
  cursor: z.string().max(500).optional(),
});

const timelineQuerySchema = z.object({
  limit: limitSchema,
  cursor: z.string().max(500).optional(),
});

const createItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10000).default(''),
  kind: z.enum(itemKinds),
  priority: z.enum(itemPriorities).default('medium'),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const commentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

function itemIdFrom(req: Request): number {
  const id = Number(req.params.itemId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(404, 'not_found', 'Work item not found');
  return id;
}

export async function createItemHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const teamId = Number(req.params.teamId);
  const input = createItemSchema.parse(req.body);

  const item = await createItem(user.id, teamId, {
    title: input.title,
    description: input.description,
    kind: input.kind,
    priority: input.priority,
    dueAt: input.dueAt ?? null,
  });

  res.status(201).json({ item });
}

export const itemsRouter = Router();

itemsRouter.use(authenticate);

itemsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const query = listQuerySchema.parse(req.query);

  const result = await listItemsForUser(
    user.id,
    {
      view: query.view,
      teamId: query.teamId,
      statuses: query.status,
      priorities: query.priority,
      kinds: query.kind,
      ownerId: query.ownerId,
      search: query.q,
    },
    query.limit,
    query.cursor,
  );

  res.json(result);
});

itemsRouter.get('/:itemId', async (req, res) => {
  const item = await getItem(itemIdFrom(req), currentUser(req).id);
  res.json({ item });
});

itemsRouter.get('/:itemId/events', async (req, res) => {
  const { limit, cursor } = timelineQuerySchema.parse(req.query);
  const result = await listTimeline(itemIdFrom(req), currentUser(req).id, limit, cursor);
  res.json(result);
});

itemsRouter.post('/:itemId/comments', async (req, res) => {
  const user = currentUser(req);
  const { body } = commentSchema.parse(req.body);
  const comment = await addComment(itemIdFrom(req), { id: user.id, name: user.name }, body);
  res.status(201).json({ comment });
});

itemsRouter.post('/:itemId/claim', async (req, res) => {
  const result = await claimItem(itemIdFrom(req), currentUser(req).id);
  res.json(result);
});
