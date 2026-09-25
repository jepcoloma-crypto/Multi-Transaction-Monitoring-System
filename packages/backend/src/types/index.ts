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
