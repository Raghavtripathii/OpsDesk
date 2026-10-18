import { handleItemEvent } from './itemEventNotifications.js';

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  item_event: handleItemEvent,
};
