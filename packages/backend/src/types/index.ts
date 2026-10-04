export interface AppError extends Error {
  statusCode: number;
  isOperational: boolean;
}

export interface JwtPayload {
  userId: string;
  email: string;
  username: string;
  roles: string[];
  permissions?: string[];
  /**
   * Branches this user may see. Deliberately not a JWT claim: branch is a
   * security boundary, and a claim would go stale the moment an administrator
   * moved someone. `authenticate` refreshes it from the database on every
   * request. Empty means "no branch", never "every branch".
   */
  branchIds?: string[];
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
