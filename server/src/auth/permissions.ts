export type Role = 'member' | 'lead' | 'admin';

export type Permission =
  | 'team:view'
  | 'team:manage_members'
  | 'item:view'
  | 'item:create'
  | 'item:comment'
  | 'item:claim'
  | 'item:edit_own'
  | 'item:assign'
  | 'item:change_priority'
  | 'item:approve';

const memberPermissions: Permission[] = [
  'team:view',
  'item:view',
  'item:create',
  'item:comment',
  'item:claim',
  'item:edit_own',
];

const leadPermissions: Permission[] = [...memberPermissions, 'item:assign', 'item:change_priority', 'item:approve'];

const adminPermissions: Permission[] = [...leadPermissions, 'team:manage_members'];

const grants: Record<Role, ReadonlySet<Permission>> = {
  member: new Set(memberPermissions),
  lead: new Set(leadPermissions),
  admin: new Set(adminPermissions),
};

export function roleCan(role: Role, permission: Permission): boolean {
  return grants[role].has(permission);
}
