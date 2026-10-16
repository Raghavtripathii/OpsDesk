import type { Role } from '../auth/permissions.js';

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; email: string; name: string; isOrgAdmin: boolean };
      teamRole?: Role;
    }
  }
}

export {};
