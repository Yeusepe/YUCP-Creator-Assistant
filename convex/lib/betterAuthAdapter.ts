export interface BetterAuthPageResult<T> {
  page: T[];
}

export interface BetterAuthEqualityClause {
  field: string;
  value: string;
}

export interface BetterAuthWhereClause extends BetterAuthEqualityClause {
  operator: 'eq';
  connector?: 'AND';
}

export function getBetterAuthPage<T>(result: BetterAuthPageResult<T> | null | undefined): T[] {
  return result?.page ?? [];
}

export function buildBetterAuthEqualityWhere(
  clauses: BetterAuthEqualityClause[]
): BetterAuthWhereClause[] {
  return clauses.map((clause, index) => ({
    field: clause.field,
    operator: 'eq' as const,
    value: clause.value,
    ...(index > 0 ? { connector: 'AND' as const } : {}),
  }));
}

export function buildBetterAuthUserLookupWhere(authUserId: string) {
  return buildBetterAuthEqualityWhere([{ field: 'id', value: authUserId }]);
}

export function buildBetterAuthIdLookupWhere(id: string) {
  return buildBetterAuthEqualityWhere([{ field: '_id', value: id }]);
}

export function buildBetterAuthUserProviderLookupWhere(authUserId: string, providerId: string) {
  return buildBetterAuthEqualityWhere([
    { field: 'userId', value: authUserId },
    { field: 'providerId', value: providerId },
  ]);
}

export function buildOAuthConsentLookupWhere(authUserId: string, consentId: string) {
  return buildBetterAuthEqualityWhere([
    { field: 'userId', value: authUserId },
    { field: '_id', value: consentId },
  ]);
}
