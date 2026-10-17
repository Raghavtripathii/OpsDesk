import { Router, type Response } from 'express';
import { z } from 'zod';
import { itemPriorities } from '../domain/items.js';
import { transitionActions } from '../domain/workflow.js';
import { currentUser } from '../middleware/authenticate.js';
import { expectedVersionFrom, setEtag } from '../middleware/ifMatch.js';
import {
  assignItem,
  changePriority,
  editDetails,
  transitionItem,
} from '../services/itemMutations.js';
import { itemIdFrom } from './params.js';

const detailsSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10000).optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one field to change',
  });

const assignSchema = z.object({
  ownerId: z.number().int().positive(),
});

const prioritySchema = z.object({
  priority: z.enum(itemPriorities),
});

const transitionSchema = z.object({
  action: z.enum(transitionActions),
  reason: z.string().trim().max(500).optional(),
});

function send(res: Response, result: { item: { version: number }; changed: boolean }) {
  setEtag(res, result.item.version);
  res.json(result);
}

export const itemMutationsRouter = Router();

itemMutationsRouter.patch('/:itemId', async (req, res) => {
  const input = detailsSchema.parse(req.body);
  const result = await editDetails(itemIdFrom(req), currentUser(req).id, expectedVersionFrom(req), input);
  send(res, result);
});

itemMutationsRouter.post('/:itemId/assign', async (req, res) => {
  const { ownerId } = assignSchema.parse(req.body);
  const result = await assignItem(itemIdFrom(req), currentUser(req).id, expectedVersionFrom(req), ownerId);
  send(res, result);
});

itemMutationsRouter.post('/:itemId/priority', async (req, res) => {
  const { priority } = prioritySchema.parse(req.body);
  const result = await changePriority(itemIdFrom(req), currentUser(req).id, expectedVersionFrom(req), priority);
  send(res, result);
});

itemMutationsRouter.post('/:itemId/transitions', async (req, res) => {
  const { action, reason } = transitionSchema.parse(req.body);
  const result = await transitionItem(
    itemIdFrom(req),
    currentUser(req).id,
    expectedVersionFrom(req),
    action,
    reason,
  );
  send(res, result);
});
