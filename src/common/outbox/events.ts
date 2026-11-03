export type DomainEvent =
  | { type: "user.registered"; userId: string; email: string }
  | { type: "user.became_creator"; userId: string }
  | { type: "media.ready"; assetId: string; ownerId: string; purpose: string }
  | { type: "media.failed"; assetId: string; ownerId: string; reason: string }
  | { type: "org.member_invited"; orgId: string; email: string; inviteId: string }
  | { type: "role.granted"; userId: string; roleKey: string; grantedBy: string }
  | { type: "rbac.permissions_changed"; userIds: string[] };

export type DomainEventType = DomainEvent["type"];
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;
