import { CoreError } from './errors';

export const SCOPES = [
  'audits:read',
  'audits:start:quick',
  'audits:start:full',
  'audits:pdf',
  'audits:cancel',
  'audits:publish',
  'prospects:read',
  'prospects:write',
] as const;
export type Scope = (typeof SCOPES)[number];

/** Who is calling (§4 "Access"). Every core function takes one and checks it itself. */
export type Principal =
  | {
      kind: 'internal';
      label: string;
      /** The logged-in person; absent for scripts and the shared password. */ adminId?: string;
    }
  | {
      kind: 'client';
      clientId: string;
      name: string;
      scopes: readonly Scope[];
      /** A personal key's owner. */ adminId?: string;
    }
  | { kind: 'report'; auditId: string };

export const internalPrincipal = (label = 'internal'): Principal => ({ kind: 'internal', label });

export function principalLabel(p: Principal): string {
  return p.kind === 'internal' ? p.label : p.kind === 'client' ? `client:${p.name}` : `report:${p.auditId}`;
}

export function assertPrincipal(p: Principal | null | undefined): asserts p is Principal {
  if (!p || typeof p !== 'object' || !('kind' in p)) throw new CoreError('unauthorized', 'no principal');
}

export function hasScope(p: Principal, scope: Scope): boolean {
  if (p.kind === 'internal') return true;
  if (p.kind === 'client') return p.scopes.includes(scope);
  return false;
}

/** Throws unless the principal is internal or a client holding `scope`. */
export function requireScope(p: Principal | null | undefined, scope: Scope): void {
  assertPrincipal(p);
  if (!hasScope(p, scope)) throw new CoreError('forbidden', `missing scope ${scope}`);
}

export function requireInternal(p: Principal | null | undefined): void {
  assertPrincipal(p);
  if (p.kind !== 'internal') throw new CoreError('forbidden', 'internal only');
}

export function parseScopes(raw: string): Scope[] {
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new Error(`unknown scopes: ${bad.join(', ')} (known: ${SCOPES.join(', ')})`);
  return list as Scope[];
}
